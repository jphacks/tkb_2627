import type { Activity, ItineraryItem, LocalDate, PlaceInfo, TimeZone, TravelLeg, TripDay, UtcInstant } from '@tkb/contracts';
import { fromLocal, parseUtc, toLocal } from '../time/zone.ts';
import { earliestOpenStart, parseOpeningHours } from './opening-hours.ts';
import { validateSchedule, type ScheduleValidation } from './validate.ts';

export interface SequenceStop {
  activity: Activity;
  /** Stay length of a flexible stop. Ignored for a fixed stop with times, which keeps its own start and end. */
  stayMinutes?: number;
}

/**
 * Travel lookup for one segment departing no earlier than `departureUtc` (D04 adapter or fixture legs).
 * Returns null when travel is unknown. A leg without times gets them from its durationSeconds.
 */
export type TravelLookup = (fromPlaceId: string, toPlaceId: string, departureUtc: UtcInstant) => TravelLeg | null;

export interface SequenceInput {
  date: LocalDate;
  timeZone: TimeZone;
  /** Local HH:mm window of the day (00:00-23:59). */
  dayStart: string;
  dayEnd: string;
  /** Where the day starts (hotel, station); null when unknown, so the first stop needs no travel. */
  startPlaceId: string | null;
  /** Stops in the proposed order (e.g. CandidateBlueprint.activityOrder). */
  stops: readonly SequenceStop[];
  places: readonly PlaceInfo[];
  travel: TravelLookup;
}

export type ExclusionReason = 'closed' | 'does_not_fit' | 'travel_unknown' | 'stay_unknown';

export interface SequenceResult {
  day: TripDay;
  /** Stops left out, in input order, with the reason (R04: each candidate shows why a place was dropped). */
  excluded: { activityId: string; reason: ExclusionReason }[];
  validation: ScheduleValidation;
}

const toUtc = (ms: number): UtcInstant => new Date(ms).toISOString().replace(/\.000Z$/, 'Z');
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const pinned = (s: SequenceStop) => s.activity.fixed && s.activity.start !== null && s.activity.end !== null;

/** Day bounds never widen the window: a DST overlap/gap takes the later instant for the start, the earlier for the end. */
function boundMs(date: LocalDate, time: string, timeZone: TimeZone, side: 'start' | 'end'): number {
  const r = fromLocal(date, time, timeZone);
  if (r.kind === 'exact') return parseUtc(r.utc);
  if (r.kind === 'ambiguous') return parseUtc(side === 'start' ? r.later : r.earlier);
  return parseUtc(side === 'start' ? r.after : r.before);
}

/**
 * Builds one day from proposed stops without moving fixed ones (D06 ordering, R03/R13).
 * Flexible stops keep the proposed order and start as early as travel and opening hours allow. A stop that would
 * make the next fixed activity late moves after it; a stop that still does not fit, is closed, or whose travel or
 * stay is unknown is excluded with a reason. Times are never invented: the result is re-checked by validateSchedule.
 */
export function sequenceDay(input: SequenceInput): SequenceResult {
  const places = new Map(input.places.map(p => [p.placeId, p]));
  const zoned = (ms: number) => ({ utc: toUtc(ms), timeZone: input.timeZone });
  const dayEnd = boundMs(input.date, input.dayEnd, input.timeZone, 'end');
  const anchors = input.stops
    .filter(pinned)
    .map(s => s.activity)
    .sort((a, b) => parseUtc(a.start!.utc) - parseUtc(b.start!.utc));

  const items: ItineraryItem[] = [];
  const excluded: SequenceResult['excluded'] = [];
  let cursor = boundMs(input.date, input.dayStart, input.timeZone, 'start');
  let at = input.startPlaceId;
  let nextAnchor = 0;

  /** Travel from `from` to `to` leaving at or after `ms`. No leg when either end is unknown or both are the same place. */
  const go = (ms: number, from: string | null, to: string | null): { leg: TravelLeg | null; arrive: number } | null => {
    if (from === null || to === null || from === to) return { leg: null, arrive: ms };
    const leg = input.travel(from, to, toUtc(ms));
    if (!leg) return null;
    const dep = leg.departure ? parseUtc(leg.departure.utc) : ms;
    const arr = leg.arrival ? parseUtc(leg.arrival.utc) : leg.durationSeconds === null ? null : dep + leg.durationSeconds * 1000;
    if (arr === null || dep < ms) return null;
    return { leg: { ...leg, departure: leg.departure ?? zoned(dep), arrival: leg.arrival ?? zoned(arr) }, arrive: arr };
  };

  // Unknown travel to a fixed activity is kept as a gap; validateSchedule reports it (leg_missing / late arrival).
  const commitAnchor = (a: Activity) => {
    const trip = go(cursor, at, a.placeId);
    if (trip?.leg) items.push(trip.leg);
    items.push(a);
    cursor = Math.max(cursor, parseUtc(a.end!.utc));
    at = a.placeId;
  };

  for (const stop of input.stops) {
    if (pinned(stop)) continue;
    const a = stop.activity;
    const stay = stop.stayMinutes;
    if (stay === undefined || !Number.isInteger(stay) || stay <= 0) {
      excluded.push({ activityId: a.activityId, reason: 'stay_unknown' });
      continue;
    }
    const place = a.placeId === null ? undefined : places.get(a.placeId);
    const ranges = place ? parseOpeningHours(place.openingHours) : null;

    let reason: ExclusionReason | null = null;
    for (;;) {
      const anchor = anchors[nextAnchor];
      const trip = go(cursor, at, a.placeId);
      if (!trip) {
        reason = 'travel_unknown';
        break;
      }
      let start = trip.arrive;
      if (place && ranges) {
        const fromMin = minutesOf(toLocal({ utc: toUtc(start), timeZone: place.timeZone }).time);
        const open = earliestOpenStart(ranges, fromMin, stay);
        if (open === null) {
          reason = 'closed';
          break;
        }
        start += (open - fromMin) * 60_000;
      }
      const end = start + stay * 60_000;
      let fits = end <= dayEnd;
      if (fits && anchor) {
        const onward = go(end, a.placeId, anchor.placeId);
        fits = onward !== null && onward.arrive <= parseUtc(anchor.start!.utc);
      }
      if (fits) {
        if (trip.leg) items.push(trip.leg);
        items.push({ ...a, start: zoned(start), end: zoned(end) });
        cursor = end;
        at = a.placeId;
        break;
      }
      if (!anchor) {
        reason = 'does_not_fit';
        break;
      }
      // Order adjustment: the stop cannot come before this fixed activity, so try it after.
      commitAnchor(anchor);
      nextAnchor += 1;
    }
    if (reason) excluded.push({ activityId: a.activityId, reason });
  }
  while (nextAnchor < anchors.length) commitAnchor(anchors[nextAnchor++]!);

  const day: TripDay = { date: input.date, timeZone: input.timeZone, items };
  return { day, excluded, validation: validateSchedule({ days: [day], places: input.places, fixedActivities: anchors }) };
}
