import type {
  Activity,
  DataMode,
  ItineraryItem,
  LocalDate,
  Money,
  PlaceInfo,
  TravelLeg,
  TripConstraints,
  TripDay,
  ValidationState,
  ZonedTime,
} from '@tkb/contracts';
import { summarizeTripCosts } from '../money/currency.ts';
import { localDayOffset, parseUtc, toLocal } from '../time/zone.ts';
import { fitsOpeningHours, parseOpeningHours } from './opening-hours.ts';

/** A violation makes the itinerary infeasible; a warning means something could not be checked (unknown data). */
export type IssueSeverity = 'violation' | 'warning';

export type ScheduleIssueCode =
  // violations
  | 'unknown_place'
  | 'end_before_start'
  | 'overlap'
  | 'travel_time_insufficient'
  | 'leg_endpoint_mismatch'
  | 'outside_opening_hours'
  | 'outside_trip_dates'
  | 'meal_without_place'
  | 'free_walk_without_area'
  | 'child_outside_parent'
  | 'must_visit_missing'
  | 'fixed_activity_missing'
  | 'fixed_activity_changed'
  | 'over_budget'
  // warnings
  | 'time_unknown'
  | 'travel_time_unknown'
  | 'leg_missing'
  | 'meal_after_meal'
  | 'opening_hours_unknown'
  | 'day_mismatch'
  | 'budget_unverified'
  | 'fixed_activity_skipped';

export interface ScheduleIssue {
  code: ScheduleIssueCode;
  severity: IssueSeverity;
  /** activityId / legId / placeId the issue is about, in itinerary order. */
  refs: string[];
  /** Index into `days`, or null for whole-trip checks (must-visit, fixed, budget). */
  dayIndex: number | null;
  /** Short Japanese explanation for the screen. */
  message: string;
}

export interface ScheduleValidation {
  /** True when there is no violation. Warnings alone do not make a plan infeasible, but it still needs review. */
  feasible: boolean;
  /** invalid with any violation, needs_review with only warnings, valid when nothing is left to check. */
  validationState: ValidationState;
  issues: ScheduleIssue[];
  /** Whether the places and legs used are fixture data, live data or both. Null when nothing referenced any. */
  dataMode: DataMode | null;
  /** Known activity costs and leg fares per currency (skipped activities excluded), as in PlanCandidate. */
  totalKnownCost: Money[];
  /** True when any of those costs is unknown: the known total is then a lower bound, never the full cost (R11). */
  hasUnknownCost: boolean;
}

export interface ScheduleInput {
  days: readonly TripDay[];
  places: readonly PlaceInfo[];
  constraints?: Pick<TripConstraints, 'startDate' | 'endDate' | 'mustVisit' | 'budget'>;
  /** Activities that must stay exactly as given (reservations, R12 fixed items), e.g. from the base trip. */
  fixedActivities?: readonly Activity[];
  /**
   * Where and when each day starts (hotel, station), by day index. Travel from that place and time to the first item
   * is then checked too; either part may be null when unknown.
   */
  dayStarts?: readonly ({ placeId: string | null; time: ZonedTime | null } | null)[];
}

const VIOLATIONS: ReadonlySet<ScheduleIssueCode> = new Set([
  'unknown_place',
  'end_before_start',
  'overlap',
  'travel_time_insufficient',
  'leg_endpoint_mismatch',
  'outside_opening_hours',
  'outside_trip_dates',
  'meal_without_place',
  'free_walk_without_area',
  'child_outside_parent',
  'must_visit_missing',
  'fixed_activity_missing',
  'fixed_activity_changed',
  'over_budget',
]);

/** A meal and the next food closer than this count as consecutive (#32 R4); breakfast then dinner does not. */
export const MEAL_GAP_MS = 3 * 3600_000;
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const plusSeconds = (ms: number | null, seconds: number | null) => (ms === null || seconds === null ? null : ms + seconds * 1000);
const msOf = (t: ZonedTime | null) => (t === null ? null : parseUtc(t.utc));
const itemId = (item: ItineraryItem) => (item.type === 'activity' ? item.activityId : item.legId);

/** Interval of a leg; a missing end is filled from durationSeconds, a missing departure from `earliest` (previous end). */
function legInterval(leg: TravelLeg, earliest: number | null): { start: number | null; end: number | null } {
  const dep = msOf(leg.departure);
  const arr = msOf(leg.arrival);
  if (dep !== null) return { start: dep, end: arr ?? plusSeconds(dep, leg.durationSeconds) };
  if (arr !== null) return { start: plusSeconds(arr, leg.durationSeconds === null ? null : -leg.durationSeconds), end: arr };
  const start = leg.durationSeconds === null ? null : earliest;
  return { start, end: plusSeconds(start, leg.durationSeconds) };
}

