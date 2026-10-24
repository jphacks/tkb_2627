import type { PlaceInfo } from '@tkb/contracts';
import { kanazawaPlaces, parisPlaces } from '@tkb/fixtures';
import type { CallBudget } from '../policy/budget.ts';
import type { NearbySearchRequest, PlacesResult, TextSearchRequest } from './google.ts';

const FIXTURE_PLACES: readonly PlaceInfo[] = [...kanazawaPlaces, ...parisPlaces];

function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * PROVIDER_MODE=fixture: searches the B04 fixture places (labelled fixture) by name, or by distance for nearby
 * alternatives. No provider call and no budget charge; an empty result is `no_results`, nothing is made up.
 */
export class FixturePlacesProvider {
  constructor(private readonly places: readonly PlaceInfo[] = FIXTURE_PLACES) {}

  async searchText(request: TextSearchRequest, budget: CallBudget): Promise<PlacesResult> {
    void budget;
    const q = request.query.trim().toLowerCase();
    const hits = this.places.filter(p => q !== '' && p.name.toLowerCase().includes(q)).slice(0, request.maxResults);
    return { places: structuredClone(hits), reason: hits.length === 0 ? 'no_results' : null, dropped: 0 };
  }

  async searchNearby(request: NearbySearchRequest, budget: CallBudget): Promise<PlacesResult> {
    void budget;
    const center = request.around.location;
    if (!center) return { places: [], reason: 'missing_location', dropped: 0 };
    const hits = this.places
      .filter(p => p.placeId !== request.around.placeId && p.location && distanceM(center, p.location) <= request.radiusMeters)
      .sort((a, b) => distanceM(center, a.location!) - distanceM(center, b.location!))
      .slice(0, request.maxResults);
    return { places: structuredClone(hits), reason: hits.length === 0 ? 'no_results' : null, dropped: 0 };
  }
}
