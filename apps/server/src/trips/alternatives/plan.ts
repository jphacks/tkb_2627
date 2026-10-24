import type { Activity, ItineraryItem, PlaceInfo, TravelLeg, Trip, TripDay, TripDiff, TripOperation, ValidationState } from '@tkb/contracts';
import { fitsOpeningHours, fromLocal, parseOpeningHours, sequenceDay, toLocal, validateSchedule, type ExclusionReason, type TravelLookup } from '@tkb/planner';
import { applyOperations, computeDiff } from '../operations.ts';
import { LegBook, legModeFor } from './leg-book.ts';
import { itemIdOf, operationsBetween } from './ops-between.ts';

export type CandidateKind = 'requested' | 'reorder' | 'swap';

export interface AffectedSegment {
  dayIndex: number;
  fromItemId: string;
  toItemId: string;
  /** known: a leg with a duration; none: same place or no venue (nothing to travel); unknown: not obtained, left untimed. */
  travel: 'known' | 'none' | 'unknown';
}

export interface Candidate {
  candidateId: string;
  kind: CandidateKind;
  summary: string;
  trip: Trip;
  /** Exactly what K10 PATCH returns for `operations` (computeDiff on the stored result). */
  diff: TripDiff;
  /** Only when live route details were left out of `operations`: the same measures with them. Display only, never stored. */
  displayOnly?: { knownCostDelta: TripDiff['knownCostDelta']; durationDeltaSeconds: number | null };
  affectedSegments: AffectedSegment[];
  validationState: ValidationState;
  warnings: string[];
  unknown: string[];
  /** K10 operations that reproduce this candidate (live route details removed). null when they cannot be written. */
  operations: TripOperation[] | null;
}

/** 5! = 120 orders per day at most. */
const MAX_PERMUTED = 5;
const pinned = (a: Activity) => a.fixed || a.status !== 'planned';
const acts = (d: TripDay): Activity[] => d.items.filter((i): i is Activity => i.type === 'activity');
const json = (x: unknown) => JSON.stringify(x);

/** Elapsed times of legs follow from their duration; an unknown duration keeps the leg untimed (never 0). */
export function fillLegTimes(days: readonly TripDay[]): TripDay[] {
  return days.map(day => {
    const items: ItineraryItem[] = [];
    let prevEnd: { utc: string; timeZone: string } | null = null;
    for (const it of day.items) {
      if (it.type === 'leg') {
        let leg: TravelLeg = it;
        const dur = leg.durationSeconds;
        if (dur !== null) {
          const dep = leg.departure ?? prevEnd;
          if (dep && !leg.departure) leg = { ...leg, departure: dep };
          if (dep && !leg.arrival) leg = { ...leg, arrival: { utc: new Date(Date.parse(dep.utc) + dur * 1000).toISOString().replace(/\.000Z$/, 'Z'), timeZone: dep.timeZone } };
        }
        items.push(leg);
        prevEnd = leg.arrival;
      } else {
        items.push(it);
        prevEnd = it.end;
      }
    }
    return { ...day, items };
  });
}

const msToZ = (ms: number, timeZone: string) => ({ utc: new Date(ms).toISOString().replace(/\.000Z$/, 'Z'), timeZone });

export interface PlanContext {
  base: Trip;
  /** base with the requested operations applied, before any re-timing. */
  edited: Trip;
  ops: TripOperation[];
  book: LegBook;
  places: Map<string, PlaceInfo>;
  nowMs: number;
}

interface DayPlan {
  dayIndex: number;
  prefixItems: ItineraryItem[];
  prefixPlaceId: string | null;
  prefixEndMs: number | null;
  tail: Activity[];
  dayStartMin: string;
  mode: TravelLeg['mode'];
}

interface DayBuild {
  items: ItineraryItem[];
  warnings: string[];
  unknown: Set<string>;
  excluded: number;
  travelSeconds: number;
  feasible: boolean;
}

const stayMinutes = (a: Activity): number | undefined => {
  if (!a.start || !a.end) return undefined;
  const m = Math.round((Date.parse(a.end.utc) - Date.parse(a.start.utc)) / 60000);
  return m > 0 ? m : undefined;
};

