/**
 * Location choice for a replan (A06, R12). Coordinates are requested only after the user presses the explicit
 * consent button, live only inside the returned request object, and are never put in component state,
 * browser storage or the UI. Denied, errored, unsupported or skipped all become `unavailable`.
 */
import { ReplanRequest, type ReplanLocation } from '@tkb/contracts';

export interface GeoLike {
  getCurrentPosition(
    ok: (p: { coords: { latitude: number; longitude: number } }) => void,
    fail: (e: { code: number }) => void,
    options?: { timeout?: number; maximumAge?: number; enableHighAccuracy?: boolean },
  ): void;
}

const PERMISSION_DENIED = 1;

export const SKIPPED: ReplanLocation = { kind: 'unavailable', reason: 'skipped' };

/** Asks the browser for a position (the browser shows its own permission prompt). Never rejects. */
export function requestLocation(geo: GeoLike | undefined | null): Promise<ReplanLocation> {
  if (!geo) return Promise.resolve({ kind: 'unavailable', reason: 'error' });
  return new Promise(resolve => {
    try {
      geo.getCurrentPosition(
        p => {
          const point = { lat: p.coords.latitude, lng: p.coords.longitude };
          resolve(Number.isFinite(point.lat) && Number.isFinite(point.lng) ? { kind: 'coords', point } : { kind: 'unavailable', reason: 'error' });
        },
        e => resolve({ kind: 'unavailable', reason: e.code === PERMISSION_DENIED ? 'denied' : 'error' }),
        { timeout: 10_000, maximumAge: 0, enableHighAccuracy: false },
      );
    } catch {
      resolve({ kind: 'unavailable', reason: 'error' });
    }
  });
}

export interface ReplanInput {
  expectedRevision: number;
  location: ReplanLocation;
  completed: ReadonlySet<string>;
  pinned: ReadonlySet<string>;
  missed: ReadonlySet<string>;
}

/** Strictly parsed body. Throws only on a programming error (the inputs come from validated trip data). */
export function buildReplanRequest(i: ReplanInput): ReplanRequest {
  return ReplanRequest.parse({
    expectedRevision: i.expectedRevision,
    location: i.location,
    completedActivityIds: [...i.completed],
    missedActivityIds: [...i.missed],
    fixedActivityIds: [...i.pinned],
    operations: [],
    maxCandidates: 2,
  });
}
