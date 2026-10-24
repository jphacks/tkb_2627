import { PolicyError } from './budget.ts';

/** Search rectangle in degrees. Rectangles crossing the antimeridian are not supported. */
export interface Rect {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface AreaLimits {
  /** Longest allowed side in km (Places locationBias allows a 50 km radius; a trip area is far smaller). */
  maxSideKm: number;
  /** Most places one request may ask for (K05 maxPlaces is at most 30). */
  maxItems: number;
  /** Results per provider page (Places Text Search pageSize is at most 20). */
  pageSize: number;
}

export const DEFAULT_AREA_LIMITS: AreaLimits = { maxSideKm: 30, maxItems: 30, pageSize: 20 };

export interface AreaCheck {
  widthKm: number;
  heightKm: number;
  items: number;
  /** Provider pages needed for `items`; each page is one billed call. */
  pages: number;
}

const EARTH_KM = 6371.0088;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in km. */
function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

const invalid = (message: string) => new PolicyError('VALIDATION_FAILED', message, false);

/**
 * Checks a search rectangle and the number of places asked for before any provider call (K19: 422 for an area that
 * is too large). Throws VALIDATION_FAILED; returns the sizes and the number of billed pages otherwise.
 */
export function checkArea(rect: Rect, items: number, limits: AreaLimits = DEFAULT_AREA_LIMITS): AreaCheck {
  const { south, west, north, east } = rect;
  if (![south, west, north, east].every(Number.isFinite)) throw invalid('範囲の座標が数値ではありません。');
  if (south < -90 || north > 90 || west < -180 || east > 180) throw invalid('範囲の座標が有効な緯度経度ではありません。');
  if (south >= north) throw invalid('範囲の南端が北端より北にあります。');
  if (west >= east) throw invalid('範囲の西端が東端より東にあります（日付変更線をまたぐ範囲は未対応です）。');
  if (!Number.isInteger(items) || items < 1 || items > limits.maxItems) {
    throw invalid(`取得件数は1〜${limits.maxItems}件で指定してください。`);
  }
  // Width is measured along the parallel nearest the equator, where the rectangle is widest.
  const widestLat = south <= 0 && north >= 0 ? 0 : Math.min(Math.abs(south), Math.abs(north)) * Math.sign(south);
  const widthKm = distanceKm(widestLat, west, widestLat, east);
  const heightKm = distanceKm(south, west, north, west);
  if (widthKm > limits.maxSideKm || heightKm > limits.maxSideKm) {
    throw invalid(`範囲が広すぎます（一辺${limits.maxSideKm}km まで）。`);
  }
  return { widthKm, heightKm, items, pages: Math.ceil(items / limits.pageSize) };
}
