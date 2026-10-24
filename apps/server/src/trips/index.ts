import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  ApiError,
  ApplyCandidateRequest,
  ERROR_HTTP_STATUS,
  Id,
  PlanBatch,
  PlanBatchCreate,
  PlanBatchCreated,
  PlanCandidate,
  Trip,
  TripList,
  TripPatchRequest,
  TripPatchResult,
  TripSummary,
  TripWriteResult,
  type ErrorCode,
  type TripConstraints,
  type ValidationState,
} from '@tkb/contracts';
import { getTripForOwner, insertTrip, transaction, updateTripWithRevision, type Db } from '@tkb/db';
import { requireActor } from '../platform/auth/index.ts';
import type { SharedConfig } from '../platform/config.ts';
import { applyOperations, computeDiff } from './operations.ts';

function fail(
  reply: FastifyReply,
  requestId: string,
  code: ErrorCode,
  message: string,
  retryable = false,
  details?: Record<string, unknown>,
) {
  return reply
    .status(ERROR_HTTP_STATUS[code])
    .send(ApiError.parse({ code, message, retryable, requestId, ...(details ? { details } : {}) }));
}

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

const STATE_RANK: Record<ValidationState, number> = { valid: 0, needs_review: 1, needs_revalidation: 2, invalid: 3 };
const worst = (a: ValidationState[]): ValidationState =>
  a.reduce<ValidationState>((w, s) => (STATE_RANK[s] > STATE_RANK[w] ? s : w), 'valid');

interface BatchRow {
  id: string;
  owner_id: string;
  base_trip_id: string | null;
  base_revision: number | null;
  generation_id: string;
  candidates_json: string;
  places_json: string;
  created_at: string;
}

function loadBatch(db: Db, batchId: string, ownerId: string) {
  const row = db
    .prepare('SELECT * FROM plan_batches WHERE id = ? AND owner_id = ?')
    .get(batchId, ownerId) as BatchRow | undefined;
  if (!row) return null;
  return {
    row,
    batch: PlanBatch.parse({
      batchId: row.id,
      baseTripId: row.base_trip_id,
      baseRevision: row.base_revision,
      candidates: JSON.parse(row.candidates_json),
      places: JSON.parse(row.places_json),
      createdAt: row.created_at,
    }),
  };
}

/** Server-side re-check: a client "valid" is downgraded when structure is inconsistent. */
function reviewCandidate(c: PlanCandidate, placeIds: Set<string>): ValidationState {
  if (c.validationState !== 'valid') return c.validationState;
  const seen = new Set<string>();
  for (const day of c.days) {
    for (const it of day.items) {
      const id = it.type === 'activity' ? it.activityId : it.legId;
      if (seen.has(id)) return 'needs_review';
      seen.add(id);
      const refs = it.type === 'activity' ? [it.placeId] : [it.fromPlaceId, it.toPlaceId];
      if (refs.some((r) => r !== null && !placeIds.has(r))) return 'needs_review';
      if (it.type === 'activity' && it.start && it.end && it.end.utc < it.start.utc) return 'needs_review';
    }
  }
  return 'valid';
}

function constraintsFor(c: PlanCandidate, base: Trip | null): TripConstraints | null {
  if (base) return base.constraints;
  const first = c.days[0];
  const last = c.days[c.days.length - 1];
  if (!first || !last) return null;
  const legs = c.days.flatMap((d) => d.items).filter((i) => i.type === 'leg');
  // Candidates carry no constraints (contract gap): derive the minimum and never invent a budget.
  return {
    area: c.title.slice(0, 200) || 'unknown',
    startDate: first.date,
    endDate: last.date < first.date ? first.date : last.date,
    timeZone: first.timeZone,
    transportMode: legs.some((l) => l.mode === 'car') ? 'car' : 'transit',
  };
}

