/**
 * U07 pure logic (R23, R24, K19): amenities loading with distinct states, search area choice, spot details.
 * Coordinates from the device are used only to build one request bbox and are never stored (no state, no
 * browser storage); the fallback area comes from the trip's current-day places.
 */
import { z } from 'zod';
import { AmenityKind as AmenityKindSchema, ApiError, DataStatus, LatLng, Provenance, UtcInstant, type PlaceInfo, type Trip, type TripDay } from '@tkb/contracts';
import { requestLocation, type GeoLike } from '../travel/geo.ts';
import { mapPoints, type MapPoint } from '../itinerary/model.ts';

export type AmenityKind = z.infer<typeof AmenityKindSchema>;
export const SHELTER_WARNING = '開設状況は自治体の発表を確認してください';
export const FICTION_LABEL = '【架空】';
export const NO_DESCRIPTION = '解説なし';
export const UNSUPPORTED_TEXT = 'この地域は未対応です';
export const EMPTY_TEXT = '近くに該当なし';
export const LOCATION_CONSENT_TEXT =
  '「現在地を使う」を押すと、ブラウザが位置情報の許可を求めます。許可した場合のみ、近くのトイレ・避難場所の検索に一度だけ使います。' +
  '座標は保存せず、画面にも表示しません。拒否・取得失敗の場合は、旅程の今日の予定地点の周辺で探します。';

export const AMENITY_KIND_LABEL: Record<AmenityKind, string> = {
  toilet: 'トイレ',
  evacuation_site: '指定緊急避難場所',
  evacuation_shelter: '指定避難所',
};
export const HAZARD_LABEL: Record<string, string> = {
  flood: '洪水', landslide: '土砂災害', storm_surge: '高潮', earthquake: '地震', tsunami: '津波',
  large_fire: '大規模火災', inland_flooding: '内水氾濫', volcano: '火山',
};

/** Same shape as the server response of GET /api/v1/amenities (apps/server/src/guides). */
export const AmenityItem = z.object({
  id: z.string(),
  kind: AmenityKindSchema,
  name: z.string(),
  location: LatLng,
  hazards: z.record(z.string(), z.boolean().nullable()).optional(),
  accessible: z.boolean().nullable().optional(),
  openingHours: z.string().nullable().optional(),
  openNow: z.null(),
  warning: z.string(),
  provenance: Provenance,
});
export type AmenityItem = z.infer<typeof AmenityItem>;
export const AmenityResponse = z.object({
  items: z.array(AmenityItem),
  dataStatus: DataStatus,
  reason: z.string().nullable(),
  fetchedAt: UtcInstant.nullable(),
  supportedRegion: z.string(),
});
export type AmenityResponse = z.infer<typeof AmenityResponse>;

export interface Bbox { south: number; west: number; north: number; east: number }

export type AmenitiesLoad =
  | { state: 'ok'; items: AmenityItem[]; dataStatus: DataStatus; fetchedAt: string | null }
  | { state: 'empty'; reason: string | null; dataStatus: DataStatus }
  | { state: 'unsupported'; reason: string | null; supportedRegion: string }
  | { state: 'error'; message: string; code?: string; requestId?: string };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

export const amenitiesUrl = (b: Bbox, kinds: readonly AmenityKind[] = []): string =>
  `/api/v1/amenities?bbox=${[b.south, b.west, b.north, b.east].map(r4).join(',')}${kinds.length > 0 ? `&kind=${kinds.join(',')}` : ''}`;

/** Square-ish bbox around a point. radiusKm <= 2.5 keeps it within the server's 5 km side limit. */
export function bboxAround(p: { lat: number; lng: number }, radiusKm = 2): Bbox {
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.max(Math.cos((p.lat * Math.PI) / 180), 0.1));
  return { south: r4(p.lat - dLat), west: r4(p.lng - dLng), north: r4(p.lat + dLat), east: r4(p.lng + dLng) };
}

/** Classifies a validated response. An empty set is only "empty" when the data source covers the area. */
export function classifyAmenities(r: AmenityResponse): AmenitiesLoad {
  if (r.dataStatus === 'unsupported_region') return { state: 'unsupported', reason: r.reason, supportedRegion: r.supportedRegion };
  if (r.dataStatus === 'unavailable') return { state: 'error', message: r.reason ?? '公式データを取得できません。' };
  if (r.items.length === 0) return { state: 'empty', reason: r.reason, dataStatus: r.dataStatus };
  return { state: 'ok', items: r.items, dataStatus: r.dataStatus, fetchedAt: r.fetchedAt };
}

