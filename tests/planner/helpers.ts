// 架空フィクスチャ用ビルダー。実在の時刻表・運賃・営業時間ではない。
import type { Activity, Money, PlaceInfo, TravelLeg, TripDay } from '@tkb/contracts';

export const place = (placeId: string, openingHours: string | null = null, timeZone = 'Asia/Tokyo'): PlaceInfo => ({
  placeId,
  name: placeId,
  kind: 'spot',
  location: null,
  timeZone,
  openingHours,
  description: null,
  photo: null,
  dataStatus: 'fixture',
  provenance: { source: 'fixture', fetchedAt: null, attribution: null, maySendToModel: true, mayStore: true, mayExport: true, retainUntil: null },
});

export const act = (
  id: string,
  o: { start?: string | null; end?: string | null; tz?: string; placeId?: string | null; fixed?: boolean; cost?: Money | null; kind?: Activity['kind']; status?: Activity['status'] } = {},
): Activity => ({
  type: 'activity',
  activityId: id,
  kind: o.kind ?? 'visit',
  title: id,
  placeId: o.placeId ?? null,
  areaName: null,
  start: o.start ? { utc: o.start, timeZone: o.tz ?? 'Asia/Tokyo' } : null,
  end: o.end ? { utc: o.end, timeZone: o.tz ?? 'Asia/Tokyo' } : null,
  fixed: o.fixed ?? false,
  status: o.status ?? 'planned',
  cost: o.cost ?? null,
  costStatus: o.cost ? 'fixture' : 'unknown',
  privateNotes: null,
});

export const leg = (
  id: string,
  o: { from?: string; to?: string; dep?: string | null; arr?: string | null; tz?: string; fare?: Money | null; sec?: number | null; mode?: TravelLeg['mode'] } = {},
): TravelLeg => ({
  type: 'leg',
  legId: id,
  mode: o.mode ?? 'transit',
  fromPlaceId: o.from ?? 'a',
  toPlaceId: o.to ?? 'b',
  departure: o.dep ? { utc: o.dep, timeZone: o.tz ?? 'Asia/Tokyo' } : null,
  arrival: o.arr ? { utc: o.arr, timeZone: o.tz ?? 'Asia/Tokyo' } : null,
  durationSeconds: o.sec ?? null,
  lineName: null,
  platform: null,
  transfers: null,
  fare: o.fare ?? null,
  dataStatus: o.fare ? 'fixture' : 'unknown',
  provenance: null,
});

export const day = (items: TripDay['items'], date = '2026-07-01', timeZone = 'Asia/Tokyo'): TripDay => ({ date, timeZone, items });
