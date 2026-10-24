import type { PlaceInfo } from '@tkb/contracts';
import { kanazawaPlaces, parisPlaces } from '@tkb/fixtures';
import type { CallBudget } from '../policy/budget.ts';
import { kindFromTypes, validateNearbySearch, validateTextSearch, type NearbySearchRequest, type PlacesProvider, type PlacesResult, type TextSearchRequest } from './google.ts';

const FIXTURE_PLACES: readonly PlaceInfo[] = [...kanazawaPlaces, ...parisPlaces];

function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const result = (hits: PlaceInfo[]): PlacesResult => ({ places: structuredClone(hits), reason: hits.length === 0 ? 'no_results' : null, dropped: 0 });

/**
 * PROVIDER_MODE=fixture: searches the B04 fixture places (labelled fixture) by name, area and type, or by distance
 * for nearby alternatives. Input is validated like the Google provider. No provider call and no budget charge; an
 * empty result is `no_results`, nothing is made up.
 */
export class FixturePlacesProvider implements PlacesProvider {
  constructor(private readonly places: readonly PlaceInfo[] = FIXTURE_PLACES) {}

  async searchText(request: TextSearchRequest, budget: CallBudget): Promise<PlacesResult> {
    void budget;
    const q = validateTextSearch(request).toLowerCase();
    const a = request.area;
    const inArea = (p: PlaceInfo) => !a || (p.location !== null && p.location.lat >= a.south && p.location.lat <= a.north && p.location.lng >= a.west && p.location.lng <= a.east);
    return result(this.places.filter(p => p.name.toLowerCase().includes(q) && inArea(p)).slice(0, request.maxResults));
  }

  async searchNearby(request: NearbySearchRequest, budget: CallBudget): Promise<PlacesResult> {
    void budget;
    validateNearbySearch(request);
    const center = request.around.location;
    if (!center) return { places: [], reason: 'missing_location', dropped: 0 };
    const kinds = new Set((request.includedTypes ?? []).map(t => kindFromTypes(t)));
    return result(
      this.places
        .filter(p => p.placeId !== request.around.placeId && p.location && distanceM(center, p.location) <= request.radiusMeters)
        .filter(p => kinds.size === 0 || kinds.has(p.kind))
        .sort((x, y) => distanceM(center, x.location!) - distanceM(center, y.location!))
        .slice(0, request.maxResults),
    );
  }
}