/** Days whose activities changed by the edit (ids, order or content). */
export function affectedDayIndexes(base: Trip, edited: Trip): number[] {
  return edited.days.flatMap((d, i) => (json(acts(d)) === json(acts(base.days[i]!)) ? [] : [i]));
}

function dayPlanFor(ctx: PlanContext, di: number, order: Activity[]): DayPlan {
  const before = ctx.base.days[di]!;
  const beforeActs = acts(before);
  let k = 0;
  while (k < order.length && k < beforeActs.length && json(order[k]) === json(beforeActs[k])) k++;
  // Unchanged leading activities keep their items and times. The prefix must end on a timed activity.
  while (k > 0 && !order[k - 1]!.end) k--;
  let prefixItems: ItineraryItem[] = [];
  let prefixPlaceId: string | null = null;
  let prefixEndMs: number | null = null;
  if (k > 0) {
    const last = order[k - 1]!;
    const at = before.items.findIndex(i => i.type === 'activity' && i.activityId === last.activityId);
    prefixItems = before.items.slice(0, at + 1);
    prefixPlaceId = last.placeId;
    prefixEndMs = Date.parse(last.end!.utc);
  }
  const starts = [...beforeActs, ...order].filter(a => a.start).map(a => toLocal(a.start!).time);
  const dayStartMin = starts.length ? starts.sort()[0]! : '09:00';
  const mode = ctx.base.constraints.transportModeByDate?.[before.date] ?? ctx.base.constraints.transportMode;
  return { dayIndex: di, prefixItems, prefixPlaceId, prefixEndMs, tail: order.slice(k), dayStartMin, mode };
}

/** Prefetches the legs between consecutive activities (and, with `all`, every pair) of a day plan. */
async function prefetch(ctx: PlanContext, plan: DayPlan, all: boolean): Promise<void> {
  const day = ctx.base.days[plan.dayIndex]!;
  const seq: Activity[] = [];
  if (plan.prefixPlaceId) seq.push({ placeId: plan.prefixPlaceId, end: msToZ(plan.prefixEndMs!, day.timeZone) } as unknown as Activity);
  seq.push(...plan.tail);
  const wanted: [Activity, Activity][] = [];
  for (let i = 1; i < seq.length; i++) wanted.push([seq[i - 1]!, seq[i]!]);
  if (all) for (const a of seq) for (const b of seq) if (a !== b) wanted.push([a, b]);
  const fallback = fromLocal(day.date, '09:00', day.timeZone);
  const dep0 = fallback.kind === 'exact' ? fallback.utc : `${day.date}T00:00:00Z`;
  for (const [a, b] of wanted) {
    if (!a.placeId || !b.placeId) continue;
    const m = legModeFor(ctx.places.get(a.placeId), ctx.places.get(b.placeId), plan.mode);
    await ctx.book.ensure(a.placeId, b.placeId, m, a.end?.utc ?? b.start?.utc ?? dep0);
  }
}

function warnFor(a: Activity, why: ExclusionReason | 'cascade'): { text: string; unknown: string } | null {
  const t = `「${a.title}」`;
  switch (why) {
    case 'travel_unknown': return { text: `${t}は移動時間が不明なため、時刻を決めていません。`, unknown: 'legs' };
    case 'cascade': return { text: `${t}は直前の移動時間が不明なため、時刻を決めていません。`, unknown: 'legs' };
    case 'stay_unknown': return { text: `${t}は滞在時間が不明なため、時刻を決めていません。`, unknown: 'stay' };
    case 'closed': return { text: `${t}は営業時間内に収まらないため、時刻を決めていません。`, unknown: 'schedule' };
    case 'does_not_fit': return { text: `${t}はその日に収まらないため、時刻を決めていません。`, unknown: 'schedule' };
    default: return null; // skipped / fixed without times: kept exactly as they were, nothing was decided
  }
}

