import { GSI_SHELTER_SOURCE } from './source.ts';
import type { AmenitiesProvider, AmenityResult } from './types.ts';

/** mode=live placeholder: the official GSI data is not connected yet. Returns unavailable, never an empty set. */
export class LiveAmenitiesProvider implements AmenitiesProvider {
  async search(): Promise<AmenityResult> {
    return { items: [], dataStatus: 'unavailable', reason: `公式データ未接続（${GSI_SHELTER_SOURCE.name} のliveは未実装）`, fetchedAt: null, supportedRegion: GSI_SHELTER_SOURCE.region };
  }
}
