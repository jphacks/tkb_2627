import type { Provenance } from '@tkb/contracts';
import { checkArea, type AreaLimits, type Rect } from '../policy/area.ts';
import { PolicyError } from '../policy/budget.ts';
import { JAPAN_BOUNDS } from './source.ts';
import { AMENITY_KINDS, HAZARD_TYPES, OPENING_STATUS_WARNING, type AmenitiesProvider, type AmenityItem, type AmenityRequest, type AmenityResult, type HazardSupport, type HazardType } from './types.ts';

/** Amenity searches are small: one side up to 5 km. */
export const AMENITY_AREA_LIMITS: AreaLimits = { maxSideKm: 5, maxItems: 1, pageSize: 1 };
/** Region of the hand-made fixture. */
export const FIXTURE_COVERAGE: Rect = { south: 36.5, west: 136.6, north: 36.62, east: 136.72 };
export const FIXTURE_REGION = '金沢周辺（架空のfixtureデータのみ）';

const FETCHED_AT = '2026-10-24T00:00:00.000Z';
const provenance: Provenance = {
  source: 'fixture:amenities',
  fetchedAt: FETCHED_AT,
  attribution: '架空のfixtureデータ（公式データではありません）',
  maySendToModel: false,
  mayStore: true,
  mayExport: false,
  retainUntil: null,
};

const hz = (on: HazardType[], off: HazardType[] = []): HazardSupport =>
  Object.fromEntries(HAZARD_TYPES.map(h => [h, on.includes(h) ? true : off.includes(h) ? false : null])) as HazardSupport;

const base = { openNow: null, warning: OPENING_STATUS_WARNING, provenance } as const;
/** 架空 / fictional: hand-made, not copied from any official data. Names and coordinates are invented. */
export const FIXTURE_AMENITIES: readonly AmenityItem[] = [
  { ...base, id: 'fx-site-1', kind: 'evacuation_site', name: '【架空】仮想中央公園 避難場所', location: { lat: 36.56, lng: 136.65 }, hazards: hz(['earthquake', 'large_fire'], ['flood']) },
  { ...base, id: 'fx-site-2', kind: 'evacuation_site', name: '【架空】仮想高台広場 避難場所', location: { lat: 36.57, lng: 136.66 }, hazards: hz(['tsunami', 'storm_surge']) },
  { ...base, id: 'fx-shelter-1', kind: 'evacuation_shelter', name: '【架空】仮想小学校 避難所', location: { lat: 36.565, lng: 136.655 }, hazards: hz(['earthquake', 'flood'], ['landslide']) },
  { ...base, id: 'fx-toilet-1', kind: 'toilet', name: '【架空】仮想駅前公衆トイレ', location: { lat: 36.578, lng: 136.648 }, accessible: true, openingHours: null },
  { ...base, id: 'fx-toilet-2', kind: 'toilet', name: '【架空】仮想公園トイレ', location: { lat: 36.561, lng: 136.652 }, accessible: null, openingHours: null },
];

const inside = (r: Rect, p: { lat: number; lng: number }) => p.lat >= r.south && p.lat <= r.north && p.lng >= r.west && p.lng <= r.east;
const overlaps = (a: Rect, b: Rect) => a.south <= b.north && a.north >= b.south && a.west <= b.east && a.east >= b.west;

function validate(request: AmenityRequest): void {
  checkArea(request.bbox, 1, AMENITY_AREA_LIMITS);
  for (const k of request.kinds ?? []) {
    if (!AMENITY_KINDS.includes(k)) throw new PolicyError('VALIDATION_FAILED', `未知の種類です: ${String(k)}`, false);
  }
  if (request.hazard !== undefined && !HAZARD_TYPES.includes(request.hazard)) throw new PolicyError('VALIDATION_FAILED', `未知の災害種別です: ${String(request.hazard)}`, false);
}

const unsupported = (reason: string): AmenityResult => ({ items: [], dataStatus: 'unsupported_region', reason, fetchedAt: null, supportedRegion: FIXTURE_REGION });

/**
 * mode=fixture: serves the hand-made Kanazawa dataset. Too-large range -> VALIDATION_FAILED (422). Outside Japan or
 * outside the fixture coverage -> explicit unsupported_region (never an empty list). A covered range with no match
 * -> items [] with dataStatus fixture (a real empty set).
 */
export class FixtureAmenitiesProvider implements AmenitiesProvider {
  constructor(private readonly items: readonly AmenityItem[] = FIXTURE_AMENITIES) {}

  async search(request: AmenityRequest): Promise<AmenityResult> {
    validate(request);
    const { bbox } = request;
    if (!overlaps(bbox, JAPAN_BOUNDS)) return unsupported('国外は未対応地域です（指定緊急避難場所・指定避難所データは日本国内のみ）。');
    if (!overlaps(bbox, FIXTURE_COVERAGE)) return unsupported('この地域のデータはまだありません（未対応地域）。');
    const kinds = request.kinds && request.kinds.length > 0 ? new Set(request.kinds) : null;
    const hits = this.items.filter(i => inside(bbox, i.location) && (!kinds || kinds.has(i.kind)) && (!request.hazard || i.hazards?.[request.hazard] === true));
    return { items: structuredClone(hits), dataStatus: 'fixture', reason: null, fetchedAt: FETCHED_AT, supportedRegion: FIXTURE_REGION };
  }
}