function sequence(ctx: PlanContext, plan: DayPlan): DayBuild {
  const day = ctx.base.days[plan.dayIndex]!;
  const lookup: TravelLookup = (f, t) => ctx.book.get(f, t, legModeFor(ctx.places.get(f), ctx.places.get(t), plan.mode));
  let startMs = plan.prefixEndMs;
  if (startMs !== null) startMs = Math.ceil(startMs / 60000) * 60000;
  const dayStart = startMs === null ? plan.dayStartMin : toLocal(msToZ(startMs, day.timeZone)).time;
  const dayDate = startMs === null ? day.date : toLocal(msToZ(startMs, day.timeZone)).date;
  const run = (stops: Activity[]) =>
    sequenceDay({
      date: dayDate,
      timeZone: day.timeZone,
      dayStart,
      dayEnd: '23:59',
      startPlaceId: plan.prefixPlaceId,
      stops: stops.map(a => ({ activity: a, stayMinutes: stayMinutes(a) })),
      places: [...ctx.places.values()],
      travel: lookup,
    });
  // Unknown travel stops the timed chain there: everything after it stays untimed rather than being timed as if the
  // unknown stop were not there. Fixed/completed activities keep their own times.
  let stops = plan.tail;
  let result = run(stops);
  const cascade = new Map<string, ExclusionReason | 'cascade'>();
  for (let guard = 0; guard < plan.tail.length + 1; guard++) {
    const idx = stops.findIndex(a => result.excluded.some(e => e.activityId === a.activityId && e.reason === 'travel_unknown'));
    if (idx < 0) break;
    cascade.set(stops[idx]!.activityId, 'travel_unknown');
    for (const a of stops.slice(idx + 1)) if (!pinned(a)) cascade.set(a.activityId, 'cascade');
    stops = stops.filter((a, i) => i < idx || pinned(a));
    result = run(stops);
  }
  const placed = new Set(result.day.items.filter((i): i is Activity => i.type === 'activity').map(a => a.activityId));
  const reasons = new Map<string, ExclusionReason | 'cascade'>(result.excluded.map(e => [e.activityId, e.reason]));
  for (const [k, v] of cascade) reasons.set(k, v);
  const warnings: string[] = [];
  const unknown = new Set<string>();
  const items: ItineraryItem[] = [...plan.prefixItems, ...result.day.items];
  for (const a of plan.tail) {
    if (placed.has(a.activityId)) continue;
    const why = reasons.get(a.activityId) ?? 'does_not_fit';
    const w = warnFor(a, why);
    items.push(pinned(a) ? a : { ...a, start: null, end: null });
    if (w) {
      warnings.push(w.text);
      unknown.add(w.unknown);
    }
  }
  let travelSeconds = 0;
  for (const it of result.day.items) if (it.type === 'leg') travelSeconds += it.durationSeconds ?? 0;
  const excluded = plan.tail.filter(a => !placed.has(a.activityId) && warnFor(a, reasons.get(a.activityId) ?? 'does_not_fit')).length;
  return { items, warnings, unknown, excluded, travelSeconds, feasible: result.validation.feasible };
}

function uniqueLegIds(days: TripDay[], touched: Set<number>): TripDay[] {
  const used = new Set<string>();
  for (const [i, d] of days.entries()) if (!touched.has(i)) for (const it of d.items) used.add(itemIdOf(it));
  return days.map((d, i) => {
    if (!touched.has(i)) return d;
    return {
      ...d,
      items: d.items.map(it => {
        let id = itemIdOf(it);
        if (it.type === 'activity') {
          used.add(id);
          return it;
        }
        const base = id;
        for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
        used.add(id);
        return id === base ? it : { ...it, legId: id };
      }),
    };
  });
}

const storableProv = (p: { mayStore: boolean; retainUntil: string | null } | null, nowMs: number) =>
  p === null || (p.mayStore && (p.retainUntil === null || Date.parse(p.retainUntil) > nowMs));

