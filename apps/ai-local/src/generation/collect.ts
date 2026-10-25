import type { PlaceInfo, PlanningContext, TravelLeg, TripConstraints } from '@tkb/contracts';
import type { StageFail } from '../jobs/index.ts';
import type { ContextClient, UpstreamHolder } from '../shared-client/index.ts';

/** Place kinds a plan may visit. Stations etc. appear only as travel endpoints. */
export const VISITABLE_KINDS: ReadonlySet<PlaceInfo['kind']> = new Set(['spot', 'restaurant', 'area']);
export const MAX_TRIP_DAYS = 14;
export const CONTEXT_MAX_PLACES = 8;
/** Places asked for per trip day, so a longer trip has enough stops to fill its days (UI review on #33). */
export const CONTEXT_PLACES_PER_DAY = 7;
/** K05 accepts at most 30. */
export const contextMaxPlaces = (days: number) => Math.min(30, Math.max(CONTEXT_MAX_PLACES, CONTEXT_PLACES_PER_DAY * days));

const DAY_MS = 86_400_000;
export const tripDays = (c: Pick<TripConstraints, 'startDate' | 'endDate'>): number => Math.round((Date.parse(c.endDate) - Date.parse(c.startDate)) / DAY_MS) + 1;

export const nulled = (l: TravelLeg): TravelLeg => ({ ...l, departure: null, arrival: null });
const fail = (code: StageFail['code'], retryable = false): StageFail => ({ ok: false, code, retryable });

/**
 * K05 facts for a job, checked BEFORE any model run. Leg times are dropped (fixture/sample times are not a timetable;
 * the duration is kept). Provider content that may not be stored is NOT rejected here: it is used in memory only and the
 * stored batch holds its projection (project.ts), so a restricted source ends in needs_review, not in a failed job.
 */
export async function collectContext(
  client: ContextClient,
  session: UpstreamHolder,
  constraints: TripConstraints,
  signal: AbortSignal,
  now: () => number = Date.now, // kept for callers; storability is decided at projection
): Promise<{ ok: true; ctx: PlanningContext } | StageFail> {
  if (tripDays(constraints) > MAX_TRIP_DAYS) return fail('CONSTRAINT_UNSATISFIED');
  const must = [...new Set(constraints.mustVisit ?? [])];
  const r = await client.getPlanningContext(
    session,
    { area: constraints.area, transportMode: constraints.transportMode, maxPlaces: contextMaxPlaces(tripDays(constraints)), timeZone: constraints.timeZone, ...(must.length ? { placeIds: must } : {}) },
    signal,
  );
  if (!r.ok) return fail(r.code, r.retryable);

  void now;
  const places = r.context.places;
  const byId = new Map(places.map(p => [p.placeId, p]));
  for (const id of must) {
    const p = byId.get(id);
    if (!p || !VISITABLE_KINDS.has(p.kind)) return fail('CONSTRAINT_UNSATISFIED'); // never plan without a must-visit place
  }
  if (!places.some(p => VISITABLE_KINDS.has(p.kind))) return fail('CONSTRAINT_UNSATISFIED');

  const keep = new Set(places.map(p => p.placeId));
  const legs: TravelLeg[] = r.context.legs.filter(l => keep.has(l.fromPlaceId) && keep.has(l.toPlaceId)).map(nulled);
  return { ok: true, ctx: { ...r.context, places, legs } };
}
