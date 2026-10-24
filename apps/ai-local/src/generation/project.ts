import type { Activity, PlaceInfo, Provenance, TravelLeg, TripDay } from '@tkb/contracts';

/** Shown for a place whose content may not be stored; the screen re-fetches it by id when displaying. */
export const PLACEHOLDER_NAME = '（地点情報は表示時に再取得）';
export const LEG_REFETCH_WARNING = '移動情報は表示時に再取得';
export const PLACE_REFETCH_WARNING = '地点情報は表示時に再取得';
export const INSUFFICIENT_PLACE_WARNING = '地点の詳細情報をAIに渡せなかったため、内容を必ず確認してください';

/** Content that its provider does not let us keep (mayStore=false). */
export const restricted = (p: Provenance | null): boolean => p !== null && !p.mayStore;

/**
 * What remains of provider content that may not be stored (M1 on #28, D-2): only the id. The result carries no
 * provider content, so it is marked storable; it still may not go to the model or to exports.
 */
export function projectPlace(p: PlaceInfo): PlaceInfo {
  if (!restricted(p.provenance)) return p;
  return {
    placeId: p.placeId,
    name: PLACEHOLDER_NAME,
    kind: 'other',
    location: null,
    timeZone: p.timeZone,
    openingHours: null,
    description: null,
    photo: null,
    dataStatus: 'unknown',
    provenance: { source: p.provenance.source, fetchedAt: null, attribution: p.provenance.attribution, maySendToModel: false, mayStore: true, mayExport: false, retainUntil: null },
  };
}

/**
 * Live route details (duration, fare, line, platform, transfers) may not be stored (D-1): they become null.
 * Computed schedule times on activities are our own result and stay.
 */
export function projectLeg(l: TravelLeg): TravelLeg {
  if (!restricted(l.provenance)) return l;
  const p = l.provenance!;
  return {
    ...l,
    departure: null,
    arrival: null,
    durationSeconds: null,
    lineName: null,
    platform: null,
    transfers: null,
    fare: null,
    dataStatus: 'unknown',
    provenance: { source: p.source, fetchedAt: null, attribution: p.attribution, maySendToModel: false, mayStore: true, mayExport: false, retainUntil: null },
  };
}

export interface Projected {
  days: TripDay[];
  legsProjected: boolean;
  placesProjected: boolean;
}

export function projectDays(days: readonly TripDay[], placeById: ReadonlyMap<string, PlaceInfo>): Projected {
  let legsProjected = false;
  let placesProjected = false;
  const out = days.map(d => ({
    ...d,
    items: d.items.map(it => {
      if (it.type === 'leg') {
        const p = projectLeg(it);
        if (p !== it) legsProjected = true;
        return p;
      }
      const place = it.placeId === null ? undefined : placeById.get(it.placeId);
      if (!place || !restricted(place.provenance)) return it;
      placesProjected = true;
      const a: Activity = { ...it, title: PLACEHOLDER_NAME, areaName: it.areaName === null ? null : PLACEHOLDER_NAME };
      return a;
    }),
  }));
  return { days: out, legsProjected, placesProjected };
}
