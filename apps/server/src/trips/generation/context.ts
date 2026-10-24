import type { DataMode, PlaceInfo, PlanningContext, PlanningContextRequest, Provenance, TravelLeg } from '@tkb/contracts';
import { PolicyError } from '@tkb/travel-data';
import type { ContextSources } from './sources.ts';

/** Most places one K05 reply carries, whatever the request asks (bounds legs and provider calls). */
export const MAX_CONTEXT_PLACES = 20;
const WALK_BELOW_M = 1000;

function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function dataModeOf(provs: readonly (Provenance | null)[], fallback: DataMode): DataMode {
  const kinds = new Set(provs.filter((p): p is Provenance => p !== null).map(p => (p.source === 'fixture' ? 'fixture' : 'live')));
  if (kinds.size === 0) return fallback;
  return kinds.size === 2 ? 'mixed' : kinds.has('fixture') ? 'fixture' : 'live';
}

/**
 * K05: places for the area (mustVisit ids first) and the legs between them, exactly as the sources returned them
 * (provenance unchanged). Nothing is invented: what could not be obtained is named in `unknown`.
 * Throws PolicyError for limits and cancellation; the caller maps it to an HTTP error.
 */
export async function buildPlanningContext(req: PlanningContextRequest, src: ContextSources, signal: AbortSignal, now: () => number = Date.now): Promise<PlanningContext> {
  const budget = src.budget(signal);
  const maxPlaces = Math.min(req.maxPlaces, MAX_CONTEXT_PLACES);
  const queries = req.legs ?? [];
  // Ids named by must-visit and by leg queries are resolved against the same area set.
  const wanted = [...new Set([...(req.placeIds ?? []), ...queries.flatMap(q => [q.fromPlaceId, q.toPlaceId])])];
  const found = await src.places.find({ area: req.area, maxPlaces: queries.length > 0 ? Math.min(MAX_CONTEXT_PLACES, Math.max(maxPlaces, wanted.length)) : maxPlaces, placeIds: wanted, timeZone: req.timeZone }, budget);
  const places: PlaceInfo[] = found.places.slice(0, MAX_CONTEXT_PLACES);
  const byId = new Map(places.map(p => [p.placeId, p]));
  const unknown = new Set<string>();
  if (places.length === 0) unknown.add('places');
  if ((req.placeIds ?? []).some(id => !byId.has(id))) unknown.add('mustVisit');

  const legs: TravelLeg[] = [];
  let missingLeg = false;
  const ask = async (from: PlaceInfo, to: PlaceInfo, departureUtc: string, mode: TravelLeg['mode']) => {
    if (signal.aborted) throw new PolicyError('CANCELLED', 'cancelled', false);
    const r = await src.routes!.route({ from, to, departureUtc, mode }, budget);
    if (r.leg) legs.push(r.leg);
    else missingLeg = true;
  };
  if (!src.routes) missingLeg = true;
  else if (queries.length > 0) {
    // Only the segments asked for (at most 8): this is the one path that spends live route calls.
    for (const q of queries) {
      const from = byId.get(q.fromPlaceId);
      const to = byId.get(q.toPlaceId);
      if (from && to) await ask(from, to, q.departureUtc, q.mode);
      else missingLeg = true;
    }
  } else if (src.mode === 'fixture') {
    // Fixture legs are in memory: look at every pair. Live routes are never fanned out like this.
    missingLeg = places.length < 2;
    const departureUtc = new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
    for (const from of places) {
      for (const to of places) {
        if (from.placeId === to.placeId) continue;
        const near = from.location && to.location && distanceM(from.location, to.location) < WALK_BELOW_M;
        await ask(from, to, departureUtc, near ? 'walk' : req.transportMode);
      }
    }
  } else missingLeg = true; // mixed/live: legs come from a follow-up request that names the segments
  if (missingLeg) unknown.add('legs');
  if (places.some(p => p.openingHours === null)) unknown.add('openingHours');
  if (legs.some(l => l.fare === null) || (legs.length === 0 && places.length > 1)) unknown.add('fare');
  if (legs.some(l => l.platform === null) || (legs.length === 0 && places.length > 1)) unknown.add('platform');

  const computed = dataModeOf([...places.map(p => p.provenance), ...legs.map(l => l.provenance)], src.mode);
  // mixed means fixture places with live routes even before any route was asked for.
  return { places, legs, unknown: [...unknown].sort(), dataMode: src.mode === 'mixed' ? 'mixed' : computed };
}
