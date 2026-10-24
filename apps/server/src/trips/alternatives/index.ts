import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  ApiError,
  ERROR_HTTP_STATUS,
  Id,
  Trip,
  TripDiff,
  TripOperation,
  TripPatchRequest,
  type ErrorCode,
} from '@tkb/contracts';
import { getTripForOwner, type Db } from '@tkb/db';
import { PolicyError } from '@tkb/travel-data';
import { requireActor } from '../../platform/auth/index.ts';
import type { SharedConfig } from '../../platform/config.ts';
import { applyOperations } from '../operations.ts';
import { createContextSources, type ContextSources } from '../generation/sources.ts';
import { createUserLimiter, dailyPerUserFromEnv, type UserLimiter } from '../generation/user-limit.ts';
import { limitRoutesPerUser, sharedUserRouteBudget, type UserRouteBudget } from '../generation/live-route-budget.ts';
import { LegBook } from './leg-book.ts';
import { unsourcedServiceLeg } from './ops-between.ts';
import { buildCandidates, type Candidate } from './plan.ts';

/**
 * POST /api/v1/trips/:id/alternatives (A05, Issue #29). Preview only: nothing is written, no revision is bumped.
 * Not in docs/03_CONTRACTS.md yet; the shapes below are local until M1 adds them (see the A05 report).
 */
export interface AlternativesRequest {
  expectedRevision: number;
  operations: TripOperation[];
  maxAlternatives?: number;
}

/**
 * `candidates[].trip` is the previewed itinerary for display. Its validationState is what PATCH will store
 * (needs_revalidation after a structural edit); the schedule check is in `validationState` of the candidate.
 * `diff` is exactly what K10 PATCH returns for `operations`.
 */
export interface AlternativesResult {
  tripId: string;
  baseRevision: number;
  candidates: (Omit<Candidate, 'operations'> & {
    /** Send these to PATCH /api/v1/trips/:id with expectedRevision = baseRevision to apply the candidate. null: not representable. */
    operations: TripOperation[] | null;
  })[];
}

/** Strict body: the K10 body (TripPatchRequest, unknown keys refused) plus optional maxAlternatives 1..3. */
function parseRequest(raw: unknown): AlternativesRequest | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { maxAlternatives, ...rest } = raw as Record<string, unknown>;
  if (maxAlternatives !== undefined && (typeof maxAlternatives !== 'number' || !Number.isInteger(maxAlternatives) || maxAlternatives < 1 || maxAlternatives > 3)) return null;
  const k10 = TripPatchRequest.safeParse(rest);
  return k10.success ? { ...k10.data, ...(maxAlternatives === undefined ? {} : { maxAlternatives }) } : null;
}

export interface AlternativesDeps {
  sources?: ContextSources;
  limiter?: UserLimiter;
  /** Per-user daily live Routes call budget, shared with K05. Default: the process-wide one. */
  routeBudget?: UserRouteBudget;
  now?: () => number;
}

function fail(reply: FastifyReply, requestId: string, code: ErrorCode, message: string, retryable = false, details?: Record<string, unknown>) {
  return reply.status(ERROR_HTTP_STATUS[code]).send(ApiError.parse({ code, message, retryable, requestId, ...(details ? { details } : {}) }));
}

const storable = (p: { mayStore: boolean; retainUntil: string | null }, nowMs: number) => p.mayStore && (p.retainUntil === null || Date.parse(p.retainUntil) > nowMs);

export function registerAlternatives(app: FastifyInstance, db: Db, config: Pick<SharedConfig, 'providerMode'>, deps: AlternativesDeps = {}): void {
  const sources = deps.sources ?? createContextSources(config);
  const limiter = deps.limiter ?? createUserLimiter({ perDay: dailyPerUserFromEnv() });
  const routeBudget = deps.routeBudget ?? sharedUserRouteBudget();
  const now = deps.now ?? Date.now;
  const active = new Set<string>(); // one preview at a time per user, in every mode

  app.post('/api/v1/trips/:id/alternatives', { preHandler: app.authenticate, onSend: async (_r, reply) => void reply.header('cache-control', 'no-store') }, async (req, reply) => {
    const { userId } = requireActor(req);
    const id = Id.safeParse((req.params as { id: string }).id);
    const trip = id.success ? getTripForOwner(db, id.data, userId) : null;
    if (!trip) return fail(reply, req.id, 'NOT_FOUND', 'Not found.');
    const body = parseRequest(req.body);
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
    const applied = applyOperations(trip, body.operations);
    if (!applied.ok) {
      return fail(reply, req.id, 'CONSTRAINT_UNSATISFIED', 'Operation not applicable.', false, { operationIndex: applied.index, reason: applied.reason });
    }

    // Only a live/mixed run spends provider calls, so only it is rate limited per user (shared with K05's rules, own counter).
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
      const places = new Map(trip.places.map(p => [p.placeId, p]));
      const limited = sources.routes && sources.mode !== 'fixture' ? limitRoutesPerUser(sources.routes, userId, routeBudget) : null;
      const book = new LegBook({ routes: limited ?? sources.routes, budget: sources.budget(ctl.signal), signal: ctl.signal, free: sources.mode === 'fixture', places });
      book.seed(trip);
      const built = await buildCandidates({ base: trip, edited: applied.trip, ops: body.operations, book, places, nowMs }, body.maxAlternatives ?? 3);
      const notice = '本日のライブ経路検索の上限に達したため、一部の移動は不明のままです。';
      if (limited?.exhausted()) {
        for (const c of built) {
          c.warnings = [...new Set([...c.warnings, notice])];
          c.trip = { ...c.trip, warnings: c.warnings };
          c.unknown = [...new Set([...c.unknown, 'legs'])].sort();
        }
      }
      const candidates = built.map(c => {
        const candidateId = 'alt_' + createHash('sha256').update(`${trip.tripId}|${trip.revision}|${c.kind}|${JSON.stringify(c.trip.days)}`).digest('hex').slice(0, 24);
        return { ...c, candidateId };
      });
      // Not stored, not sent to a model. Live legs stay in `trip` for display only (like K05); `operations` never carries them.
      const result: AlternativesResult = {
        tripId: trip.tripId,
        baseRevision: trip.revision,
        candidates: candidates.map(c => ({ ...c, trip: Trip.parse(c.trip), diff: TripDiff.parse(c.diff) })),
      };
      return result;
    } catch (e) {
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