/** What may be written back: a leg whose provenance forbids storing keeps only its endpoints (D-1/D-2). */
function storableTrip(trip: Trip, nowMs: number): { trip: Trip; stripped: boolean } {
  let stripped = false;
  const days = trip.days.map(d => ({
    ...d,
    items: d.items.map((it): ItineraryItem => {
      if (it.type !== 'leg' || storableProv(it.provenance, nowMs)) return it;
      stripped = true;
      return { type: 'leg', legId: it.legId, mode: it.mode, fromPlaceId: it.fromPlaceId, toPlaceId: it.toPlaceId, departure: null, arrival: null, durationSeconds: null, lineName: null, platform: null, transfers: null, fare: null, dataStatus: 'unknown', provenance: null };
    }),
  }));
  return { trip: { ...trip, days }, stripped };
}

function segmentsOf(ctx: PlanContext, days: TripDay[], dayIdx: number[]): AffectedSegment[] {
  const out: AffectedSegment[] = [];
  const beforeById = new Map(ctx.base.days.flatMap(d => acts(d)).map(a => [a.activityId, json(a)]));
  // Compared as edited (before re-timing): an activity that only shifted in time is not itself a changed endpoint.
  const editedById = new Map(ctx.edited.days.flatMap(d => acts(d)).map(a => [a.activityId, json(a)]));
  for (const di of dayIdx) {
    const live = (d: TripDay) => acts(d).filter(a => a.status !== 'skipped');
    const order = live(days[di]!);
    const beforeOrder = live(ctx.base.days[di]!);
    const beforePairs = new Set(beforeOrder.slice(1).map((a, i) => `${beforeOrder[i]!.activityId}>${a.activityId}`));
    const items = days[di]!.items;
    for (let i = 1; i < order.length; i++) {
      const a = order[i - 1]!;
      const b = order[i]!;
      const isNew = !beforePairs.has(`${a.activityId}>${b.activityId}`);
      if (!isNew && beforeById.get(a.activityId) === editedById.get(a.activityId) && beforeById.get(b.activityId) === editedById.get(b.activityId)) continue;
      let travel: AffectedSegment['travel'] = 'none';
      if (a.placeId && b.placeId && a.placeId !== b.placeId) {
        const ia = items.indexOf(a);
        const between = items[ia + 1];
        travel = between?.type === 'leg' && between.durationSeconds !== null && between.fromPlaceId === a.placeId && between.toPlaceId === b.placeId ? 'known' : 'unknown';
      }
      out.push({ dayIndex: di, fromItemId: a.activityId, toItemId: b.activityId, travel });
    }
  }
  return out;
}

const SERVICE_NOTICE = '便が変わるため乗車情報は再確認してください。';
const hasService = (l: TravelLeg) => l.lineName !== null || l.platform !== null || (l.transit !== undefined && l.transit !== null);

/**
 * B4: a leg that names a timetable service (line, platform, stops) is only valid at the time it was fetched for.
 * When its time would change, it keeps only the duration estimate: no departure/arrival, line, platform, stops or fare.
 */
function reconcileServiceLegs(days: TripDay[], touched: Set<number>, baseLegs: Map<string, TravelLeg>): string[] {
  const warnings: string[] = [];
  for (const di of touched) {
    days[di] = {
      ...days[di]!,
      items: days[di]!.items.map(it => {
        if (it.type !== 'leg' || !hasService(it)) return it;
        const was = baseLegs.get(it.legId);
        if (was && was.departure !== null && it.departure !== null && was.departure.utc === it.departure.utc && was.arrival?.utc === it.arrival?.utc) return it;
        warnings.push(SERVICE_NOTICE);
        return { ...it, departure: null, arrival: null, lineName: null, platform: null, transfers: null, fare: null, transit: null, dataStatus: it.dataStatus };
      }),
    };
  }
  return warnings;
}

interface DayBuild2 {
  items: ItineraryItem[];
  warnings: string[];
  unknown: Set<string>;
  excluded: number;
  travelSeconds: number;
}

const dayModeOf = (ctx: PlanContext, di: number): TravelLeg['mode'] => ctx.base.constraints.transportModeByDate?.[ctx.base.days[di]!.date] ?? ctx.base.constraints.transportMode;

