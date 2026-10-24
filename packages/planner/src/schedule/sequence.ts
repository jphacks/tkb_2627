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

export type ExclusionReason = 'closed' | 'does_not_fit' | 'travel_unknown' | 'stay_unknown' | 'fixed_time_unknown';

export interface SequenceResult {
  day: TripDay;
  /** Stops left out, in input order, with the reason (R04: each candidate shows why a place was dropped). */
  excluded: { activityId: string; reason: ExclusionReason }[];
  /**
   * Check of this day alone. Must-visit places, trip dates and budget need the whole trip: callers re-run
   * validateSchedule over all days with the trip constraints.
   */
  validation: ScheduleValidation;
}

const toUtc = (ms: number): UtcInstant => new Date(ms).toISOString().replace(/\.000Z$/, 'Z');
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const pinned = (s: SequenceStop) => s.activity.fixed;
const timed = (a: Activity) => a.start !== null && a.end !== null;

/** Day bounds never widen the window: a DST overlap/gap takes the later instant for the start, the earlier for the end. */
function boundMs(date: LocalDate, time: string, timeZone: TimeZone, side: 'start' | 'end'): number {
  const r = fromLocal(date, time, timeZone);
  if (r.kind === 'exact') return parseUtc(r.utc);
  if (r.kind === 'ambiguous') return parseUtc(side === 'start' ? r.later : r.earlier);
  return parseUtc(side === 'start' ? r.after : r.before);
}

/** First instant at or after `notBefore` showing local `minute` (0-1439) on `date` in `timeZone`; DST-safe. */
function wallClockAtOrAfter(date: LocalDate, minute: number, timeZone: TimeZone, notBefore: number): number {
  const hhmm = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  const r = fromLocal(date, hhmm, timeZone);
  const options = r.kind === 'exact' ? [r.utc] : r.kind === 'ambiguous' ? [r.earlier, r.later] : [r.after];
  const ms = options.map(parseUtc).find(t => t >= notBefore);
  return ms ?? notBefore;
}

/**
 * Builds one day from proposed stops without moving fixed ones (D06 ordering, R03/R13).
 * Flexible stops keep the proposed order and start as early as travel and opening hours allow. A stop that would
 * make the next fixed activity late moves after it; a stop that still does not fit, is closed, or whose travel or
 * stay is unknown is excluded with a reason, and so is a fixed stop without times. Leg times are kept exactly as the
 * lookup returned them (a duration-only leg stays without departure/arrival), and the day is re-checked by
 * validateSchedule.
 */
export function sequenceDay(input: SequenceInput): SequenceResult {
  const places = new Map(input.places.map(p => [p.placeId, p]));
  const zoned = (ms: number) => ({ utc: toUtc(ms), timeZone: input.timeZone });
  const dayEnd = boundMs(input.date, input.dayEnd, input.timeZone, 'end');
  const fixed = input.stops.filter(pinned).map(s => s.activity);
  const anchors = fixed.filter(timed).sort((a, b) => parseUtc(a.start!.utc) - parseUtc(b.start!.utc));

  const items: ItineraryItem[] = [];
  const excluded: SequenceResult['excluded'] = [];
  const dayStart = boundMs(input.date, input.dayStart, input.timeZone, 'start');
  let cursor = dayStart;
  let at = input.startPlaceId;
  let nextAnchor = 0;

  /** Travel from `from` to `to` leaving at or after `ms`. No leg when either end is unknown or both are the same place; the leg is returned untouched. */
  const go = (ms: number, from: string | null, to: string | null): { leg: TravelLeg | null; arrive: number } | null => {
    if (from === null || to === null || from === to) return { leg: null, arrive: ms };
    const leg = input.travel(from, to, toUtc(ms));
    if (!leg) return null;
    const dep = leg.departure ? parseUtc(leg.departure.utc) : ms;
    const arr = leg.arrival ? parseUtc(leg.arrival.utc) : leg.durationSeconds === null ? null : dep + leg.durationSeconds * 1000;
    if (arr === null || dep < ms || arr < dep) return null;
    return { leg, arrive: arr };
  };

  // Unknown travel to a fixed activity is kept as a gap; validateSchedule reports it (leg_missing, also from the start place).
  const commitAnchor = (a: Activity) => {
    const trip = go(cursor, at, a.placeId);
    if (trip?.leg) items.push(trip.leg);
    items.push(a);
    cursor = Math.max(cursor, parseUtc(a.end!.utc));
    at = a.placeId;
  };

  for (const stop of input.stops) {
    const a = stop.activity;
    if (pinned(stop)) {
      if (!timed(a)) excluded.push({ activityId: a.activityId, reason: 'fixed_time_unknown' });
      continue;
    }
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
        const local = toLocal({ utc: toUtc(start), timeZone: place.timeZone });
        const fromMin = minutesOf(local.time);
        const open = earliestOpenStart(ranges, fromMin, stay);
        if (open === null) {
          reason = 'closed';
          break;
        }
        if (open > fromMin) start = wallClockAtOrAfter(local.date, open, place.timeZone, start);
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
  // Every fixed stop is checked, so one left out for lack of times shows up as fixed_activity_missing.
  const validation = validateSchedule({
    days: [day],
    places: input.places,
    fixedActivities: fixed,
    dayStarts: [{ placeId: input.startPlaceId, time: zoned(dayStart) }],
  });
  return { day, excluded, validation };
}
