import type { PlanCandidate, PlaceInfo } from '@tkb/contracts';

/** K07 check: every activity/leg place id is in the batch's own places, so a saved candidate never dangles. */
export function batchReferencesOnlyKnownPlaces(candidates: readonly PlanCandidate[], places: readonly Pick<PlaceInfo, 'placeId'>[]): boolean {
  const known = new Set(places.map(p => p.placeId));
  for (const c of candidates) {
    for (const d of c.days) {
      for (const it of d.items) {
        if (it.type === 'activity') {
          if (it.placeId !== null && !known.has(it.placeId)) return false;
        } else if (!known.has(it.fromPlaceId) || !known.has(it.toPlaceId)) return false;
      }
    }
  }
  return true;
}
