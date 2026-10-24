import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { ApiError, ERROR_HTTP_STATUS, Id, ReplanResult, type ErrorCode } from '@tkb/contracts';
import { getTripForOwner, type Db } from '@tkb/db';
import { PolicyError, type RouteUnknownReason } from '@tkb/travel-data';
import { requireActor } from '../../platform/auth/index.ts';
import type { SharedConfig } from '../../platform/config.ts';
import { applyOperations } from '../operations.ts';
import { createContextSources, type ContextSources } from '../generation/sources.ts';
import { createUserLimiter, dailyPerUserFromEnv, type UserLimiter } from '../generation/user-limit.ts';
import { limitRoutesPerUser, sharedUserRouteBudget, type UserRouteBudget } from '../generation/live-route-budget.ts';
import { LegBook } from '../alternatives/leg-book.ts';
import { unsourcedServiceLeg } from '../alternatives/ops-between.ts';
import { planReplan, ReplanError } from './plan.ts';
import { recordingRoutes } from './routes.ts';
import { parseReplanRequest } from './schema.ts';

export type { ReplanResult } from './schema.ts';

export interface ReplanDeps {
  sources?: ContextSources;
  limiter?: UserLimiter;
  /** Per-user daily live Routes call budget, shared with K05 and A05. Default: the process-wide one. */
  routeBudget?: UserRouteBudget;
  /** Server clock (ms). The client never sends the time. */
  now?: () => number;
}

function fail(reply: FastifyReply, requestId: string, code: ErrorCode, message: string, retryable = false, details?: Record<string, unknown>) {
  return reply.status(ERROR_HTTP_STATUS[code]).send(ApiError.parse({ code, message, retryable, requestId, ...(details ? { details } : {}) }));
}

const storable = (p: { mayStore: boolean; retainUntil: string | null }, nowMs: number) => p.mayStore && (p.retainUntil === null || Date.parse(p.retainUntil) > nowMs);

/**
 * POST /api/v1/trips/:id/replan (A06, Issue #30). Preview only: nothing is written, no revision is bumped, no model is
 * called. Apply a candidate by sending its `operations` to PATCH /api/v1/trips/:id with expectedRevision = baseRevision.
 */
export function registerReplan(app: FastifyInstance, db: Db, config: Pick<SharedConfig, 'providerMode'>, deps: ReplanDeps = {}): void {
  const sources = deps.sources ?? createContextSources(config);
  const limiter = deps.limiter ?? createUserLimiter({ perDay: dailyPerUserFromEnv() });
  const routeBudget = deps.routeBudget ?? sharedUserRouteBudget();
  const now = deps.now ?? Date.now;
  const active = new Set<string>(); // one preview at a time per user, in every mode

  app.post('/api/v1/trips/:id/replan', { preHandler: app.authenticate, onSend: async (_r, reply) => void reply.header('cache-control', 'no-store') }, async (req, reply) => {
    const { userId } = requireActor(req);
    const id = Id.safeParse((req.params as { id: string }).id);
    const trip = id.success ? getTripForOwner(db, id.data, userId) : null;
    if (!trip) return fail(reply, req.id, 'NOT_FOUND', 'Not found.');
    const body = parseReplanRequest(req.body);
    if (!body) return fail(reply, req.id, 'VALIDATION_FAILED', 'Invalid request.');
    if (trip.revision !== body.expectedRevision) {
      return fail(reply, req.id, 'REVISION_CONFLICT', 'Trip was changed.', false, { expectedRevision: body.expectedRevision, currentRevision: trip.revision });
    }
    const nowMs = now();
    for (const op of body.operations) {
      if ((op.op === 'add' || op.op === 'update') && unsourcedServiceLeg(op.item)) return fail(reply, req.id, 'RESTRICTED_ASSET', 'Data may not be stored.');
      if ((op.op === 'add' || op.op === 'update') && op.item.type === 'leg' && op.item.provenance && !storable(op.item.provenance, nowMs)) {
        return fail(reply, req.id, 'RESTRICTED_ASSET', 'Data may not be stored.');
      }
    }
    const applied = body.operations.length > 0 ? applyOperations(trip, body.operations) : { ok: true as const, trip };
    if (!applied.ok) {
      return fail(reply, req.id, 'CONSTRAINT_UNSATISFIED', 'Operation not applicable.', false, { operationIndex: applied.index, reason: applied.reason });
    }

    // Only a live/mixed run spends provider calls, so only it is rate limited per user (own counter, like A05).
    if (active.has(userId)) return fail(reply, req.id, 'RATE_LIMITED', 'Too many requests.', true);
    let release: (() => void) | null = null;
    if (sources.mode !== 'fixture') {
      const slot = limiter.acquire(userId);
      if (slot === 'busy' || slot === 'daily') return fail(reply, req.id, 'RATE_LIMITED', 'Too many requests.', slot === 'busy');
      release = slot;
    }
    active.add(userId);
    const ctl = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableFinished) ctl.abort();
    };
    reply.raw.on('close', onClose);
    try {
      const places = new Map(applied.trip.places.map(p => [p.placeId, p]));
      const limited = sources.routes && sources.mode !== 'fixture' ? limitRoutesPerUser(sources.routes, userId, routeBudget) : null;
      const inner = limited ?? sources.routes;
      const reasons = new Map<string, RouteUnknownReason>();
      const book = new LegBook({ routes: inner ? recordingRoutes(inner, reasons) : null, budget: sources.budget(ctl.signal), signal: ctl.signal, free: sources.mode === 'fixture', places });
      book.seed(trip);
      const out = await planReplan({ base: trip, edited: applied.trip, req: body, book, places, reasons, nowMs });
      const c = out.candidate;
      if (limited?.exhausted()) {
        c.warnings = [...new Set([...c.warnings, '本日のライブ経路検索の上限に達したため、一部の移動は不明のままです。'])];
        c.trip = { ...c.trip, warnings: c.warnings };
        c.unknown = [...new Set([...c.unknown, 'legs'])].sort();
      }
      const candidateId = 'rpl_' + createHash('sha256').update(`${trip.tripId}|${trip.revision}|${c.kind}|${JSON.stringify(c.trip.days)}`).digest('hex').slice(0, 24);
      // Not stored, not sent to a model. Live legs stay in `trip` for display only; `operations` never carries them.
      const result = ReplanResult.parse({
        tripId: trip.tripId,
        baseRevision: trip.revision,
        now: new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        dayIndex: out.dayIndex,
        start: out.start,
        startLeg: out.startLeg,
        candidates: [{ ...c, candidateId }],
      });
      return result;
    } catch (e) {
      if (e instanceof ReplanError) return fail(reply, req.id, e.code, e.message, false, e.details);
      if (e instanceof PolicyError && e.code === 'CANCELLED') {
        reply.hijack();
        reply.raw.destroy();
        return reply;
      }
      throw e;
    } finally {
      reply.raw.off('close', onClose);
      release?.();
      active.delete(userId);
    }
  });
}
