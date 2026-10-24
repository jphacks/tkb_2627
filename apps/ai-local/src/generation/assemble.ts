import { createHash } from 'node:crypto';
import {
  PlanBatchCreate,
  SCHEMA_VERSION,
  type Activity,
  type CandidateBlueprint,
  type LocalDate,
  type PlaceInfo,
  type PlanBlueprint,
  type PlanCandidate,
  type PlanningContext,
  type TravelLeg,
  type TripConstraints,
  type TripDay,
  type ValidationState,
} from '@tkb/contracts';
import { groupNearby, sequenceDay, validateSchedule, type SequenceStop } from '@tkb/planner';
import type { StageFail } from '../jobs/index.ts';
import { VISITABLE_KINDS, tripDays, MAX_TRIP_DAYS } from './collect.ts';
import { INSUFFICIENT_PLACE_WARNING, LEG_REFETCH_WARNING, PLACE_REFETCH_WARNING, projectDays, projectPlace } from './project.ts';

export const DAY_START = '09:00';
export const DAY_END = '19:00';
export const STAY_MINUTES = { visit: 90, other: 60 } as const;
export const MAX_LEG_PAIRS = 8;
/** M1's cap on live Routes lookups for the whole job (all candidates together). The configured value can only lower it. */
export const MAX_LIVE_LEG_PAIRS = 6;
export const LIVE_DEPARTURE_WARNING = '移動時間は出発日の9:00発（出発時刻の指定があればその時刻）を想定して取得しています。';
const MAX_LIST = 10;
const MAX_TEXT = 200;
const MAX_ISSUES = 20;
export const UNTIMED_WARNING = '移動時間不明のため時刻未定';
export const MEAL_AFTER_MEAL_WARNING = '食事の直後に食べ物の予定が続いています。順序を確認してください。';
export const STAY_ASSUMPTION_WARNING = '滞在時間は仮定値です（観光90分、食事・散策60分）。実際の所要時間は未確認です。';

export type LegPair = { from: string; to: string };
/** Returns the legs it knows for the given pairs (fixture: from the K05 context; live: later from the route adapter). Never invents one. */
export type FetchLegs = (pairs: readonly LegPair[]) => Promise<readonly TravelLeg[]>;

const RANK: Record<ValidationState, number> = { valid: 0, needs_review: 1, needs_revalidation: 2, invalid: 3 };
const fail = (code: StageFail['code'], retryable = false): StageFail => ({ ok: false, code, retryable });
const sha8 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8);
const clip = (s: string) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s);
const clipList = (a: readonly string[]) => a.slice(0, MAX_LIST).map(clip);

