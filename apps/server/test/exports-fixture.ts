import type { Trip } from '@tkb/contracts';

/** Shared E02 test trip: an exportable place, a restricted place, a home departure, legs with known and unknown data. */
const tz = 'Asia/Tokyo';
const prov = (mayExport: boolean, attribution: string | null = null) => ({
  source: 'fixture', fetchedAt: null, attribution, maySendToModel: true, mayStore: true, mayExport, retainUntil: null,
});
const place = (placeId: string, name: string, mayExport: boolean, photo = false): Trip['places'][number] => ({
  placeId, name, kind: 'spot', location: { lat: 36.56, lng: 136.66 }, timeZone: tz, openingHours: null, description: null,
  photo: photo ? { url: 'https://example.invalid/p.jpg', attribution: '撮影者A', license: null } : null,
  dataStatus: 'fixture', provenance: prov(mayExport, mayExport ? 'サンプル提供元' : null),
});

export function exportTrip(over: Partial<Trip> = {}): Trip {
  return {
    schemaVersion: 1,
    tripId: 'trip_pdf',
    ownerId: 'user_a',
    title: '金沢の秋旅',
    revision: 1,
    constraints: {
      area: '金沢', startDate: '2026-11-01', endDate: '2026-11-01', timeZone: tz, transportMode: 'transit',
      departure: { placeId: 'home', label: '自宅', time: null },
    },
    days: [{
      date: '2026-11-01', timeZone: tz, items: [
        {
          type: 'leg', legId: 'leg_known', mode: 'transit', fromPlaceId: 'home', toPlaceId: 'p_ok',
          departure: { utc: '2026-11-01T00:00:00Z', timeZone: tz }, arrival: { utc: '2026-11-01T00:30:00Z', timeZone: tz },
          durationSeconds: 1800, lineName: '北鉄バス', platform: null, transfers: null, fare: null, dataStatus: 'fixture',
          provenance: prov(true, '交通サンプル'), transit: { boardingStop: '金沢駅', alightingStop: null, transferStops: [] },
        },
        {
          type: 'activity', activityId: 'act_ok', kind: 'visit', title: '兼六園を歩く', placeId: 'p_ok', areaName: null,
          start: { utc: '2026-11-01T01:00:00Z', timeZone: tz }, end: { utc: '2026-11-01T02:30:00Z', timeZone: tz },
          fixed: true, status: 'planned', cost: { amountMinor: 320, currency: 'JPY' }, costStatus: 'fixture', privateNotes: '秘密のメモ',
        },
        {
          type: 'activity', activityId: 'act_secret', kind: 'meal', title: '昼食', placeId: 'p_no', areaName: null,
          start: null, end: null, fixed: false, status: 'planned', cost: null, costStatus: 'unknown', privateNotes: null,
        },
        {
          type: 'leg', legId: 'leg_no', mode: 'car', fromPlaceId: 'p_no', toPlaceId: 'p_ok',
          departure: null, arrival: null, durationSeconds: null, lineName: null, platform: null, transfers: null,
          fare: { amountMinor: 999, currency: 'JPY' }, dataStatus: 'verified', provenance: prov(false),
        },
      ],
    }],
    places: [place('home', '自宅マンション', true), place('p_ok', '兼六園', true, true), place('p_no', '非公開レストラン', false, true)],
    validationState: 'needs_review',
    warnings: [],
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...over,
  } as Trip;
}
