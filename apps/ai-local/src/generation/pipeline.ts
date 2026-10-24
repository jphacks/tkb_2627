import type { PlanBatchCreate, PlanBlueprint, PlanningContext, TripConstraints } from '@tkb/contracts';
import type { GenerationPipeline, JobRequest } from '../jobs/index.ts';
import type { LocalSession } from '../auth/session.ts';
import type { ContextClient, PlanBatchClient } from '../shared-client/index.ts';
import { fromLocal } from '@tkb/planner';
import { assembleBatch, type FetchLegs } from './assemble.ts';
import { collectContext, nulled } from './collect.ts';
import { toGenerationInput } from './input.ts';

interface PipelineCtx {
  constraints: TripConstraints;
  context: PlanningContext;
}

const WALK_BELOW_M = 1000;
function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The instant a day's first stop could leave: 09:00 on the start date in the trip's zone (DST gap/overlap resolved to a real instant). */
function firstDepartureUtc(c: TripConstraints): string {
  const r = fromLocal(c.startDate, '09:00', c.timeZone);
  return r.kind === 'exact' ? r.utc : r.kind === 'ambiguous' ? r.later : r.after;
}

export interface PipelineDeps {
  contextClient: ContextClient;
  planClient: PlanBatchClient;
  /** The owner's live local session holding the upstream login (SessionStore). Never another user's. */
  sessions: { findUpstream(userId: string): LocalSession | null };
  now?: () => number;
}

/** K05 collect -> model input; blueprint -> K07 body; K07 save. Everything runs on the owner's own upstream session. */
export function createPipeline(deps: PipelineDeps): GenerationPipeline {
  return {
    async collect(ownerId: string, req: JobRequest, signal: AbortSignal) {
      const session = deps.sessions.findUpstream(ownerId);
      if (!session) return { ok: false, code: 'UNAUTHENTICATED', retryable: true };
      const c = await collectContext(deps.contextClient, session, req.constraints, signal, deps.now);
      if (!c.ok) return c;
      const ctx: PipelineCtx = { constraints: req.constraints, context: c.ctx };
      const sources = [...new Set([...c.ctx.places.map(p => p.provenance.source), ...c.ctx.legs.flatMap(l => (l.provenance ? [l.provenance.source] : []))])].sort();
      const info = { dataMode: c.ctx.dataMode, sources, places: c.ctx.places.length, legs: c.ctx.legs.length };
      return { ok: true, input: toGenerationInput(req.constraints, c.ctx), ctx, info };
    },
    async build(ownerId: string, blueprint: PlanBlueprint, ctx: unknown, operationKey: string, signal: AbortSignal) {
      const { constraints, context } = ctx as PipelineCtx;
      // Fixture: the legs came with the first K05 call. mixed/live: ask K05 (second call) for the segments the candidates use.
      const fetchLegs: FetchLegs | undefined =
        context.dataMode === 'fixture'
          ? undefined
          : async pairs => {
              const session = deps.sessions.findUpstream(ownerId);
              if (!session || pairs.length === 0) return [];
              const byId = new Map(context.places.map(p => [p.placeId, p]));
              const departureUtc = firstDepartureUtc(constraints);
              const legs = pairs.slice(0, 8).map(p => {
                const a = byId.get(p.from)?.location;
                const b = byId.get(p.to)?.location;
                const walk = a && b && distanceM(a, b) < WALK_BELOW_M;
                return { fromPlaceId: p.from, toPlaceId: p.to, departureUtc, mode: walk ? ('walk' as const) : constraints.transportMode };
              });
              const ids = [...new Set(pairs.flatMap(p => [p.from, p.to]))];
              const res = await deps.contextClient.getPlanningContext(
                session,
                { area: constraints.area, transportMode: constraints.transportMode, maxPlaces: 8, timeZone: constraints.timeZone, placeIds: ids, legs },
                signal,
              );
              return res.ok ? res.context.legs.map(nulled) : []; // unknown stays unknown: those stops end up without times
            };
      const r = await assembleBatch(blueprint, context, constraints, operationKey, fetchLegs);
      if (!r.ok) return r;
      return { ok: true, batch: r.batch, info: { candidates: r.batch.candidates.length, states: r.states } };
    },
    async save(ownerId: string, batch: PlanBatchCreate) {
      const session = deps.sessions.findUpstream(ownerId);
      if (!session) throw new Error('no upstream session');
      const r = await deps.planClient.savePlanBatch(session, batch);
      if (!r.ok) throw new Error(r.code); // the manager treats a failed save as an unknown outcome and consults the generationId lookup
      return { batchId: r.batchId };
    },
  };
}
