import type { PlaceInfo, TimeZone } from '@tkb/contracts';
import { checkArea, type Rect } from '../policy/area.ts';
import { PolicyError, providerError, type CallBudget } from '../policy/budget.ts';
import { SKU } from '../policy/limits.ts';
import { provenanceFor } from '../policy/retention.ts';
import { openingHoursText, type GOpeningHours } from './hours.ts';

const TEXT_SEARCH = 'https://places.googleapis.com/v1/places:searchText';
const NEARBY_SEARCH = 'https://places.googleapis.com/v1/places:searchNearby';

/** Pro fields only (docs/provider-probe.md); regularOpeningHours moves the call to the Enterprise SKU. */
const PRO_FIELDS = ['places.id', 'places.displayName', 'places.formattedAddress', 'places.location', 'places.types', 'places.primaryType', 'places.attributions'];
const HOURS_FIELD = 'places.regularOpeningHours';
/** Places returns at most 20 results per request; more would need paging (more billed calls). */
export const MAX_PLACES_PER_CALL = 20;
/** Largest nearby radius we allow, in metres: half of the 30 km area side (D02), under the API's 50 km. */
export const MAX_NEARBY_RADIUS_M = 15_000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

interface GPlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  types?: string[];
  primaryType?: string;
  attributions?: { provider?: string; providerUri?: string }[];
  regularOpeningHours?: GOpeningHours;
}

export type PlacesUnknownReason = 'no_results' | 'missing_location' | 'rate_limited' | 'provider_unavailable';

export interface PlacesResult {
  places: PlaceInfo[];
  /**
   * Why there are no places: `no_results` when the provider returned none, or a failure. Empty is not the same as
   * failed (K19). It stays null when results came back but were all dropped (see `dropped`).
   */
  reason: PlacesUnknownReason | null;
  /** Results dropped because they lacked a valid ID or a name. */
  dropped: number;
}

export interface TextSearchRequest {
  query: string;
  /** IANA zone of the trip area; Places does not return one (PlaceInfo.timeZone is required). */
  timeZone: TimeZone;
  /** Optional search rectangle, checked by D02 checkArea before any call. */
  area?: Rect;
  maxResults: number;
  /** Also fetch regular opening hours (Enterprise SKU). */
  withHours?: boolean;
  languageCode?: string;
  regionCode?: string;
}

/** K06 place adapter; Google and fixture implement it. Calls go through the input's CallBudget (D02). */
export interface PlacesProvider {
  searchText(request: TextSearchRequest, budget: CallBudget): Promise<PlacesResult>;
  searchNearby(request: NearbySearchRequest, budget: CallBudget): Promise<PlacesResult>;
}

export interface NearbySearchRequest {
  /** The place to find alternatives around (R10); it is left out of the results. */
  around: PlaceInfo;
  radiusMeters: number;
  /** Places API types, e.g. ['restaurant']; defaults to none (all types). */
  includedTypes?: string[];
  maxResults: number;
  withHours?: boolean;
  languageCode?: string;
}

const KIND_BY_TYPE: [string, PlaceInfo['kind']][] = [
  ['restaurant', 'restaurant'],
  ['cafe', 'restaurant'],
  ['bakery', 'restaurant'],
  ['bar', 'restaurant'],
  ['meal_takeaway', 'restaurant'],
  ['food', 'restaurant'],
  ['lodging', 'lodging'],
  ['train_station', 'station'],
  ['subway_station', 'station'],
  ['bus_station', 'station'],
  ['transit_station', 'station'],
  ['tourist_attraction', 'spot'],
  ['museum', 'spot'],
  ['park', 'spot'],
  ['art_gallery', 'spot'],
  ['place_of_worship', 'spot'],
  ['historical_landmark', 'spot'],
  ['market', 'area'],
  ['shopping_mall', 'area'],
];

/**
 * Our PlaceKind from the provider's types (primary type first); anything unmapped is 'other'. Specific food types
 * such as japanese_restaurant count as restaurants: a live Nearby Search for 'restaurant' (D03) otherwise mapped
 * some results to 'spot' through a later generic type.
 */