/**
 * Legs to fetch for a shift-only day: between consecutive non-skipped activities, and from the last timed activity
 * to the next one when untimed ones sit between (reachability is checked from the last timed stop).
 */
async function prefetchShift(ctx: PlanContext, di: number, order: Activity[]): Promise<void> {
  const day = ctx.base.days[di]!;
  const mode = dayModeOf(ctx, di);
  const fallback = fromLocal(day.date, '09:00', day.timeZone);
  const dep0 = fallback.kind === 'exact' ? fallback.utc : `${day.date}T00:00:00Z`;
  const pair = async (a: Activity, b: Activity) => {
    if (!a.placeId || !b.placeId || a.placeId === b.placeId) return;
    await ctx.book.ensure(a.placeId, b.placeId, legModeFor(ctx.places.get(a.placeId), ctx.places.get(b.placeId), mode), a.end?.utc ?? b.start?.utc ?? dep0);
  };
  let prev: Activity | null = null;
  let lastTimed: Activity | null = null;
  for (const a of order) {
    if (a.status === 'skipped') continue;
    if (prev) await pair(prev, a);
    if (lastTimed && lastTimed !== prev) await pair(lastTimed, a);
    prev = a;
    if (a.end) lastTimed = a;
  }
}

/**
 * B3 shift-only re-timing, in exactly the order given. An activity keeps its start (and length) when it is still
 * reachable from the previous one; otherwise it moves later by the least needed. Nothing moves earlier and no gap
 * is compressed. Fixed, completed and skipped activities and untimed ones are left as they are. What cannot be
 * timed (unknown travel, closed, would run past midnight) stays in place, untimed, with a warning.
 */
