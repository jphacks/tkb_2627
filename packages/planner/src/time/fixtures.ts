// Test-only builders for contract items. Not exported from the package index.
import type { Activity, Money, TravelLeg, TripDay } from '@tkb/contracts';

const at = (utc: string | null, timeZone: string) => (utc === null ? null : { utc, timeZone });

/** Activity with optional times (UTC) and cost; costStatus follows the cost. */
export function makeActivity(
  id: string,
  opts: { start?: string | null; end?: string | null; cost?: Money | null; timeZone?: string } = {},
): Activity {
  const tz = opts.timeZone ?? 'Asia/Tokyo';
  const cost = opts.cost ?? null;
  return {
    type: 'activity',
    activityId: id,
    kind: 'visit',
    title: id,
    placeId: null,
    areaName: null,
    start: at(opts.start ?? null, tz),
    end: at(opts.end ?? null, tz),
    fixed: false,
    status: 'planned',
    cost,
    costStatus: cost === null ? 'unknown' : 'fixture',
    privateNotes: null,
  };
}

/** Transit leg with optional departure/arrival (UTC) and fare. */
export function makeLeg(
  id: string,
  opts: { departure?: string | null; arrival?: string | null; fare?: Money | null; timeZone?: string } = {},
): TravelLeg {
  const tz = opts.timeZone ?? 'Asia/Tokyo';
  const fare = opts.fare ?? null;
  return {
    type: 'leg',
    legId: id,
    mode: 'transit',
    fromPlaceId: 'a',
    toPlaceId: 'b',
    departure: at(opts.departure ?? null, tz),
    arrival: at(opts.arrival ?? null, tz),
    durationSeconds: null,
    lineName: null,
    platform: null,
    transfers: null,
    fare,
    dataStatus: fare === null ? 'unknown' : 'fixture',
    provenance: null,
  };
}

export function makeDay(items: TripDay['items'], timeZone = 'Asia/Tokyo', date = '2026-07-01'): TripDay {
  return { date, timeZone, items };
}
