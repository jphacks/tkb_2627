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

const isGoogle = (source: string) => source.startsWith('google_');

/**
 * Provider content that may not be kept must not arrive at all: a place or leg labelled as Google data may carry
 * only ids (the client's labels are not trusted to mean "already stripped").
 */
export function carriesRestrictedProviderContent(
  places: readonly Pick<PlaceInfo, 'provenance' | 'location' | 'openingHours' | 'description' | 'photo'>[],
  candidates: readonly PlanCandidate[],
): boolean {
  if (places.some(p => isGoogle(p.provenance.source) && (p.location !== null || p.openingHours !== null || p.description !== null || p.photo !== null))) return true;
  return candidates.some(c =>
    c.days.some(d =>
      d.items.some(
        it =>
          it.type === 'leg' &&
          it.provenance !== null &&
          isGoogle(it.provenance.source) &&
          (it.durationSeconds !== null || it.fare !== null || it.lineName !== null || it.platform !== null || it.transfers !== null),
      ),
    ),
  );
}
