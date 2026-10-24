import type { CallBudget } from '../policy/budget.ts';
import { kanazawaPlaces, parisPlaces } from '@tkb/fixtures';
import type { PlaceInfo } from '@tkb/contracts';
import { allowedImageUrl, normalizeLicense, plainText } from './content.ts';
import type { GuideRequest, GuideResult, GuideSource } from './wikipedia.ts';

const FIXTURE_PLACES: readonly PlaceInfo[] = [...kanazawaPlaces, ...parisPlaces];

/**
 * PROVIDER_MODE=fixture: guides from the B04 places' own descriptions (labelled fixture). A photo is kept only with an
 * accepted licence and an allowed URL, like the live source; no description means not_found. No call, no budget.
 */
export class FixtureGuideSource implements GuideSource {
  constructor(private readonly places: readonly PlaceInfo[] = FIXTURE_PLACES) {}

  async guide(request: GuideRequest, budget: CallBudget): Promise<GuideResult> {
    void budget;
    const place = this.places.find(p => p.placeId === request.place.placeId);
    const description = plainText(place?.description);
    if (!place || !description) return { item: null, reason: 'not_found', photoRejected: null };
    const license = normalizeLicense(place.photo?.license);
    const url = allowedImageUrl(place.photo?.url);
    const photo = place.photo && license && url ? { ...place.photo, url, license } : null;
    return {
      item: { number: request.number, placeId: place.placeId, name: place.name, kind: 'spot', location: place.location, description, photo, provenance: place.provenance },
      reason: null,
      photoRejected: photo ? null : place.photo ? 'license_not_allowed' : 'no_image',
    };
  }
}