export function kindFromTypes(primaryType: string | undefined, types: readonly string[] = []): PlaceInfo['kind'] {
  for (const t of [primaryType, ...types]) {
    if (t === undefined) continue;
    if (t.endsWith('_restaurant')) return 'restaurant';
    const hit = KIND_BY_TYPE.find(([type]) => type === t);
    if (hit) return hit[1];
  }
  return 'other';
}

export interface GooglePlacesOptions {
  apiKey: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * K06 place adapter over Places API (New) Text Search and Nearby Search (D03, R02/R10/R13). Calls go through the
 * input's CallBudget and the shared daily quota (D02). Only returned values are used: description and photo are
 * null (photos are out of scope for now: photo names expire and need separate billed calls), opening hours are null
 * unless asked for and returned. Provenance: google_places (only placeId may be stored; not for the model or export).
 */
export class GooglePlacesProvider implements PlacesProvider {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: GooglePlacesOptions) {
    if (!options.apiKey) throw new Error('GooglePlacesProvider needs an API key');
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** Text Search for a query, optionally restricted to a rectangle (R02). */
  async searchText(request: TextSearchRequest, budget: CallBudget): Promise<PlacesResult> {
    const query = validateTextSearch(request);
    const body = {
      textQuery: query,
      pageSize: request.maxResults,
      languageCode: request.languageCode ?? 'ja',
      ...(request.regionCode ? { regionCode: request.regionCode } : {}),
      ...(request.area
        ? { locationRestriction: { rectangle: { low: { latitude: request.area.south, longitude: request.area.west }, high: { latitude: request.area.north, longitude: request.area.east } } } }
        : {}),
    };
    const sku = request.withHours ? SKU.placesTextSearchEnterprise : SKU.placesTextSearchPro;
    return this.call(TEXT_SEARCH, body, sku, request.withHours === true, request.timeZone, null, budget);
  }

  /** Nearby Search around a place for alternatives (R10); the place itself is excluded. */
  async searchNearby(request: NearbySearchRequest, budget: CallBudget): Promise<PlacesResult> {
    const { around } = request;
    validateNearbySearch(request);
    if (!around.location) return { places: [], reason: 'missing_location', dropped: 0 };
    const body = {
      locationRestriction: { circle: { center: { latitude: around.location.lat, longitude: around.location.lng }, radius: request.radiusMeters } },
      maxResultCount: request.maxResults,
      rankPreference: 'DISTANCE',
      languageCode: request.languageCode ?? 'ja',
      ...(request.includedTypes && request.includedTypes.length > 0 ? { includedTypes: request.includedTypes } : {}),
    };
    const sku = request.withHours ? SKU.placesNearbyEnterprise : SKU.placesNearbyPro;
    return this.call(NEARBY_SEARCH, body, sku, request.withHours === true, around.timeZone, around.placeId, budget);
  }

  private async call(
    url: string,
    body: object,
    sku: string,
    withHours: boolean,
    timeZone: TimeZone,
    excludeId: string | null,
    budget: CallBudget,
  ): Promise<PlacesResult> {
    const fieldMask = (withHours ? [...PRO_FIELDS, HOURS_FIELD] : PRO_FIELDS).join(',');
    let json: { places?: GPlace[] };
    try {
      json = await budget.run(sku, `${url}|${JSON.stringify(body)}`, async signal => {
        let res: Response;
        try {
          res = await this.fetchFn(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': this.options.apiKey, 'X-Goog-FieldMask': fieldMask },
            body: JSON.stringify(body),
            signal,
          });
        } catch (e) {
          if (signal.aborted) throw e;
          throw providerError(null); // never pass the fetch error on: it can echo the key header
        }
        if (!res.ok) throw providerError(res.status);
        const parsed: unknown = await res.json().catch(() => undefined);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new PolicyError('PROVIDER_UNAVAILABLE', 'unreadable provider response', false);
        }
        return parsed as { places?: GPlace[] };
      });
    } catch (e) {
      if (e instanceof PolicyError && e.code === 'PROVIDER_RATE_LIMIT') return { places: [], reason: 'rate_limited', dropped: 0 };
      if (e instanceof PolicyError && e.code === 'PROVIDER_UNAVAILABLE') return { places: [], reason: 'provider_unavailable', dropped: 0 };
      throw e; // CANCELLED, VALIDATION_FAILED and anything unexpected
    }