function shiftDay(ctx: PlanContext, di: number, order: Activity[]): DayBuild2 {
  const day = ctx.base.days[di]!;
  const baseItems = day.items;
  const baseActs = new Map(acts(day).map(a => [a.activityId, a]));
  const mode = dayModeOf(ctx, di);
  const items: ItineraryItem[] = [];
  const warnings: string[] = [];
  const unknown = new Set<string>();
  let excluded = 0;
  let travelSeconds = 0;
  let broken = false;
  let prev: Activity | null = null; // previous non-skipped activity (legs attach to it)
  let lastTimed: Activity | null = null; // last non-skipped activity that has times (reachability is measured from it)
  let pendingSkipped: Activity[] = [];
  const untime = (a: Activity, why: ExclusionReason | 'cascade'): Activity => {
    const w = warnFor(a, why);
    if (w) {
      warnings.push(w.text);
      unknown.add(w.unknown);
    }
    excluded += 1;
    return { ...a, start: null, end: null };
  };
  const anchored = (a: Activity) => a.status !== 'skipped' && (a.fixed || a.status === 'completed') && a.start !== null && a.end !== null;
  for (const [idx, a] of order.entries()) {
    if (a.status === 'skipped') {
      pendingSkipped.push(a); // kept verbatim, no legs to or from it
      continue;
    }
    let final: Activity = a;
    let leg: ItineraryItem | null = null;
    const needTravel = prev !== null && prev.placeId !== null && a.placeId !== null && prev.placeId !== a.placeId;
    let travel: TravelLeg | null = null;
    if (prev && needTravel) {
      travel = ctx.book.get(prev.placeId!, a.placeId!, legModeFor(ctx.places.get(prev.placeId!), ctx.places.get(a.placeId!), mode));
    }
    const movable = a.status === 'planned' && !a.fixed && a.start !== null && a.end !== null;
    if (anchored(a)) {
      broken = false; // an anchor keeps its time: resume from its end
    } else if (movable && lastTimed) {
      const ref = lastTimed;
      const refNeeds = ref.placeId !== null && a.placeId !== null && ref.placeId !== a.placeId;
      const refTravel = ref === prev ? travel : refNeeds ? ctx.book.get(ref.placeId!, a.placeId!, legModeFor(ctx.places.get(ref.placeId!), ctx.places.get(a.placeId!), mode)) : null;
      if (broken) final = untime(a, 'cascade');
      else if (refNeeds && refTravel === null) {
        final = untime(a, 'travel_unknown');
        broken = true;
      } else {
        const earliest = Date.parse(ref.end!.utc) + (refTravel ? (refTravel.durationSeconds ?? 0) * 1000 : 0);
        const s = Date.parse(a.start!.utc);
        if (s < earliest) {
          const e = earliest + (Date.parse(a.end!.utc) - s);
          const place = a.placeId ? ctx.places.get(a.placeId) : undefined;
          const ranges = place ? parseOpeningHours(place.openingHours) : null;
          const ls = toLocal(msToZ(earliest, place?.timeZone ?? day.timeZone));
          const startMin = Number(ls.time.slice(0, 2)) * 60 + Number(ls.time.slice(3, 5));
          const nextAnchor = order.slice(idx + 1).find(anchored);
          if (toLocal(msToZ(e, day.timeZone)).date !== day.date || (nextAnchor && e > Date.parse(nextAnchor.start!.utc))) {
            final = untime(a, 'does_not_fit');
            broken = true;
          } else if (ranges && !fitsOpeningHours(ranges, startMin, startMin + Math.round((e - earliest) / 60000))) {
            final = untime(a, 'closed');
            broken = true;
          } else {
            final = { ...a, start: msToZ(earliest, a.start!.timeZone), end: msToZ(e, a.end!.timeZone) };
            warnings.push(`「${a.title}」は移動の都合で開始を${Math.round((earliest - s) / 60000)}分遅らせました。`);
          }
        }
      }
    }
    if (needTravel && prev) {
      // The stored leg is kept verbatim when both of its stops are exactly as they were.
      const baseAt = baseItems.findIndex(i => i.type === 'activity' && i.activityId === prev!.activityId);
      const between = baseItems[baseAt + 1];
      const next = baseItems[baseAt + 2];
      const same = (x: Activity | undefined, y: Activity) => x !== undefined && json(x) === json(y);
      if (between?.type === 'leg' && next?.type === 'activity' && next.activityId === a.activityId && same(baseActs.get(prev.activityId), prev) && same(baseActs.get(a.activityId), final)) leg = between;
      else if (travel) leg = travel;
      if (leg?.type === 'leg') travelSeconds += leg.durationSeconds ?? 0;
    }
    if (leg) items.push(leg);
    items.push(...pendingSkipped, final);
    pendingSkipped = [];
    prev = final;
    if (final.end) lastTimed = final;
  }
  items.push(...pendingSkipped);
  return { items, warnings, unknown, excluded, travelSeconds };
}

export interface Built {
  candidate: Omit<Candidate, 'candidateId' | 'kind' | 'summary'>;
  /** Total timing outcome used to rank variants. */
  score: { excluded: number; travelSeconds: number; feasible: boolean };
}

/**
 * Assembles a candidate. `orders` maps day index -> activity order. engine 'shift' keeps the user's order and
 * original times (requested, swap); 'pack' re-times from the earliest possible start (only for the reorder variant).
 */
