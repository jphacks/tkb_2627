import type { Activity, ItineraryItem, PlaceInfo, TravelLeg, Trip, TripDay, TripOperation } from '@tkb/contracts';
import { sequenceDay, toLocal, validateSchedule, type ExclusionReason, type TravelLookup } from '@tkb/planner';
import type { RouteUnknownReason } from '@tkb/travel-data';
import { applyOperations, computeDiff } from '../operations.ts';
import { LegBook, distanceM, legModeFor } from '../alternatives/leg-book.ts';
import { operationsBetween } from '../alternatives/ops-between.ts';
import { reconcileServiceLegs, storableTrip, uniqueLegIds, warnFor } from '../alternatives/plan.ts';
import { CURRENT_LOCATION_ID, reasonKey, syntheticCurrentPlace } from './routes.ts';
import type { ConflictReason, ReplanCandidate, ReplanRequest, StartKind } from './schema.ts';

/** A request the server refuses with 422; `code` is the error code the route sends. */
export class ReplanError extends Error {
  constructor(
    readonly code: 'VALIDATION_FAILED' | 'CONSTRAINT_UNSATISFIED',
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const LEG_REFETCH_WARNING = '移動情報は表示時に再取得';
const NO_LOCATION_WARNING = '現在地が分からないため、最初の移動時間は含めていません。';
const LAST_COMPLETED_WARNING = '現在地が使えないため、最後に完了した予定の場所から計算しました。';
const NO_START_LEG_WARNING = '現在地からの移動時間が分からないため含めていません。';
const OVERFLOW_WARNING = '現在時刻がその日の終わりに近いため、残りの予定は時刻を決めていません。';
/** Local time from which a missing transit route is reported as a possible end of service. */
const LATE_FROM = '22:00';
/** A flexible stop counts as "the traveller is here" within this distance of the sent position. */
const HERE_M = 200;

const acts = (d: TripDay): Activity[] => d.items.filter((i): i is Activity => i.type === 'activity');
const json = (x: unknown) => JSON.stringify(x);
const msToZ = (ms: number, timeZone: string) => ({ utc: new Date(ms).toISOString().replace(/\.000Z$/, 'Z'), timeZone });
const ceilMinute = (ms: number) => Math.ceil(ms / 60000) * 60000;

const stayMinutes = (a: Activity): number | undefined => {
  if (!a.start || !a.end) return undefined;
  const m = Math.round((Date.parse(a.end.utc) - Date.parse(a.start.utc)) / 60000);
  return m > 0 ? m : undefined;
};

/** Sets `completed` on the given activities of day `dayIndex`. An unknown id, a leg id, another day's id or a skipped activity is refused. */
export function markCompleted(trip: Trip, ids: string[], dayIndex: number): Trip {
  if (ids.length === 0) return trip;
  const want = new Set(ids);
  const found = new Set<string>();
  // N4: only the current day may change; an id on another day is refused like an unknown one.
  const days = trip.days.map((d, i) => i !== dayIndex ? d : ({
    ...d,
    items: d.items.map((it): ItineraryItem => {
      if (it.type !== 'activity' || !want.has(it.activityId)) return it;
      found.add(it.activityId);
      if (it.status === 'skipped') throw new ReplanError('VALIDATION_FAILED', 'Invalid request.');
      return it.status === 'completed' ? it : { ...it, status: 'completed' };
    }),
  }));
  if (ids.some(id => !found.has(id))) throw new ReplanError('VALIDATION_FAILED', 'Invalid request.');
  return { ...trip, days };
}

/** The day whose date is the local date of `nowMs` in that day's time zone, or -1. */
export function currentDayIndex(trip: Trip, nowMs: number): number {
  return trip.days.findIndex(d => toLocal(msToZ(nowMs, d.timeZone)).date === d.date);
}

export interface DaySplit {
  /** Items kept exactly as they were: past block and ongoing activities, in original order. */
  prefix: ItineraryItem[];
  /** Fixed activities that are not completed and are over, or reported missed. Never moved. */
  missed: Activity[];
  ongoing: Activity[];
  /** Everything still to place, in original order: planned stops, future anchors and fixed items without times. */
  stops: Activity[];
}

/** `pins` are fixed for this run only (fixedActivityIds); the stored `fixed` flag is not read from them. */
export function splitDay(day: TripDay, nowMs: number, missedIds: ReadonlySet<string>, pins: ReadonlySet<string>, isThere: (a: Activity) => boolean = () => false): DaySplit {
  const kind = new Map<string, 'past' | 'ongoing' | 'stop'>();
  const missed: Activity[] = [];
  const ongoing: Activity[] = [];
  const stops: Activity[] = [];
  for (const a of acts(day)) {
    const fixed = a.fixed || pins.has(a.activityId);
    const s = a.start ? Date.parse(a.start.utc) : null;
    const e = a.end ? Date.parse(a.end.utc) : null;
    if (a.status !== 'planned') kind.set(a.activityId, 'past');
    else if (fixed && ((e !== null && e <= nowMs) || missedIds.has(a.activityId))) {
      kind.set(a.activityId, 'past');
      missed.push(a);
    } else if (s !== null && e !== null && s <= nowMs && nowMs < e && (fixed || isThere(a))) {
      // A reservation in progress stays. A flexible stop counts as under way only when the traveller is shown to be
      // there; otherwise they are late or elsewhere and it is re-timed from now like the rest.
      kind.set(a.activityId, 'ongoing');
      ongoing.push(a);
    } else {
      kind.set(a.activityId, 'stop');
      stops.push(a);
    }
  }
  const kept = (i: ItineraryItem | undefined) => i?.type === 'activity' && kind.get(i.activityId) !== 'stop';
  const prefix: ItineraryItem[] = [];
  day.items.forEach((it, i) => {
    // A leg is kept when both ends are kept; the day's first leg (from the departure point) only needs its arrival kept.
    if (it.type === 'activity' ? kept(it) : (i === 0 || kept(day.items[i - 1])) && kept(day.items[i + 1])) prefix.push(it);
  });
  return { prefix, missed, ongoing, stops };
}

export interface ReplanContext {
  base: Trip;
  /** base with the destination change applied (and nothing else). */
  edited: Trip;
  req: ReplanRequest;
  book: LegBook;
  /** The same map the book was built with. The synthetic current place is added to it, in memory only. */
  places: Map<string, PlaceInfo>;
  /** Why a pair has no leg, filled by recordingRoutes. */
  reasons: ReadonlyMap<string, RouteUnknownReason>;
  nowMs: number;
}

export interface ReplanOutcome {
  dayIndex: number;
  start: { kind: StartKind; placeId: string | null };
  startLeg: TravelLeg | null;
  candidate: Omit<ReplanCandidate, 'candidateId'>;
}

const LEG_ISSUES: Record<string, ConflictReason> = {
  travel_time_insufficient: 'unreachable',
  overlap: 'unreachable',
  travel_time_unknown: 'travel_unknown',
  leg_missing: 'travel_unknown',
};

/**
 * Re-times the rest of the current day from now (A06): completed and fixed items stay as they are, the other days are
 * not touched. Fixed items are never dropped or moved; what cannot be reached is reported as a reservation conflict.
 */
export async function planReplan(ctx: ReplanContext): Promise<ReplanOutcome> {
  const { req, book, places, nowMs } = ctx;
  const ids = new Set(ctx.edited.days.flatMap(d => acts(d)).map(a => a.activityId));
  for (const id of [...req.missedActivityIds, ...req.fixedActivityIds]) if (!ids.has(id)) throw new ReplanError('VALIDATION_FAILED', 'Invalid request.');
  const loc = req.location;
  if (loc.kind === 'place' && !ctx.edited.places.some(p => p.placeId === loc.placeId)) {
    throw new ReplanError('VALIDATION_FAILED', 'Invalid request.');
  }
  const di = currentDayIndex(ctx.edited, nowMs);
  if (di < 0) throw new ReplanError('CONSTRAINT_UNSATISFIED', 'The current time is outside the trip.', { reason: 'outside_trip' });
  const edited = markCompleted(ctx.edited, req.completedActivityIds, di);
  const day = edited.days[di]!;
  const dayMode: TravelLeg['mode'] = edited.constraints.transportModeByDate?.[day.date] ?? edited.constraints.transportMode;

  const pins = new Set(req.fixedActivityIds);
  const isFixed = (a: Activity) => a.fixed || pins.has(a.activityId);
  const isThere = (a: Activity): boolean => {
    const p = a.placeId === null ? undefined : places.get(a.placeId);
    if (loc.kind === 'place') return a.placeId === loc.placeId;
    return loc.kind === 'coords' && !!p?.location && distanceM(loc.point, p.location) <= HERE_M;
  };
  const split = splitDay(day, nowMs, new Set(req.missedActivityIds), pins, isThere);
  // Limits: a DST fold (the same wall-clock time twice) is read by sequenceDay as the later instant, and the replan
  // never runs past 23:59 of the current day (after that the remaining stops are untimed, not moved to the next day).
  const cursor = ceilMinute(Math.max(nowMs, ...split.ongoing.map(a => Date.parse(a.end!.utc))));
  const cursorLocal = toLocal(msToZ(cursor, day.timeZone));
  const overflow = cursorLocal.date > day.date;
  const prefixActs = split.prefix.filter((i): i is Activity => i.type === 'activity');

  // Where the re-timing starts. Coordinates are only used for the route lookup and never leave this function.
  const warnings: string[] = [];
  const unknown = new Set<string>();
  let kind: StartKind;
  let startId: string | null;
  const lastCompleted = [...prefixActs].reverse().find(a => a.status === 'completed' && a.placeId !== null);
  if (split.ongoing.length > 0) {
    kind = 'ongoing';
    startId = split.ongoing.reduce((best, a) => (Date.parse(a.end!.utc) >= Date.parse(best.end!.utc) ? a : best)).placeId;
  } else if (loc.kind === 'place') {
    kind = 'place';
    startId = loc.placeId;
  } else if (loc.kind === 'coords') {
    kind = 'coords';
    startId = CURRENT_LOCATION_ID;
    places.set(CURRENT_LOCATION_ID, syntheticCurrentPlace(loc.point, day.timeZone));
  } else if (lastCompleted) {
    kind = 'last_completed';
    startId = lastCompleted.placeId;
    warnings.push(LAST_COMPLETED_WARNING);
  } else {
    kind = 'none';
    startId = null;
    warnings.push(NO_LOCATION_WARNING);
    unknown.add('start');
  }

  // Legs, looked up at the projected time (from the cursor, advancing by travel and stay) rather than the stale original
  // times. N1: start -> each stop up to the first with a known stay, the chain of stops, and each future anchor with
  // every flexible stop in both directions (a stop pushed after the anchor needs anchor -> stop).
  const lateNoRoute = new Set<string>();
  const iso = (ms: number) => msToZ(ms, day.timeZone).utc;
  const pair = async (from: string | null, to: Activity, depMs: number) => {
    if (from === null || to.placeId === null || from === to.placeId) return;
    const mode = legModeFor(places.get(from), places.get(to.placeId), dayMode);
    const dep = iso(depMs);
    await book.ensure(from, to.placeId, mode, dep);
    if (book.has(from, to.placeId, mode)) return;
    if (ctx.reasons.get(reasonKey(from, to.placeId, mode, dep)) === 'no_route' && mode === 'transit' && toLocal(msToZ(depMs, day.timeZone)).time >= LATE_FROM) {
      lateNoRoute.add(to.activityId);
    }
  };
  const stops = split.stops;
  const anchors = stops.filter(a => isFixed(a) && a.start && a.end);
  if (!overflow && stops.length > 0) {
    let t = cursor;
    let prev = startId;
    const endAt = new Map<string, number>(); // projected end of each stop
    for (const [i, a] of stops.entries()) {
      if (i === 0 || stayMinutes(stops[i - 1]!) === undefined) await pair(startId, a, cursor);
      await pair(prev, a, t);
      const leg = prev !== null && a.placeId !== null && prev !== a.placeId ? book.get(prev, a.placeId, legModeFor(places.get(prev), places.get(a.placeId), dayMode)) : null;
      if (leg?.durationSeconds != null) t += leg.durationSeconds * 1000;
      if (isFixed(a) && a.start && a.end) t = Math.max(t, Date.parse(a.end.utc));
      else t += (stayMinutes(a) ?? 0) * 60_000;
      endAt.set(a.activityId, t);
      prev = a.placeId ?? prev;
    }
    // Anchors: each flexible stop -> the first anchor after its original position, and each anchor -> its neighbours.
    const firstAnchor = anchors.map(a => ({ a, s: Date.parse(a.start!.utc) })).sort((x, y) => x.s - y.s)[0];
    if (firstAnchor) await pair(startId, firstAnchor.a, cursor);
    let nextAnchor: Activity | null = null;
    for (let i = stops.length - 1; i >= 0; i--) {
      const a = stops[i]!;
      if (anchors.includes(a)) {
        nextAnchor = a;
        continue;
      }
      if (nextAnchor) await pair(a.placeId, nextAnchor, endAt.get(a.activityId) ?? cursor);
    }
    // Stops before an anchor can be pushed after it, so the neighbours on both sides (up to the next anchor) are covered.
    for (const [i, anchor] of stops.entries()) {
      if (!anchors.includes(anchor)) continue;
      const near: Activity[] = [];
      for (let j = i - 1; j >= 0 && !anchors.includes(stops[j]!); j--) near.push(stops[j]!);
      for (let j = i + 1; j < stops.length && !anchors.includes(stops[j]!); j++) near.push(stops[j]!);
      for (const a of near) await pair(anchor.placeId, a, Date.parse(anchor.end!.utc));
    }
  }
  // A start whose first leg is unknown is dropped (not every remaining stop is left untimed because of it).
  const first = stops[0];
  if (kind === 'coords' && first?.placeId && !book.has(startId!, first.placeId, legModeFor(places.get(startId!), places.get(first.placeId), dayMode))) {
    kind = 'none';
    startId = null;
    warnings.push(NO_START_LEG_WARNING);
    unknown.add('legs');
  }
  const publicPlaceId = startId === CURRENT_LOCATION_ID ? null : startId;

  // Sequence the rest.
  const lookup: TravelLookup = (f, t) => book.get(f, t, legModeFor(places.get(f), places.get(t), dayMode));
  const pinOnly = new Set(stops.filter(a => pins.has(a.activityId) && !a.fixed).map(a => a.activityId));
  const run = (list: Activity[]) =>
    sequenceDay({
      date: day.date,
      timeZone: day.timeZone,
      dayStart: cursorLocal.time,
      dayEnd: '23:59',
      startPlaceId: startId,
      stops: list.map(a => ({ activity: pinOnly.has(a.activityId) ? { ...a, fixed: true } : a, stayMinutes: stayMinutes(a) })),
      places: [...places.values()],
      travel: lookup,
    });
  const reasons = new Map<string, ExclusionReason | 'cascade'>();
  let sequenced: ItineraryItem[] = [];
  if (overflow) {
    warnings.push(OVERFLOW_WARNING);
    for (const a of stops) if (!isFixed(a)) reasons.set(a.activityId, 'does_not_fit');
  } else {
    // Unknown travel stops the timed chain there: later flexible stops stay untimed instead of being timed as if the
    // unknown stop were not there. Fixed stops keep their own times.
    let list = stops;
    let result = run(list);
    const cascade = new Map<string, ExclusionReason | 'cascade'>();
    for (let guard = 0; guard < stops.length + 1; guard++) {
      const idx = list.findIndex(a => result.excluded.some(e => e.activityId === a.activityId && e.reason === 'travel_unknown'));
      if (idx < 0) break;
      cascade.set(list[idx]!.activityId, 'travel_unknown');
      for (const a of list.slice(idx + 1)) if (!isFixed(a)) cascade.set(a.activityId, 'cascade');
      list = list.filter((a, i) => i < idx || isFixed(a));
      result = run(list);
    }
    for (const e of result.excluded) reasons.set(e.activityId, e.reason);
    for (const [k, v] of cascade) reasons.set(k, v);
    const original = new Map(stops.map(a => [a.activityId, a]));
    sequenced = result.day.items.map(it => (it.type === 'activity' && pinOnly.has(it.activityId) ? original.get(it.activityId)! : it));
  }
  const placed = new Set(sequenced.filter((i): i is Activity => i.type === 'activity').map(a => a.activityId));

  // B4: a leg that names a service keeps only its duration (the departure changed). Done before the start leg is split off.
  const baseLegs = new Map(ctx.base.days.flatMap(d => d.items).filter((i): i is TravelLeg => i.type === 'leg').map(l => [l.legId, l]));
  const tmp = [{ ...day, items: sequenced }];
  warnings.push(...reconcileServiceLegs(tmp, new Set([0]), baseLegs));
  sequenced = tmp[0]!.items;

  // The leg from the start to the first stop is shown separately when the start is not where the kept items end.
  const lastPrefixAct = prefixActs.at(-1) ?? null;
  let startLeg: TravelLeg | null = null;
  const head = sequenced[0];
  if (head?.type === 'leg' && (head.fromPlaceId === CURRENT_LOCATION_ID || (lastPrefixAct?.placeId != null && head.fromPlaceId !== lastPrefixAct.placeId))) {
    const dur = head.durationSeconds;
    startLeg = dur === null ? head : { ...head, departure: msToZ(cursor, day.timeZone), arrival: msToZ(cursor + dur * 1000, day.timeZone) };
    sequenced = sequenced.slice(1);
  }
  // Legs depart when the previous item ends (the first one leaves now).
  let prevEnd = cursor;
  sequenced = sequenced.map(it => {
    if (it.type === 'activity') {
      if (it.end) prevEnd = Math.max(prevEnd, Date.parse(it.end.utc));
      return it;
    }
    const dur = it.durationSeconds;
    if (dur === null || it.departure) return it;
    return { ...it, departure: msToZ(prevEnd, day.timeZone), arrival: msToZ(prevEnd + dur * 1000, day.timeZone) };
  });

  // Stops that were not placed: flexible ones lose their times and say why; fixed ones are kept unchanged.
  const tail: ItineraryItem[] = [];
  const untimed: { activityId: string; reason: string }[] = [];
  const conflicts: { activityId: string; reason: ConflictReason }[] = [];
  const addConflict = (activityId: string, reason: ConflictReason) => {
    if (!conflicts.some(c => c.activityId === activityId && c.reason === reason)) conflicts.push({ activityId, reason });
  };
  for (const a of stops) {
    if (placed.has(a.activityId)) continue;
    if (isFixed(a)) {
      tail.push(a);
      addConflict(a.activityId, 'time_unknown');
      continue;
    }
    const why = reasons.get(a.activityId) ?? 'does_not_fit';
    const w = warnFor(a, why);
    tail.push({ ...a, start: null, end: null });
    untimed.push({ activityId: a.activityId, reason: why });
    if (w) {
      warnings.push(w.text);
      unknown.add(w.unknown);
    }
  }
  for (const a of stops) {
    if (!lateNoRoute.has(a.activityId)) continue;
    warnings.push(`「${a.title}」までの公共交通の経路が見つかりませんでした（終電後の可能性があります）。徒歩・タクシーなどはご自身で確認してください。`);
    unknown.add('legs');
  }

  const items = [...split.prefix, ...sequenced, ...tail];
  const days = edited.days.map((d, i) => (i === di ? { ...d, items } : d));
  const touched = new Set([di]);
  const finished = uniqueLegIds(days, touched);

  // Same checks as A05, over all days. The first leg is not in the trip, so the gap before the first stop is expected.
  const fixedActivities = edited.days.flatMap(d => acts(d)).filter(a => a.fixed);
  const dayStarts = edited.days.map((_, i) => (i === di && split.prefix.length === 0 && publicPlaceId !== null ? { placeId: publicPlaceId, time: msToZ(cursor, day.timeZone) } : null));
  const v = validateSchedule({ days: finished, places: edited.places, constraints: edited.constraints, fixedActivities, dayStarts });
  const firstSeq = sequenced.find((i): i is Activity => i.type === 'activity');
  const gapExpected = startLeg !== null || startId === null;
  // N5: a stop marked completed ahead of time keeps its own time, so items re-timed from now may sit before it. That
  // order is the traveller's doing, not a planning error: issues about such a stop are not reported.
  const doneAhead = new Set(prefixActs.filter(a => a.status === 'completed' && a.start && Date.parse(a.start.utc) > nowMs).map(a => a.activityId));
  const issues = v.issues.filter(i => (i.dayIndex === di || i.dayIndex === null) && !i.refs.some(r => doneAhead.has(r)) && !(gapExpected && i.code === 'leg_missing' && firstSeq && i.refs[1] === firstSeq.activityId));

  for (const issue of issues) warnings.push(issue.message);

  // Reservations: never moved or dropped; say when they cannot be kept.
  const legNext = new Map<string, string>();
  items.forEach((it, i) => {
    const next = items[i + 1];
    if (it.type === 'leg' && next?.type === 'activity') legNext.set(it.legId, next.activityId);
  });
  const futureFixed = new Set(stops.filter(isFixed).map(a => a.activityId));
  const targetOf = (ref: string | undefined) => (ref === undefined ? undefined : (legNext.get(ref) ?? ref));
  for (const issue of issues) {
    const reason = LEG_ISSUES[issue.code];
    if (!reason) continue;
    const target = targetOf(issue.code === 'travel_time_unknown' ? issue.refs[0] : issue.refs[issue.refs.length - 1]);
    if (target && futureFixed.has(target)) addConflict(target, reason);
  }
  for (const a of split.missed) addConflict(a.activityId, 'missed');
  const title = new Map(acts(day).map(a => [a.activityId, a.title]));
  const conflictOrder: ConflictReason[] = ['missed', 'unreachable', 'travel_unknown', 'time_unknown'];
  conflicts.sort((a, b) => conflictOrder.indexOf(a.reason) - conflictOrder.indexOf(b.reason));
  for (const c of conflicts) {
    warnings.push(c.reason === 'missed' ? `予約「${title.get(c.activityId)}」の時刻を過ぎています。予約先に確認してください。` : `予約「${title.get(c.activityId)}」に間に合わない可能性があります。予約先に確認してください。`);
  }

  const legs = items.filter((i): i is TravelLeg => i.type === 'leg');
  if (legs.some(l => l.mode !== 'walk' && l.fare === null)) unknown.add('fare');
  if (legs.some(l => l.mode === 'transit' && l.platform === null)) unknown.add('platform');
  if (items.some(i => i.type === 'activity' && i.placeId && places.get(i.placeId)?.openingHours === null)) unknown.add('openingHours');
  if (untimed.some(u => u.reason === 'travel_unknown' || u.reason === 'cascade')) unknown.add('legs');

  const trip: Trip = { ...edited, days: finished };
  const { trip: storable, stripped } = storableTrip(trip, nowMs);
  const operations: TripOperation[] | null = operationsBetween(ctx.base, storable);
  // The diff (and validation state) is what PATCH returns for these operations.
  const stored = operations !== null ? applyOperations(ctx.base, operations) : null;
  const diff = computeDiff(ctx.base, stored?.ok ? stored.trip : storable);
  const w = [...new Set(warnings)];
  let displayOnly: ReplanCandidate['displayOnly'];
  if (stripped) {
    const live = computeDiff(ctx.base, trip);
    displayOnly = { knownCostDelta: live.knownCostDelta, durationDeltaSeconds: live.durationDeltaSeconds };
    w.push(LEG_REFETCH_WARNING);
  }
  if (operations === null) w.push('この案は編集操作（最大50件）で再現できないため、そのままは適用できません。');

  const before = new Map(acts(ctx.base.days[di]!).map(a => [a.activityId, a]));
  const retimed = sequenced
    .filter((i): i is Activity => i.type === 'activity' && !isFixed(i))
    .filter(a => json([a.start, a.end]) !== json([before.get(a.activityId)?.start, before.get(a.activityId)?.end]))
    .map(a => a.activityId);
  return {
    dayIndex: di,
    start: { kind, placeId: publicPlaceId },
    startLeg,
    candidate: {
      kind: 'keep_order',
      summary: '現在時刻から残りの予定を詰め直した案（完了済みと固定の予定はそのまま。順序は変えず、時刻を決められない予定は末尾に回す）',
      trip: { ...trip, validationState: stored?.ok ? stored.trip.validationState : trip.validationState, warnings: w },
      diff,
      ...(displayOnly ? { displayOnly } : {}),
      validationState: v.validationState,
      warnings: w,
      unknown: [...unknown].sort(),
      operations,
      kept: {
        completed: acts(day).filter(a => a.status === 'completed').map(a => a.activityId),
        fixed: acts(day).filter(a => isFixed(a) && a.status !== 'skipped').map(a => a.activityId),
      },
      retimed,
      untimed,
      reservationConflicts: conflicts,
    },
  };
}
