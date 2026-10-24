import type { DataStatus, LatLng, Provenance } from '@tkb/contracts';
import type { Rect } from '../policy/area.ts';

/** K19 amenity kinds. Designated emergency evacuation sites and designated shelters are different legal categories. */
export type AmenityKind = 'toilet' | 'evacuation_site' | 'evacuation_shelter';
export const AMENITY_KINDS: readonly AmenityKind[] = ['toilet', 'evacuation_site', 'evacuation_shelter'];

/** Hazard types of the Japanese designated evacuation site/shelter data (GSI). */
export const HAZARD_TYPES = ['flood', 'landslide', 'storm_surge', 'earthquake', 'tsunami', 'large_fire', 'inland_flooding', 'volcano'] as const;
export type HazardType = (typeof HAZARD_TYPES)[number];
/** true = designated for it, false = stated as not designated, null = not stated (unknown; never read as false). */
export type HazardSupport = Record<HazardType, boolean | null>;

export const OPENING_STATUS_WARNING = '開設状況は自治体の発表を確認してください';

export interface AmenityItem {
  id: string;
  kind: AmenityKind;
  name: string;
  location: LatLng;
  /** Evacuation site/shelter only: designation by hazard type. Absent for toilets. */
  hazards?: HazardSupport;
  /** Toilets only: wheelchair accessible. null = unknown. */
  accessible?: boolean | null;
  /** Toilets only: opening hours text; null = unknown (never invented). */
  openingHours?: string | null;
  /** Always null: designation is not current opening. Never claim a facility is open now. */
  openNow: null;
  warning: string;
  provenance: Provenance;
}

export interface AmenityRequest {
  bbox: Rect;
  kinds?: readonly AmenityKind[];
  /** Only items designated for this hazard (hazard flag true). */
  hazard?: HazardType;
}

export interface AmenityResult {
  items: AmenityItem[];
  /** fixture/verified with items === [] is a real empty set; unavailable/unsupported_region never mean empty. */
  dataStatus: DataStatus;
  reason: string | null;
  fetchedAt: string | null;
  /** Supported region description, so callers can tell where data exists. */
  supportedRegion: string;
}

export interface AmenitiesProvider {
  search(request: AmenityRequest): Promise<AmenityResult>;
}

/** Intended official source for Japan. Live fetching is not implemented (D08). */
export interface AmenitySourceDescriptor {
  id: string;
  name: string;
  region: string;
  attribution: string;
  url: string;
  liveImplemented: boolean;
}