function assemble(ctx: PlanContext, orders: Map<number, Activity[]>, engine: 'shift' | 'pack'): Built | null {
  const days = ctx.edited.days.map(d => ({ ...d, items: [...d.items] }));
  const warnings: string[] = [];
  const unknown = new Set<string>();
  let excluded = 0;
  let travelSeconds = 0;
  let feasible = true;
  const touched = new Set<number>();
  for (const [di, order] of orders) {
    const b: DayBuild2 & { feasible?: boolean } = engine === 'shift' ? shiftDay(ctx, di, order) : sequence(ctx, dayPlanFor(ctx, di, order));
    days[di]!.items = b.items;
    warnings.push(...b.warnings);
    b.unknown.forEach(u => unknown.add(u));
    excluded += b.excluded;
    travelSeconds += b.travelSeconds;
    if (b.feasible === false) feasible = false;
    touched.add(di);
  }
  const filled = fillLegTimes(uniqueLegIds(days, touched)).map((d, i) => (touched.has(i) ? d : ctx.edited.days[i]!));
  const baseLegs = new Map(ctx.base.days.flatMap(d => d.items).filter((i): i is TravelLeg => i.type === 'leg').map(l => [l.legId, l]));
  warnings.push(...reconcileServiceLegs(filled, touched, baseLegs));
  const dayIdx = [...touched].sort((a, b) => a - b);
  const affectedSegments = segmentsOf(ctx, filled, dayIdx);
  for (const s of affectedSegments) if (s.travel === 'unknown') unknown.add('legs');

  const fixedActivities = ctx.edited.days.flatMap(d => acts(d)).filter(a => a.fixed);
  const v = validateSchedule({ days: filled, places: ctx.edited.places, constraints: ctx.edited.constraints, fixedActivities });
  for (const issue of v.issues) if (issue.dayIndex === null || touched.has(issue.dayIndex)) warnings.push(issue.message);
  const touchedItems = dayIdx.flatMap(i => filled[i]!.items);
  const legs = touchedItems.filter((i): i is TravelLeg => i.type === 'leg');
  if (legs.some(l => l.mode !== 'walk' && l.fare === null)) unknown.add('fare');
  if (legs.some(l => l.mode === 'transit' && l.platform === null)) unknown.add('platform');
  if (touchedItems.some(i => i.type === 'activity' && i.placeId && ctx.places.get(i.placeId)?.openingHours === null)) unknown.add('openingHours');

  // Same validation state PATCH will store (applyOperations decides it); the schedule check is reported separately.
  const trip: Trip = { ...ctx.edited, days: filled };
  const { trip: storable, stripped } = storableTrip(trip, ctx.nowMs);
  const operations = operationsBetween(ctx.base, storable);
  // B1: the diff is what PATCH returns for these operations, computed by the same function on the stored result.
  const stored = operations !== null ? applyOperations(ctx.base, operations) : null;
  const diff = computeDiff(ctx.base, stored?.ok ? stored.trip : storable);
  const w = [...new Set(warnings)];
  let displayOnly: Candidate['displayOnly'];
  if (stripped) {
    const live = computeDiff({ ...ctx.base, days: fillLegTimes(ctx.base.days) }, { ...trip, days: fillLegTimes(trip.days) });
    displayOnly = { knownCostDelta: live.knownCostDelta, durationDeltaSeconds: live.durationDeltaSeconds };
    w.push('ライブの経路詳細（所要時間・運賃など）は保存されません。確定後は移動の詳細が不明になります。');
  }
  if (operations === null) w.push('この案は編集操作（最大50件）で再現できないため、そのままは適用できません。');
  return {
    candidate: { trip: { ...trip, warnings: w }, diff, ...(displayOnly ? { displayOnly } : {}), affectedSegments, validationState: v.validationState, warnings: w, unknown: [...unknown].sort(), operations },
    score: { excluded, travelSeconds, feasible: feasible && v.feasible },
  };
}

function* permutations<T>(xs: T[]): Generator<T[]> {
  if (xs.length <= 1) return void (yield xs);
  for (let i = 0; i < xs.length; i++) for (const rest of permutations([...xs.slice(0, i), ...xs.slice(i + 1)])) yield [xs[i]!, ...rest];
}

const better = (a: Built['score'], b: Built['score']) =>
  a.feasible && (a.excluded < b.excluded || (a.excluded === b.excluded && a.travelSeconds < b.travelSeconds));