function eachDate(start: LocalDate, end: LocalDate): LocalDate[] {
  const out: LocalDate[] = [];
  for (let t = Date.parse(start); t <= Date.parse(end); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

function activityFor(candidateId: string, place: PlaceInfo): Activity {
  const kind: Activity['kind'] = place.kind === 'restaurant' ? 'meal' : place.kind === 'area' ? 'free_walk' : 'visit';
  return {
    type: 'activity',
    activityId: `act_${candidateId}_${sha8(place.placeId)}`,
    kind,
    title: place.name,
    placeId: place.placeId,
    areaName: kind === 'free_walk' ? place.name : null,
    start: null,
    end: null,
    fixed: false,
    status: 'planned',
    cost: null, // never a guessed price
    costStatus: 'unknown',
    privateNotes: null,
  };
}

/** Consecutive pairs of a visiting order (from the start place first), de-duplicated, at most MAX_LEG_PAIRS. */
export function consecutivePairs(start: string | null, order: readonly string[], cap: number = MAX_LEG_PAIRS): LegPair[] {
  const seq = start === null ? [...order] : [start, ...order];
  const seen = new Set<string>();
  const out: LegPair[] = [];
  for (let i = 0; i + 1 < seq.length && out.length < cap; i++) {
    const k = `${seq[i]}|${seq[i + 1]}`;
    if (seq[i] !== seq[i + 1] && !seen.has(k)) {
      seen.add(k);
      out.push({ from: seq[i]!, to: seq[i + 1]! });
    }
  }
  return out;
}

interface Dropped {
  placeId: string;
  why: string;
}

/**
 * Turns one blueprint candidate into days: per date the planner places stops (opening hours, travel); what does not fit
 * moves to the next day. When travel to a stop is unknown, that stop and everything after it stay on the day without times.
 */
function planCandidateDays(
  stops: SequenceStop[],
  dates: readonly LocalDate[],
  constraints: TripConstraints,
  startPlaceId: string | null,
  places: readonly PlaceInfo[],
  travel: (from: string, to: string) => TravelLeg | null,
): { days: TripDay[]; dropped: Dropped[]; untimed: boolean } {
  const days: TripDay[] = [];
  const dropped: Dropped[] = [];
  let untimed = false;
  // Names in messages come from the storable projection: a message is stored with the candidate.
  const nameOf = new Map(places.map(p => [p.placeId, projectPlace(p).name]));
  const note = (a: Activity, why: string) => dropped.push({ placeId: a.placeId!, why: `「${nameOf.get(a.placeId!) ?? a.title}」は${why}ため除外しました。` });
  let queue = stops;
  for (const date of dates) {
    if (queue.length === 0) {
      days.push({ date, timeZone: constraints.timeZone, items: [] });
      continue;
    }
    const run = (list: SequenceStop[]) =>
      sequenceDay({ date, timeZone: constraints.timeZone, dayStart: DAY_START, dayEnd: DAY_END, startPlaceId, stops: list, places, travel: (f, t) => travel(f, t) });
    let r = run(queue);
    const cut = queue.findIndex(s => r.excluded.some(e => e.activityId === s.activity.activityId && e.reason === 'travel_unknown'));
    let rest: SequenceStop[] = [];
    if (cut >= 0) {
      rest = queue.slice(cut);
      r = run(queue.slice(0, cut));
      untimed = true;
    }
    const next: SequenceStop[] = [];
    for (const e of r.excluded) {
      const stop = queue.find(s => s.activity.activityId === e.activityId)!;
      if (e.reason === 'does_not_fit') next.push(stop);
      else note(stop.activity, e.reason === 'closed' ? '営業時間外の' : '時刻を決められない');
    }
    days.push({ date, timeZone: constraints.timeZone, items: [...r.day.items, ...rest.map(s => s.activity)] });
    queue = next;
  }
  for (const s of queue) note(s.activity, '日程に収まらない');
  return { days, dropped, untimed };
}

export interface AssembleOk {
  ok: true;
  batch: PlanBatchCreate;
  states: ValidationState[];
}

/**
 * Builds the K07 body from a parsed blueprint. Deterministic (no clock, stable order). Nothing is invented: cost stays
 * unknown, legs come only from the lookup, unknown travel leaves stops untimed, and the planner re-validates every candidate.
 */
export async function assembleBatch(
  blueprint: PlanBlueprint,
  ctx: PlanningContext,
  constraints: TripConstraints,
  operationKey: string,
  fetchLegs?: FetchLegs,
  opts: { maxLivePairs?: number } = {},
): Promise<AssembleOk | StageFail> {
  const ids = blueprint.candidates.map(c => c.candidateId);
  if (new Set(ids).size !== ids.length || ids.some(i => i.length > 100)) return fail('INVALID_OUTPUT', true);
  if (tripDays(constraints) > MAX_TRIP_DAYS) return fail('CONSTRAINT_UNSATISFIED');
  const placeById = new Map(ctx.places.map(p => [p.placeId, p]));
  const fromContext: FetchLegs = async pairs => ctx.legs.filter(l => pairs.some(p => p.from === l.fromPlaceId && p.to === l.toPlaceId));
  const legsFor = fetchLegs ?? fromContext;
  const dates = eachDate(constraints.startDate, constraints.endDate);
  const startPlaceId = constraints.departure?.placeId && placeById.has(constraints.departure.placeId) ? constraints.departure.placeId : null;

  for (const c of blueprint.candidates as CandidateBlueprint[]) {
    if (c.activityOrder.some(id => !placeById.has(id) || !VISITABLE_KINDS.has(placeById.get(id)!.kind))) return fail('INVALID_OUTPUT', true);
  }
  const byPair = new Map<string, TravelLeg>();
  const remember = (ls: readonly TravelLeg[]) => {
    for (const l of ls) if (!byPair.has(`${l.fromPlaceId}|${l.toPlaceId}`)) byPair.set(`${l.fromPlaceId}|${l.toPlaceId}`, l);
  };
  if (fetchLegs) {
    // Live lookups cost quota (M1: at most 6 Routes calls per JOB). Take the pairs of ALL candidates, round-robin so no
    // candidate starves, drop duplicates, cap, and ask once. Pairs beyond the cap stay unknown (stops without times).
    const cap = Math.min(opts.maxLivePairs ?? MAX_LIVE_LEG_PAIRS, MAX_LIVE_LEG_PAIRS);
    const lists = (blueprint.candidates as CandidateBlueprint[]).map(c => consecutivePairs(startPlaceId, c.activityOrder, MAX_LEG_PAIRS));
    const picked: LegPair[] = [];
    const seen = new Set<string>();
    for (let i = 0; picked.length < cap && lists.some(l => i < l.length); i++) {
      for (const l of lists) {
        const p = l[i];
        if (p && picked.length < cap && !seen.has(`${p.from}|${p.to}`)) {
          seen.add(`${p.from}|${p.to}`);
          picked.push(p);
        }
      }
    }
    if (picked.length > 0) remember(await fetchLegs(picked));
  }
  const candidates: PlanCandidate[] = [];
  const used = new Set<string>();
  for (const c of blueprint.candidates as CandidateBlueprint[]) {
    const order = c.activityOrder;
    if (!fetchLegs) remember(await legsFor(consecutivePairs(startPlaceId, order)));
    const travel = (f: string, t: string) => {
      const l = byPair.get(`${f}|${t}`);
      return l ? { ...l, departure: null, arrival: null } : null; // sample/fixture times are never a timetable
    };
    const stops: SequenceStop[] = order.map(pid => {
      const place = placeById.get(pid)!;
      return { activity: activityFor(c.candidateId, place), stayMinutes: place.kind === 'spot' ? STAY_MINUTES.visit : STAY_MINUTES.other };
    });
    const planned = planCandidateDays(stops, dates, constraints, startPlaceId, ctx.places, travel);
    // #32 R4: nearby / same-area stops become one parent with children, whatever Claude's order looked like.
    const plan = { ...planned, days: planned.days.map(d => groupNearby(d, ctx.places).day) };
    const check = (days: TripDay[], places: readonly PlaceInfo[]) =>
      validateSchedule({
        days,
        places,
        constraints: { startDate: constraints.startDate, endDate: constraints.endDate, mustVisit: constraints.mustVisit, budget: constraints.budget ?? null },
        dayStarts: days.map(() => ({ placeId: startPlaceId, time: null })),
      });
    const v = check(plan.days, ctx.places);
    // What is stored is the projection: provider content that may not be kept is removed first (D-1, D-2).
    const proj = projectDays(plan.days, placeById);
    const stored = proj.legsProjected || proj.placesProjected ? check(proj.days, ctx.places.map(projectPlace)) : v;
    const unseen = order.some(id => placeById.get(id)!.provenance.maySendToModel === false); // the model never saw these places' details
    // Food right after a meal is not reordered here (D06 offers no reorder): it is reported and never counts as valid.
    const mealAfterMeal = stored.issues.some(i => i.code === 'meal_after_meal');
    const forced: ValidationState = proj.legsProjected || proj.placesProjected || unseen || mealAfterMeal ? 'needs_review' : 'valid';
    const state: ValidationState = RANK[forced] > RANK[v.validationState] ? forced : v.validationState;

    const inDays = new Set<string>();
    for (const d of proj.days) {
      for (const it of d.items) {
        if (it.type === 'activity') it.placeId && inDays.add(it.placeId);
        else {
          inDays.add(it.fromPlaceId);
          inDays.add(it.toPlaceId);
        }
      }
    }
    for (const id of inDays) used.add(id);
    const excluded = [...new Set([...(c.excludedPlaceIds ?? []), ...plan.dropped.map(d => d.placeId)])].filter(id => !inDays.has(id));
    const ours = [
      STAY_ASSUMPTION_WARNING,
      ...(fetchLegs ? [LIVE_DEPARTURE_WARNING] : []),
      ...(plan.untimed ? [UNTIMED_WARNING] : []),
      ...(mealAfterMeal ? [MEAL_AFTER_MEAL_WARNING] : []),
      ...(proj.legsProjected ? [LEG_REFETCH_WARNING] : []),
      ...(proj.placesProjected ? [PLACE_REFETCH_WARNING] : []),
      ...(unseen ? [INSUFFICIENT_PLACE_WARNING] : []),
      ...plan.dropped.map(d => d.why),
      ...stored.issues.slice(0, MAX_ISSUES).map(i => i.message),
    ];
    candidates.push({
      candidateId: c.candidateId,
      title: clip((c.title ?? '').trim() || constraints.area),
      days: proj.days,
      reasons: clipList(c.reasons),
      warnings: [...clipList(c.warnings), ...[...new Set(ours)].map(clip)],
      excludedPlaceIds: excluded,
      totalKnownCost: stored.totalKnownCost,
      hasUnknownCost: stored.hasUnknownCost,
      validationState: state,
    });
  }

  const parsed = PlanBatchCreate.safeParse({
    schemaVersion: SCHEMA_VERSION,
    baseTripId: null,
    baseRevision: null,
    generationId: operationKey,
    candidates,
    places: ctx.places.filter(p => used.has(p.placeId)).map(projectPlace),
    constraints,
  });
  if (!parsed.success) return fail('INVALID_OUTPUT', true);
  return { ok: true, batch: parsed.data, states: candidates.map(c => c.validationState) };
}