/** Network failure, HTTP error and a schema mismatch are all `error`; they are never shown as 近くに該当なし. */
export async function fetchAmenities(bbox: Bbox, options: { kinds?: readonly AmenityKind[]; fetch?: FetchLike; signal?: AbortSignal } = {}): Promise<AmenitiesLoad> {
  const doFetch: FetchLike = options.fetch ?? ((i, init) => fetch(i, init));
  try {
    const res = await doFetch(amenitiesUrl(bbox, options.kinds), {
      credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const err = ApiError.safeParse(body);
      if (err.success) return { state: 'error', message: err.data.message, code: err.data.code, requestId: err.data.requestId };
      return { state: 'error', message: `HTTP ${res.status}` };
    }
    const parsed = AmenityResponse.safeParse(body);
    if (!parsed.success) return { state: 'error', message: '応答が契約(K19)と一致しません' };
    return classifyAmenities(parsed.data);
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw e;
    return { state: 'error', message: e instanceof Error ? e.message : '通信に失敗しました' };
  }
}

/** Mock mode: in-memory fixture, no network. Mirrors the server states for the three fixture areas. */
export function mockAmenities(bbox: Bbox, scenario: 'ok' | 'empty' | 'unsupported' | 'error' = 'ok', now = '2026-10-24T00:00:00Z'): AmenitiesLoad {
  if (scenario === 'error') return { state: 'error', message: 'モック: 取得失敗' };
  if (scenario === 'unsupported') return { state: 'unsupported', reason: 'モック: 未対応地域', supportedRegion: MOCK_REGION };
  if (scenario === 'empty') return { state: 'empty', reason: null, dataStatus: 'fixture' };
  const c = { lat: (bbox.south + bbox.north) / 2, lng: (bbox.west + bbox.east) / 2 };
  const provenance: AmenityItem['provenance'] = {
    source: 'fixture:mock-amenities', fetchedAt: now, attribution: '架空のモックデータ', maySendToModel: false, mayStore: true, mayExport: false, retainUntil: null,
  };
  const base = { openNow: null, warning: SHELTER_WARNING, provenance } as const;
  return {
    state: 'ok', dataStatus: 'fixture', fetchedAt: now,
    items: [
      { ...base, id: 'mock-t', kind: 'toilet', name: '【架空】モック公衆トイレ', location: { lat: c.lat + 0.001, lng: c.lng }, accessible: null, openingHours: null },
      { ...base, id: 'mock-s', kind: 'evacuation_site', name: '【架空】モック避難場所', location: { lat: c.lat, lng: c.lng + 0.001 }, hazards: { earthquake: true, flood: false, tsunami: null } },
      { ...base, id: 'mock-h', kind: 'evacuation_shelter', name: '【架空】モック避難所', location: { lat: c.lat - 0.001, lng: c.lng }, hazards: { earthquake: true } },
    ],
  };
}
const MOCK_REGION = 'モック（架空）';

/** Current-day index: the day whose date is `today`, else 0 (before/after the trip or unknown). */
export function currentDayIndex(trip: Trip, today: string): number {
  const i = trip.days.findIndex(d => d.date === today);
  return i >= 0 ? i : 0;
}

/** Fallback search area: around the centroid of the day's located places. null when none has a location. */
export function fallbackBbox(day: TripDay | undefined, places: PlaceInfo[]): Bbox | null {
  if (!day) return null;
  const pts = mapPoints(day, places);
  if (pts.length === 0) return null;
  const lat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
  const lng = pts.reduce((s, p) => s + p.lng, 0) / pts.length;
  return bboxAround({ lat, lng });
}

export type AreaChoice = { source: 'device' | 'trip'; bbox: Bbox; deviceFailure: 'denied' | 'error' | null } | { source: 'none'; deviceFailure: 'denied' | 'error' | null };

/**
 * Chooses the search area. `useDevice` is true only after the user pressed the consent button. The device
 * position is turned into a bbox right here and dropped; denied / error falls back to the trip's places.
 */
export async function chooseArea(opts: { useDevice: boolean; geo: GeoLike | undefined | null; day: TripDay | undefined; places: PlaceInfo[] }): Promise<AreaChoice> {
  let deviceFailure: 'denied' | 'error' | null = null;
  if (opts.useDevice) {
    const loc = await requestLocation(opts.geo);
    if (loc.kind === 'coords') return { source: 'device', bbox: bboxAround(loc.point), deviceFailure: null };
    deviceFailure = loc.kind === 'unavailable' && loc.reason === 'denied' ? 'denied' : 'error';
  }
  const bbox = fallbackBbox(opts.day, opts.places);
  return bbox ? { source: 'trip', bbox, deviceFailure } : { source: 'none', deviceFailure };
}

export interface SpotDetail {
  number: number;
  placeId: string;
  name: string;
  description: string;
  hasDescription: boolean;
  photo: { url: string; attribution: string; license: string | null } | null;
  source: string;
  dataStatus: DataStatus;
  fictional: boolean;
}

/** Detail of a numbered spot from Trip.places (K06). No description -> 「解説なし」, never generated. */
export function spotDetail(point: MapPoint, places: PlaceInfo[]): SpotDetail {
  const p = places.find(x => x.placeId === point.placeId);
  const description = p?.description?.trim() ? p.description : null;
  return {
    number: point.number, placeId: point.placeId, name: point.name,
    description: description ?? NO_DESCRIPTION, hasDescription: description !== null,
    photo: p?.photo ?? null,
    source: p?.provenance.source ?? '不明',
    dataStatus: p?.dataStatus ?? 'unknown',
    fictional: p?.dataStatus === 'fixture',
  };
}

export const isFictional = (i: AmenityItem): boolean => i.provenance.source.startsWith('fixture');
/** Name as displayed: fixture data always carries the 【架空】 label. */
export const displayName = (i: AmenityItem): string => (isFictional(i) && !i.name.startsWith(FICTION_LABEL) ? `${FICTION_LABEL}${i.name}` : i.name);
/** Shelters/sites always carry the opening-status warning, even if the provider omitted it. */
export const warningFor = (i: AmenityItem): string | null =>
  i.kind === 'toilet' ? null : i.warning.includes(SHELTER_WARNING) ? i.warning : SHELTER_WARNING;

export function hazardText(i: AmenityItem): string {
  if (!i.hazards) return '';
  const on = Object.entries(i.hazards).filter(([, v]) => v === true).map(([k]) => HAZARD_LABEL[k] ?? k);
  return on.length > 0 ? `指定: ${on.join('・')}` : '指定する災害種別: 記載なし';
}

export function filterKinds(items: AmenityItem[], enabled: ReadonlySet<AmenityKind>): AmenityItem[] {
  return items.filter(i => enabled.has(i.kind));
}