/** Builds the requested edit and up to two deterministic variants (no AI). */
export async function buildCandidates(ctx: PlanContext, max: number): Promise<Omit<Candidate, 'candidateId'>[]> {
  const days = affectedDayIndexes(ctx.base, ctx.edited);
  const orders = new Map(days.map(d => [d, acts(ctx.edited.days[d]!)]));
  const plans = new Map(days.map(d => [d, dayPlanFor(ctx, d, orders.get(d)!)]));
  for (const d of days) await prefetchShift(ctx, d, orders.get(d)!);
  const main = assemble(ctx, orders, 'shift');
  if (!main) return [];
  const out: Omit<Candidate, 'candidateId'>[] = [
    { kind: 'requested', summary: '指定どおりの編集（順序はそのまま。時刻は間に合わない分だけ後ろへずらし、前へは詰めない）', ...main.candidate },
  ];
  const seen = new Set([json(main.candidate.trip.days)]);
  const push = (kind: CandidateKind, summary: string, b: Built) => {
    const key = json(b.candidate.trip.days);
    if (out.length >= max || seen.has(key)) return;
    seen.add(key);
    out.push({ kind, summary, ...b.candidate });
  };
  if (max < 2 || days.length === 0) return out;

  // Variant 1: reorder the not-yet-fixed activities of the affected days to cut known travel time.
  for (const p of plans.values()) await prefetch(ctx, p, true);
  const reordered = new Map(orders);
  let improved = false;
  for (const [di, order] of orders) {
    const plan = plans.get(di)!;
    const slots = plan.tail.map((a, i) => (pinned(a) ? -1 : i)).filter(i => i >= 0);
    if (slots.length < 2 || slots.length > MAX_PERMUTED) continue;
    const lead = order.slice(0, order.length - plan.tail.length);
    const score = (tail: Activity[]) => {
      const b = sequence(ctx, { ...dayPlanFor(ctx, di, [...lead, ...tail]) });
      return { excluded: b.excluded, travelSeconds: b.travelSeconds, feasible: b.feasible };
    };
    let best = plan.tail;
    let bestScore = score(plan.tail);
    for (const perm of permutations(slots.map(i => plan.tail[i]!))) {
      const tail = [...plan.tail];
      slots.forEach((s, n) => (tail[s] = perm[n]!));
      const s = score(tail);
      if (better(s, bestScore)) {
        best = tail;
        bestScore = s;
      }
    }
    if (best !== plan.tail) {
      reordered.set(di, [...lead, ...best]);
      improved = true;
    }
  }
  if (improved) {
    const b = assemble(ctx, reordered, 'pack');
    if (b && better(b.score, main.score)) push('reorder', '当日の順序を並べ替え、移動時間が短くなるよう時刻を前から詰め直した案（詰め直しはこの案だけ）', b);
  }

  // Variant 2: swap the edited stop for the nearest unused place of the same kind in the trip's own places.
  const touchedId = [...ctx.ops].reverse().flatMap(o => (o.op === 'add' || o.op === 'update') && o.item.type === 'activity' ? [o.item.activityId] : [])[0];
  const target = touchedId ? ctx.edited.days.flatMap(d => acts(d)).find(a => a.activityId === touchedId) : undefined;
  const from = target?.placeId ? ctx.places.get(target.placeId) : undefined;
  if (target && from?.location && !pinned(target)) {
    const used = new Set(ctx.edited.days.flatMap(d => acts(d)).map(a => a.placeId));
    const near = [...ctx.places.values()]
      .filter(p => p.kind === from.kind && p.location && !used.has(p.placeId))
      .map(p => ({ p, d: Math.hypot(p.location!.lat - from.location!.lat, p.location!.lng - from.location!.lng) }))
      .sort((x, y) => x.d - y.d || (x.p.placeId < y.p.placeId ? -1 : 1))[0]?.p;
    const di = ctx.edited.days.findIndex(d => acts(d).some(a => a.activityId === target.activityId));
    if (near && di >= 0) {
      const swapped = { ...target, placeId: near.placeId, title: target.title === from.name ? near.name : target.title };
      const order = (orders.get(di) ?? acts(ctx.edited.days[di]!)).map(a => (a.activityId === target.activityId ? swapped : a));
      const sw = new Map(orders);
      sw.set(di, order);
      await prefetchShift(ctx, di, order);
      const b = assemble(ctx, sw, 'shift');
      if (b && b.score.feasible && b.score.excluded === 0 && !b.candidate.affectedSegments.some(s => s.travel === 'unknown')) {
        push('swap', `「${target.title}」を近くの同種の場所「${near.name}」に差し替えた案`, b);
      }
    }
  }
  return out;
}