    const raw = Array.isArray(json.places) ? json.places : [];
    const fetchedAt = this.now();
    const places: PlaceInfo[] = [];
    let dropped = 0;
    for (const p of raw) {
      const info = toPlaceInfo(p, timeZone, withHours, fetchedAt);
      if (!info) dropped += 1;
      else if (info.placeId !== excludeId) places.push(info);
    }
    return { places, reason: places.length === 0 && dropped === 0 ? 'no_results' : null, dropped };
  }
}

const invalid = (message: string) => new PolicyError('VALIDATION_FAILED', message, false);

function checkCount(n: number): void {
  if (!Number.isInteger(n) || n < 1 || n > MAX_PLACES_PER_CALL) throw invalid(`maxResults must be 1-${MAX_PLACES_PER_CALL}`);
}

function checkCodes(languageCode?: string, regionCode?: string): void {
  if (languageCode !== undefined && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(languageCode)) throw invalid('invalid languageCode');
  if (regionCode !== undefined && !/^[A-Z]{2}$/.test(regionCode)) throw invalid('invalid regionCode');
}

/** Shared by the Google and fixture providers: the same input is refused in both modes. Returns the trimmed query. */
export function validateTextSearch(request: TextSearchRequest): string {
  const query = request.query.trim();
  if (!query || query.length > 200) throw invalid('query must be 1-200 characters');
  checkCount(request.maxResults);
  checkCodes(request.languageCode, request.regionCode);
  if (request.area) checkArea(request.area, request.maxResults);
  return query;
}

/** Shared by the Google and fixture providers. A place without coordinates is not an input error (missing_location). */
export function validateNearbySearch(request: NearbySearchRequest): void {
  checkCount(request.maxResults);
  checkCodes(request.languageCode);
  if (!(Number.isFinite(request.radiusMeters) && request.radiusMeters > 0 && request.radiusMeters <= MAX_NEARBY_RADIUS_M)) {
    throw invalid(`radiusMeters must be over 0 and at most ${MAX_NEARBY_RADIUS_M}`);
  }
  const types = request.includedTypes ?? [];
  // A malformed type would come back as a 400 and look like a provider failure.
  if (types.length > 50 || types.some(t => !/^[a-z_]{1,64}$/.test(t))) throw invalid('includedTypes must be up to 50 Places type names');
}

/** One provider place → PlaceInfo, or null when it lacks what the contract requires (ID, name). Bad coordinates become null. */
function toPlaceInfo(p: GPlace, timeZone: TimeZone, withHours: boolean, fetchedAt: number): PlaceInfo | null {
  const name = p.displayName?.text?.trim();
  const lat = p.location?.latitude;
  const lng = p.location?.longitude;
  if (!p.id || !ID.test(p.id) || !name) return null;
  const location =
    typeof lat === 'number' && typeof lng === 'number' && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 ? { lat, lng } : null;
  const provenance = provenanceFor('google_places', fetchedAt);
  // Third-party providers must be credited beyond "Google Maps" (Places API Policies).
  const others = [...new Set((p.attributions ?? []).map(a => a.provider?.trim()).filter((s): s is string => Boolean(s)))];
  return {
    placeId: p.id,
    name,
    kind: kindFromTypes(p.primaryType, p.types),
    location,
    timeZone,
    openingHours: withHours ? openingHoursText(p.regularOpeningHours) : null,
    description: null,
    photo: null,
    dataStatus: 'verified',
    provenance: others.length > 0 ? { ...provenance, attribution: [provenance.attribution, ...others].join(' / ') } : provenance,
  };
}