function parseListQuery(q: unknown): { limit: number; cursor?: string } | null {
  const o = (q ?? {}) as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== 'limit' && k !== 'cursor')) return null;
  let limit = 50;
  if (o.limit !== undefined) {
    if (typeof o.limit !== 'string' || !/^\d{1,3}$/.test(o.limit)) return null;
    limit = Number(o.limit);
    if (limit < 1 || limit > 100) return null;
  }
  if (o.cursor !== undefined && (typeof o.cursor !== 'string' || o.cursor.length > 300)) return null;
  return { limit, cursor: o.cursor as string | undefined };
}

/** K07-K10. Owner always comes from the session; other owners' resources are indistinguishable from missing ones. */
export function registerTrips(app: FastifyInstance, db: Db, _config: SharedConfig): void {
  const pre = { preHandler: app.authenticate };

  app.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/api/v1/trips') || req.url.startsWith('/api/v1/plan-batches')) {
      reply.header('cache-control', 'no-store');
    }
  });

  // K07
  app.post('/api/v1/plan-batches', pre, async (req, reply) => {
    const { userId } = requireActor(req);
    const body = PlanBatchCreate.safeParse(req.body);
    if (!body.success) return fail(reply, req.id, 'VALIDATION_FAILED', 'Invalid request.');
    const input = body.data;
    const ids = input.candidates.map((c) => c.candidateId);
    if (new Set(ids).size !== ids.length) return fail(reply, req.id, 'VALIDATION_FAILED', 'Duplicate candidateId.');
    const now = nowIso();
    if (input.places.some((p) => !p.provenance.mayStore || (p.provenance.retainUntil !== null && p.provenance.retainUntil < now))) {
      return fail(reply, req.id, 'RESTRICTED_ASSET', 'A place may not be stored.');
    }
    if (input.baseTripId !== null) {
      const base = getTripForOwner(db, input.baseTripId, userId);
      if (!base || input.baseRevision === null) return fail(reply, req.id, base ? 'VALIDATION_FAILED' : 'NOT_FOUND', base ? 'Invalid request.' : 'Not found.');
      if (base.revision !== input.baseRevision) {
        return fail(reply, req.id, 'REVISION_CONFLICT', 'Base trip changed.', false, {
          expectedRevision: input.baseRevision,
          currentRevision: base.revision,
        });
      }
    } else if (input.baseRevision !== null) {
      return fail(reply, req.id, 'VALIDATION_FAILED', 'Invalid request.');
    }
    const placeIds = new Set(input.places.map((p) => p.placeId));
    const candidates = input.candidates.map((c) => ({ ...c, validationState: reviewCandidate(c, placeIds) }));
    const state = worst(candidates.map((c) => c.validationState));
    const candidatesJson = JSON.stringify(candidates);
    const placesJson = JSON.stringify(input.places);

    type Outcome = { status: 200 | 201; created: PlanBatchCreated } | 'CONFLICT';
    const out = transaction(db, (): Outcome => {
      const prev = db
        .prepare('SELECT * FROM plan_batches WHERE owner_id = ? AND generation_id = ?')
        .get(userId, input.generationId) as BatchRow | undefined;
      if (prev) {
        const same =
          prev.candidates_json === candidatesJson &&
          prev.places_json === placesJson &&
          prev.base_trip_id === input.baseTripId &&
          prev.base_revision === input.baseRevision;
        if (!same) return 'CONFLICT';
        const pc = JSON.parse(prev.candidates_json) as PlanCandidate[];
        return {
          status: 200,
          created: { batchId: prev.id, candidateIds: pc.map((c) => c.candidateId), validationState: worst(pc.map((c) => c.validationState)) },
        };
      }
      const batchId = randomUUID();
      db.prepare(
        `INSERT INTO plan_batches (id, owner_id, base_trip_id, base_revision, generation_id, schema_version,
          candidates_json, places_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(batchId, userId, input.baseTripId, input.baseRevision, input.generationId, input.schemaVersion, candidatesJson, placesJson, now);
      return { status: 201, created: { batchId, candidateIds: ids, validationState: state } };
    });
    if (out === 'CONFLICT') return fail(reply, req.id, 'IDEMPOTENCY_CONFLICT', 'generationId already used with different content.');
    return reply.status(out.status).send(PlanBatchCreated.parse(out.created));
  });

  app.get('/api/v1/plan-batches/:id', pre, async (req, reply) => {
    const { userId } = requireActor(req);
    const id = Id.safeParse((req.params as { id: string }).id);
    const found = id.success ? loadBatch(db, id.data, userId) : null;
    if (!found) return fail(reply, req.id, 'NOT_FOUND', 'Not found.');
    return found.batch;
  });

  // K08
  app.post('/api/v1/trips/apply-candidate', pre, async (req, reply) => {
    const { userId } = requireActor(req);
    const body = ApplyCandidateRequest.safeParse(req.body);
    if (!body.success) return fail(reply, req.id, 'VALIDATION_FAILED', 'Invalid request.');
    const r = body.data;
    const found = loadBatch(db, r.batchId, userId);
    const cand = found?.batch.candidates.find((c) => c.candidateId === r.candidateId);
    if (!found || !cand) return fail(reply, req.id, 'NOT_FOUND', 'Not found.');
    const { batch } = found;
    if (cand.validationState === 'invalid' || cand.validationState === 'needs_revalidation') {
      return fail(reply, req.id, 'CONSTRAINT_UNSATISFIED', 'Candidate has not been validated.');
    }
    const now = nowIso();
    let existing: Trip | null = null;
    if (r.tripId !== null) {
      existing = getTripForOwner(db, r.tripId, userId);
      if (!existing) return fail(reply, req.id, 'NOT_FOUND', 'Not found.');
      if (r.expectedRevision === null) return fail(reply, req.id, 'VALIDATION_FAILED', 'expectedRevision is required.');
      if (batch.baseTripId !== null && batch.baseTripId !== r.tripId) {
        return fail(reply, req.id, 'VALIDATION_FAILED', 'Candidate was not generated for this trip.');
      }
    } else if (r.expectedRevision !== null) {
      return fail(reply, req.id, 'VALIDATION_FAILED', 'Invalid request.');
    }
    const base = existing ?? (batch.baseTripId ? getTripForOwner(db, batch.baseTripId, userId) : null);
    const constraints = constraintsFor(cand, base);
    if (!constraints) return fail(reply, req.id, 'CONSTRAINT_UNSATISFIED', 'Candidate has no days.');
    const doc = {
      schemaVersion: 1 as const,
      tripId: existing?.tripId ?? randomUUID(),
      ownerId: userId,
      title: cand.title.slice(0, 200) || 'Untitled',
      revision: 1,
      constraints,
      days: cand.days,
      places: batch.places,
      validationState: cand.validationState,
      warnings: cand.warnings,
      createdAt: now,
      updatedAt: now,
    };
    const parsed = Trip.safeParse(doc);
    if (!parsed.success) return fail(reply, req.id, 'CONSTRAINT_UNSATISFIED', 'Candidate cannot become a trip.');
    if (!existing) {
      const trip = insertTrip(db, userId, parsed.data, now);
      return reply.status(201).send(TripWriteResult.parse({ tripId: trip.tripId, revision: trip.revision, trip, warnings: trip.warnings }));
    }
    const res = updateTripWithRevision(db, userId, parsed.data, r.expectedRevision!, now);
    if (!res.ok) {
      if (res.code === 'NOT_FOUND') return fail(reply, req.id, 'NOT_FOUND', 'Not found.');
      return fail(reply, req.id, 'REVISION_CONFLICT', 'Trip was changed.', false, {
        expectedRevision: r.expectedRevision,
        currentRevision: res.currentRevision,
      });
    }
    return TripWriteResult.parse({ tripId: res.trip.tripId, revision: res.revision, trip: res.trip, warnings: res.trip.warnings });
  });

  // K09
  app.get('/api/v1/trips', pre, async (req, reply) => {
    const { userId } = requireActor(req);
    const q = parseListQuery(req.query);
    if (!q) return fail(reply, req.id, 'VALIDATION_FAILED', 'Invalid request.');
    let after: { at: string; id: string } | null = null;
    if (q.cursor) {
      try {
        const [at, id] = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')) as [string, string];
        if (typeof at !== 'string' || typeof id !== 'string') throw new Error('bad');
        after = { at, id };
      } catch {
        return fail(reply, req.id, 'VALIDATION_FAILED', 'Invalid cursor.');
      }
    }
    const limit = q.limit;
    const rows = db
      .prepare(
        `SELECT id, title, revision, validation_state, updated_at, constraints_json FROM trips
         WHERE owner_id = ? AND deleted_at IS NULL AND (? IS NULL OR updated_at < ? OR (updated_at = ? AND id < ?))
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
      )
      .all(userId, after?.at ?? null, after?.at ?? null, after?.at ?? null, after?.id ?? null, limit + 1) as {
      id: string;
      title: string;
      revision: number;
      validation_state: string;
      updated_at: string;
      constraints_json: string;
    }[];
    const page = rows.slice(0, limit);
    const items = page.map((r) => {
      const c = JSON.parse(r.constraints_json) as TripConstraints;
      return TripSummary.parse({
        tripId: r.id,
        title: r.title,
        revision: r.revision,
        validationState: r.validation_state,
        updatedAt: r.updated_at,
        area: c.area,
        startDate: c.startDate,
        endDate: c.endDate,
      });
    });
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > limit && last ? Buffer.from(JSON.stringify([last.updated_at, last.id])).toString('base64url') : null;
    return TripList.parse({ items, nextCursor });
  });

  app.get('/api/v1/trips/:id', pre, async (req, reply) => {
    const { userId } = requireActor(req);
    const id = Id.safeParse((req.params as { id: string }).id);
    const trip = id.success ? getTripForOwner(db, id.data, userId) : null;
    if (!trip) return fail(reply, req.id, 'NOT_FOUND', 'Not found.');
    return Trip.parse(trip);
  });

  // K10
  app.patch('/api/v1/trips/:id', pre, async (req, reply) => {
    const { userId } = requireActor(req);
    const id = Id.safeParse((req.params as { id: string }).id);
    const trip = id.success ? getTripForOwner(db, id.data, userId) : null;
    if (!trip) return fail(reply, req.id, 'NOT_FOUND', 'Not found.');
    const body = TripPatchRequest.safeParse(req.body);
    if (!body.success) return fail(reply, req.id, 'VALIDATION_FAILED', 'Invalid request.');
    const conflict = (current: number) =>
      fail(reply, req.id, 'REVISION_CONFLICT', 'Trip was changed.', false, {
        expectedRevision: body.data.expectedRevision,
        currentRevision: current,
      });
    if (trip.revision !== body.data.expectedRevision) return conflict(trip.revision);
    const applied = applyOperations(trip, body.data.operations);
    if (!applied.ok) {
      return fail(reply, req.id, 'CONSTRAINT_UNSATISFIED', 'Operation not applicable.', false, {
        operationIndex: applied.index,
        reason: applied.reason,
      });
    }
    const candidate = Trip.safeParse(applied.trip);
    if (!candidate.success) return fail(reply, req.id, 'CONSTRAINT_UNSATISFIED', 'Operation produces an invalid trip.');
    const res = updateTripWithRevision(db, userId, candidate.data, body.data.expectedRevision, nowIso());
    if (!res.ok) return res.code === 'NOT_FOUND' ? fail(reply, req.id, 'NOT_FOUND', 'Not found.') : conflict(res.currentRevision);
    const warnings =
      res.trip.validationState === 'needs_revalidation' && !res.trip.warnings.includes(RECHECK)
        ? [...res.trip.warnings, RECHECK]
        : res.trip.warnings;
    return TripPatchResult.parse({
      tripId: res.trip.tripId,
      revision: res.revision,
      trip: res.trip,
      warnings,
      diff: computeDiff(trip, res.trip),
    });
  });
}

const RECHECK = '移動情報を再確認してください';