/**
 * Deterministic itinerary check (D06, R03/R04/R11/R13): place IDs, time order, travel time between activities,
 * opening hours, trip dates, must-visit places, fixed activities and budget. Unknown data is a warning, never
 * assumed to be fine or to be 0. Skipped activities are ignored. Expects contract-valid input.
 */
export function validateSchedule(input: ScheduleInput): ScheduleValidation {
  const issues: ScheduleIssue[] = [];
  const add = (code: ScheduleIssueCode, refs: string[], dayIndex: number | null, message: string) =>
    issues.push({ code, severity: VIOLATIONS.has(code) ? 'violation' : 'warning', refs, dayIndex, message });

  const places = new Map(input.places.map(p => [p.placeId, p]));
  const { startDate, endDate } = input.constraints ?? {};
  const outsideTrip = (date: LocalDate) => (startDate !== undefined && date < startDate) || (endDate !== undefined && date > endDate);
  const statuses = new Set<string>();
  const usePlace = (placeId: string, ref: string, dayIndex: number) => {
    const place = places.get(placeId);
    if (!place) add('unknown_place', [ref, placeId], dayIndex, `地点 ${placeId} は取得済みの地点に含まれていません。`);
    else statuses.add(place.dataStatus);
    return place;
  };

  // Chronology runs across days (an overnight leg ends on the next day); place continuity is checked within a day.
  let cursor: { ms: number; ref: string; leg: boolean } | null = null;
  input.days.forEach((day, dayIndex) => {
    if (outsideTrip(day.date)) add('outside_trip_dates', [day.date], dayIndex, `${day.date} は旅行期間外です。`);
    const dayStart = input.dayStarts?.[dayIndex] ?? null;
    const startMs = msOf(dayStart?.time ?? null);
    if (startMs !== null && (cursor === null || startMs > cursor.ms)) cursor = { ms: startMs, ref: dayStart?.placeId ?? day.date, leg: false };
    // Last place reached on this day: the start place, then each activity.
    const startPlaceId = dayStart?.placeId ?? null;
    // A parent stands for its children's places too (#32 R4: legs are made per parent).
    let last: { ref: string; places: Set<string>; title: string; meal: boolean; endMs: number | null } | null =
      startPlaceId === null ? null : { ref: startPlaceId, places: new Set([startPlaceId]), title: places.get(startPlaceId)?.name ?? startPlaceId, meal: false, endMs: null };
    let legsSince: TravelLeg[] = [];

    const dayActivities = new Map(day.items.flatMap(i => (i.type === 'activity' ? [[i.activityId, i] as const] : [])));
    const childPlaces = new Map<string, string[]>();
    for (const a of dayActivities.values()) {
      if (a.parentActivityId && a.placeId && a.status !== 'skipped') childPlaces.set(a.parentActivityId, [...(childPlaces.get(a.parentActivityId) ?? []), a.placeId]);
    }
    const mealParents = new Set([...dayActivities.values()].filter(a => a.parentActivityId && a.kind === 'meal' && a.status !== 'skipped').map(a => a.parentActivityId!));
    const unitPlaces = (a: Activity) => new Set([...(a.placeId ? [a.placeId] : []), ...(childPlaces.get(a.activityId) ?? [])]);
    for (const item of day.items) {
      // A child activity (parentActivityId) happens inside its parent's window: it is not part of the top-level chronology.
      const parent = item.type === 'activity' && item.parentActivityId ? dayActivities.get(item.parentActivityId) : undefined;
      if (item.type === 'activity' && parent && item.status !== 'skipped') {
        const cs = msOf(item.start);
        const ce = msOf(item.end);
        if (cs === null || ce === null) add('time_unknown', [item.activityId], dayIndex, `「${item.title}」の開始・終了時刻が未定のため検証できません。`);
        if (cs !== null && ce !== null && ce < cs) add('end_before_start', [item.activityId], dayIndex, `${item.activityId} の終了が開始より前です。`);
        const ps = msOf(parent.start);
        const pe = msOf(parent.end);
        if ((cs !== null && ps !== null && cs < ps) || (ce !== null && pe !== null && ce > pe)) {
          add('child_outside_parent', [item.activityId, parent.activityId], dayIndex, `「${item.title}」が親の予定「${parent.title}」の時間帯に収まっていません。`);
        }
        if (item.kind === 'meal' && item.placeId === null) add('meal_without_place', [item.activityId], dayIndex, `食事「${item.title}」に店舗が指定されていません。`);
        if (item.placeId !== null) usePlace(item.placeId, item.activityId, dayIndex);
        continue;
      }
      if (item.type === 'activity' && item.status === 'skipped') {
        // R12: dropping a fixed activity (a reservation) is allowed but must be visible.
        if (item.fixed) add('fixed_activity_skipped', [item.activityId], dayIndex, `固定予定「${item.title}」が取りやめになっています。`);
        continue;
      }
      const ref = itemId(item);

      // Interval and time order.
      let start: number | null;
      let end: number | null;
      let reported = false;
      if (item.type === 'activity') {
        start = msOf(item.start);
        end = msOf(item.end);
        if (start === null || end === null) add('time_unknown', [ref], dayIndex, `「${item.title}」の開始・終了時刻が未定のため検証できません。`);
      } else {
        statuses.add(item.dataStatus);
        ({ start, end } = legInterval(item, cursor?.ms ?? null));
        if (item.durationSeconds === null && (item.departure === null || item.arrival === null)) {
          add('travel_time_unknown', [ref], dayIndex, `区間 ${ref} の所要時間が未取得です。`);
        }
        // Without a departure the leg leaves when it must to arrive on time; it cannot leave before the previous item ends.
        const leaves = start ?? end;
        if (cursor && item.departure === null && leaves !== null && leaves < cursor.ms) {
          add('travel_time_insufficient', [cursor.ref, ref], dayIndex, `区間 ${ref} の移動時間が前の予定の後に収まりません。`);
          reported = true;
        }
      }
      if (start !== null && end !== null && end < start) {
        add('end_before_start', [ref], dayIndex, `${ref} の終了が開始より前です。`);
      }
      // An item with only an end still cannot end before the previous one does.
      const begins = start ?? end;
      if (cursor && !reported && begins !== null && begins < cursor.ms) {
        if (cursor.leg && item.type === 'activity') add('travel_time_insufficient', [cursor.ref, ref], dayIndex, `移動を終える前に「${item.title}」が始まります。`);
        else add('overlap', [cursor.ref, ref], dayIndex, `${cursor.ref} と ${ref} の時間が重なっています。`);
      }
      const reached = end ?? start;
      if (reached !== null && (cursor === null || reached >= cursor.ms)) cursor = { ms: reached, ref, leg: item.type === 'leg' };

      if (item.type === 'leg') {
        usePlace(item.fromPlaceId, ref, dayIndex);
        usePlace(item.toPlaceId, ref, dayIndex);
        const prev = legsSince.at(-1);
        if (prev ? prev.toPlaceId !== item.fromPlaceId : last !== null && last.places.size > 0 && !last.places.has(item.fromPlaceId)) {
          add('leg_endpoint_mismatch', [prev?.legId ?? last!.ref, ref], dayIndex, `区間 ${ref} の出発地が直前の地点と一致しません。`);
        }
        legsSince.push(item);
        continue;
      }

      // Activity: kind rules (R13), place, continuity, dates, opening hours.
      if (item.kind === 'meal' && item.placeId === null) add('meal_without_place', [ref], dayIndex, `食事「${item.title}」に店舗が指定されていません。`);
      if (item.kind === 'free_walk' && !item.areaName) add('free_walk_without_area', [ref], dayIndex, `自由散策「${item.title}」にエリアが指定されていません。`);
      const place = item.placeId === null ? undefined : usePlace(item.placeId, ref, dayIndex);

      const here = unitPlaces(item);
      const lastLeg = legsSince.at(-1);
      if (lastLeg && here.size > 0 && !here.has(lastLeg.toPlaceId)) {
        add('leg_endpoint_mismatch', [lastLeg.legId, ref], dayIndex, `区間 ${lastLeg.legId} の到着地が「${item.title}」の地点と一致しません。`);
      } else if (!lastLeg && last && ![...here].some(id => last!.places.has(id))) {
        add('leg_missing', [last.ref, ref], dayIndex, `「${last.title}」から「${item.title}」への移動が未確認です。`);
      }
      // #32 R4: no food right after a meal (a meal or an area food walk) within MEAL_GAP_MS. Children inside a parent are
      // one unit; a parent containing a meal counts as a meal.
      const startMs = msOf(item.start);
      const soon = last?.endMs == null || startMs === null || startMs - last.endMs < MEAL_GAP_MS;
      if (last?.meal && soon && (item.kind === 'meal' || item.kind === 'free_walk' || mealParents.has(item.activityId))) {
        add('meal_after_meal', [last.ref, ref], dayIndex, `食事「${last.title}」の直後に「${item.title}」が続いています（食事を連続させない）。`);
      }
      last = { ref, places: here, title: item.title, meal: item.kind === 'meal' || mealParents.has(item.activityId), endMs: msOf(item.end) };
      legsSince = [];

      if (item.start !== null) {
        const local = toLocal({ utc: item.start.utc, timeZone: day.timeZone });
        if (outsideTrip(local.date)) add('outside_trip_dates', [ref], dayIndex, `「${item.title}」は旅行期間外（${local.date}）です。`);
        else if (local.date !== day.date) add('day_mismatch', [ref], dayIndex, `「${item.title}」は ${day.date} の日程に入っていますが、${local.date} の予定です。`);
      }

      const needsHours = item.kind === 'visit' || item.kind === 'meal' || item.kind === 'free_walk';
      if (item.kind === 'visit' && item.placeId === null && item.status === 'planned') {
        add('opening_hours_unknown', [ref], dayIndex, `「${item.title}」は地点が未指定のため営業時間を確認できません。`);
      }
      if (place && needsHours && item.status === 'planned') {
        const ranges = parseOpeningHours(place.openingHours);
        if (ranges === null) {
          // Areas usually have no opening hours; only venues are reported as unknown.
          if (item.kind !== 'free_walk' || place.openingHours !== null) {
            add('opening_hours_unknown', [ref, place.placeId], dayIndex, `「${place.name}」の営業時間が未取得または読み取れません。`);
          }
        } else if (item.start !== null && item.end !== null) {
          const s = { utc: item.start.utc, timeZone: place.timeZone };
          const e = { utc: item.end.utc, timeZone: place.timeZone };
          const startMin = minutesOf(toLocal(s).time);
          const endMin = minutesOf(toLocal(e).time) + 1440 * localDayOffset(s, e);
          if (!fitsOpeningHours(ranges, startMin, endMin)) {
            add('outside_opening_hours', [ref, place.placeId], dayIndex, `「${item.title}」は「${place.name}」の営業時間（${place.openingHours}）外です。`);
          }
        }
      }
    }
  });

  // Whole-trip checks.
  const active = input.days.flatMap(d => d.items).filter((i): i is Activity => i.type === 'activity' && i.status !== 'skipped');
  const visited = new Set(active.map(a => a.placeId));
  for (const placeId of input.constraints?.mustVisit ?? []) {
    if (!visited.has(placeId)) add('must_visit_missing', [placeId], null, `必須地点「${places.get(placeId)?.name ?? placeId}」が旅程に含まれていません。`);
  }

  const byId = new Map(input.days.flatMap(d => d.items).flatMap(i => (i.type === 'activity' ? [[i.activityId, i] as const] : [])));
  const at = (t: ZonedTime | null) => (t === null ? null : `${parseUtc(t.utc)}@${t.timeZone}`);
  const pinned = (a: Activity) => [a.kind, a.placeId, a.areaName, at(a.start), at(a.end), a.fixed].join('|');
  for (const fixed of input.fixedActivities ?? []) {
    const now = byId.get(fixed.activityId);
    if (!now) add('fixed_activity_missing', [fixed.activityId], null, `固定予定「${fixed.title}」が旅程から外れています。`);
    else if (pinned(now) !== pinned(fixed)) add('fixed_activity_changed', [fixed.activityId], null, `固定予定「${fixed.title}」の時刻・場所が変更されています。`);
  }

  const kept = input.days.map(d => ({ ...d, items: d.items.filter(i => i.type === 'leg' || i.status !== 'skipped') }));
  const { totals, unknownItemIds } = summarizeTripCosts(kept);
  const budget = input.constraints?.budget ?? null;
  if (budget) {
    const same = totals.find(t => t.currency === budget.currency)?.amountMinor ?? 0;
    const others = totals.filter(t => t.currency !== budget.currency).map(t => t.currency);
    if (same > budget.amountMinor) {
      add('over_budget', [], null, `既知の費用だけで予算（${budget.amountMinor} ${budget.currency}）を超えています。`);
    } else if (unknownItemIds.length > 0 || others.length > 0) {
      const why = [unknownItemIds.length > 0 ? `費用未取得 ${unknownItemIds.length} 件` : '', others.length > 0 ? `別通貨 ${others.join('/')}` : '']
        .filter(Boolean)
        .join('、');
      add('budget_unverified', [...unknownItemIds], null, `予算内か確定できません（${why}）。`);
    }
  }

  const feasible = !issues.some(i => i.severity === 'violation');
  // unknown / unavailable values are neither: they are reported as warnings above.
  const fixture = statuses.has('fixture');
  const live = statuses.has('verified');
  return {
    feasible,
    validationState: !feasible ? 'invalid' : issues.length > 0 ? 'needs_review' : 'valid',
    issues,
    dataMode: fixture && live ? 'mixed' : fixture ? 'fixture' : live ? 'live' : null,
    totalKnownCost: totals,
    hasUnknownCost: unknownItemIds.length > 0,
  };
}
