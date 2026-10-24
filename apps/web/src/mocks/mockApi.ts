/**
 * In-memory mock of the screen-facing APIs (K01, K02, K07, K08, K09, K10, K14, K21).
 *
 * - No network, no browser storage: state lives in the closure and starts from structuredClone'd fixtures.
 * - Every success response is parsed with the @tkb/contracts schema before it is returned, so the mock
 *   cannot drift from the contract. Request bodies are parsed the same way (strict schemas reject unknown
 *   keys). Id arguments and error responses are only typed, not parsed at runtime.
 * - Every result carries `source: 'mock'`; screens must show MOCK_NOTICE.
 * - Unknown cost stays null. It is never turned into 0 (R11).
 *
 * Known differences from the main implementation (screens must not depend on them):
 * - K01: main rejects baseTripId, expectedRevision and mode=replan with 422 until A04; the mock accepts
 *   them and returns 404/409. generate ignores the request and returns the Kanazawa candidates.
 *   No Idempotency-Key.
 * - K07: only GET. Batches are created by generate and the seed data; constraints are kept inside.
 * - K08: main returns 422 for invalid/needs_revalidation candidates, a missing batch constraints, or a
 *   baseTripId mismatch, 409 for a baseRevision mismatch, and the same trip when a candidate is applied
 *   again. The mock does none of these.
 * - K10: durationDeltaSeconds is the sum of item durations (main uses the span of each day). Unknown
 *   placeIds and item type changes are not rejected.
 * - K14: no authorization. 'mine' is the demo user's posts and 'groups' is always empty.
 * - K21: cancelling a succeeded job is 409 ALREADY_COMMITTED (main returns 200). No saving stage.
 */
import {
  ApplyCandidateRequest,
  CancelResult,
  Feed,
  FeedQuery,
  GenerateRequest,
  JobAccepted,
  JobStatus,
  PlanBatch,
  Trip,
  TripList,
  TripPatchRequest,
  TripPatchResult,
  TripWriteResult,
} from '@tkb/contracts';
import type {
  ApiError,
  ErrorCode,
  ItineraryItem,
  Money,
  PlanCandidate,
  PostSummary,
  TripConstraints,
  TripDiff,
  TripOperation,
} from '@tkb/contracts';
import { ERROR_HTTP_STATUS } from '@tkb/contracts';
import {
  createBudgetUnknownOverseasTrip,
  createBudgetUnknownPlanBatch,
  createBudgetUnknownTrip,
  createCarTrip,
  createSamplePlanBatch,
  createSampleFeedPosts,
  domesticTrip,
  fixtureTrips,
  sampleApiErrors,
  summarizeKnownCost,
} from '@tkb/fixtures';
import type { z } from 'zod';

export const MOCK_NOTICE = 'モックAPIのデータです。実際の保存・生成・通信は行っていません。';
export const MOCK_SOURCE = 'mock' as const;
/** Added to every generated candidate: the mock ignores the requested conditions. */
export const GENERATE_MOCK_WARNING = 'モック：入力条件に関わらず金沢のサンプル候補（fixture）を返しています。';
/** Owner id used for trips created by the mock. */
export const MOCK_USER_ID = 'fx_user_a';
/** Author name in the feed fixture that the 'mine' scope returns. */
export const MOCK_USER_DISPLAY_NAME = 'デモ利用者A';

export type MockScenario = 'normal' | 'empty' | 'error' | 'slow' | 'budgetUnknown';

export interface MockApiOptions {
  scenario?: MockScenario;
  /** Delay before every response. Default 800 for 'slow', otherwise 0. Tests keep it at 0. */
  delayMs?: number;
  /** How many getJob polls each job step lasts. Default 3 for 'slow', otherwise 1. */
  pollsPerStep?: number;
  /** `pollAfterMs` returned by generate (K01). Default 2000. */
  pollAfterMs?: number;
  /** Clock for timestamps. Default: the real clock. */
  now?: () => Date;
  /** Replaceable delay function, e.g. for fake timers. Default: setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Result of every mock call. `status` is the HTTP status the real API would use
 * (ERROR_HTTP_STATUS for errors). Use toProbe() to get the `Probe<T>` shape of lib/api.ts.
 */
export type MockResult<T> =
  | { ok: true; data: T; source: typeof MOCK_SOURCE; status: number }
  | { ok: false; error: ApiError; source: typeof MOCK_SOURCE; status: number };

/** Converts to the `Probe<T>` of lib/api.ts (error becomes the message text). */
export function toProbe<T>(result: MockResult<T>): { ok: true; data: T } | { ok: false; error: string } {
  return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error.message };
}

type ClientInput<S extends z.ZodType> = z.input<S>;

interface JobStep {
  state: 'queued' | 'running' | 'succeeded' | 'failed';
  stage: JobStatus['stage'];
  error?: NonNullable<JobStatus['error']>;
}

const NORMAL_STEPS: JobStep[] = [
  { state: 'queued', stage: 'queued' },
  { state: 'running', stage: 'collecting_context' },
  { state: 'running', stage: 'generating' },
  { state: 'running', stage: 'validating' },
  { state: 'succeeded', stage: 'saved' },
];

const ERROR_STEPS: JobStep[] = [
  { state: 'queued', stage: 'queued' },
  { state: 'running', stage: 'collecting_context' },
  { state: 'running', stage: 'generating' },
  {
    state: 'failed',
    stage: 'validating',
    error: {
      code: 'INVALID_OUTPUT',
      message: sampleApiErrors.INVALID_OUTPUT.message,
      retryable: true,
      requestId: 'req_mock_job_failed',
    },
  },
];

interface JobRecord {
  jobId: string;
  steps: JobStep[];
  polls: number;
  current: JobStep;
  cancelled: boolean;
  batch: PlanBatch;
  constraints: TripConstraints;
  registered: boolean;
}

interface BatchRecord {
  batch: PlanBatch;
  constraints: TripConstraints;
}

function itemId(item: ItineraryItem): string {
  return item.type === 'activity' ? item.activityId : item.legId;
}

function moneyOf(item: ItineraryItem): Money | null {
  return item.type === 'activity' ? item.cost : item.fare;
}

/** Seconds an item takes when known: leg duration, or activity end - start. */
function durationOf(item: ItineraryItem): number | null {
  if (item.type === 'leg') return item.durationSeconds;
  if (item.start === null || item.end === null) return null;
  return Math.round((Date.parse(item.end.utc) - Date.parse(item.start.utc)) / 1000);
}

function allItems(trip: Trip): ItineraryItem[] {
  return trip.days.flatMap(d => d.items);
}

function sumKnownDurations(trip: Trip): number {
  return allItems(trip).reduce((sum, item) => sum + (durationOf(item) ?? 0), 0);
}

/** Ids of items whose cost is unknown. Walking legs have no fare, so they are not unknown (same as main K10). */
function unknownCostIds(trip: Trip): string[] {
  return allItems(trip)
    .filter(item => (item.type === 'activity' ? item.cost === null : item.mode !== 'walk' && item.fare === null))
    .map(itemId);
}

function knownCostByCurrency(trip: Trip): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of allItems(trip)) {
    const money = moneyOf(item);
    if (money) map.set(money.currency, (map.get(money.currency) ?? 0) + money.amountMinor);
  }
  return map;
}

/** Candidate days with transit legs switched to car legs (no fare: fuel and tolls are unknown). */
function candidateForCar(c: PlanCandidate): PlanCandidate {
  const days = c.days.map(day => ({
    ...day,
    items: day.items.map(item =>
      item.type === 'leg' && item.mode === 'transit' ? { ...item, mode: 'car' as const, lineName: null, fare: null } : item,
    ),
  }));
  return { ...c, days, ...summarizeKnownCost(days) };
}

export function createMockApi(options: MockApiOptions = {}) {
  const scenario: MockScenario = options.scenario ?? 'normal';
  const delayMs = options.delayMs ?? (scenario === 'slow' ? 800 : 0);
  const pollsPerStep = Math.max(1, options.pollsPerStep ?? (scenario === 'slow' ? 3 : 1));
  const pollAfterMs = options.pollAfterMs ?? 2000;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));

  // ----- state (memory only) -----
  const trips = new Map<string, Trip>();
  const batches = new Map<string, BatchRecord>();
  const jobs = new Map<string, JobRecord>();
  let feedPosts: PostSummary[] = [];
  let counter = 0;
  const nextId = (prefix: string): string => `${prefix}_${(counter += 1)}`;

  function seed(): void {
    if (scenario === 'empty') return;
    const sampleTrips =
      scenario === 'budgetUnknown'
        ? [createBudgetUnknownTrip(), createBudgetUnknownOverseasTrip()]
        : [...structuredClone(fixtureTrips), createCarTrip()];
    for (const trip of sampleTrips) trips.set(trip.tripId, trip);
    if (scenario === 'budgetUnknown') {
      const batch = createBudgetUnknownPlanBatch();
      batches.set(batch.batchId, { batch, constraints: { ...structuredClone(domesticTrip.constraints), budget: null } });
    } else {
      const batch = createSamplePlanBatch();
      batches.set(batch.batchId, { batch, constraints: structuredClone(domesticTrip.constraints) });
    }
    feedPosts = createSampleFeedPosts();
  }
  seed();

  // ----- result helpers -----
  function ok<T>(schema: z.ZodType<T>, value: unknown, status = 200): MockResult<T> {
    // A parse failure here is a bug in the mock (contract drift), so let it throw.
    return { ok: true, data: schema.parse(value), source: MOCK_SOURCE, status };
  }

  function fail<T>(code: ErrorCode, message?: string, details?: Record<string, unknown>): MockResult<T> {
    const base: ApiError | undefined = (sampleApiErrors as Partial<Record<ErrorCode, ApiError>>)[code];
    const error: ApiError = {
      code,
      message: message ?? base?.message ?? 'エラーが発生しました。',
      retryable: base?.retryable ?? false,
      requestId: nextId('req_mock'),
      ...(details ? { details } : {}),
    };
    return { ok: false, error, source: MOCK_SOURCE, status: ERROR_HTTP_STATUS[code] };
  }

  function invalidInput<T>(error: z.ZodError): MockResult<T> {
    return fail('VALIDATION_FAILED', undefined, { issues: error.issues.map(i => ({ path: i.path.join('.'), message: i.message })) });
  }

  async function pause(): Promise<void> {
    if (delayMs > 0) await sleep(delayMs);
  }

  const unavailable = <T>(): MockResult<T> => fail('UNAVAILABLE', 'モックのエラーシナリオです。サーバーに接続できません。');

  function jobStatus(job: JobRecord, step: JobStep, state?: JobStatus['state']): unknown {
    const finalState = state ?? step.state;
    return {
      jobId: job.jobId,
      state: finalState,
      stage: step.stage,
      batchId: finalState === 'succeeded' ? job.batch.batchId : null,
      error: finalState === 'failed' ? (step.error ?? null) : null,
      updatedAt: now().toISOString(),
    };
  }

  return {
    scenario,
    notice: MOCK_NOTICE,
    source: MOCK_SOURCE,

    /** K09 GET /api/v1/trips. Newest first. */
    async listTrips(): Promise<MockResult<TripList>> {
      await pause();
      if (scenario === 'error') return unavailable();
      const items = [...trips.values()]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(t => ({
          tripId: t.tripId,
          title: t.title,
          revision: t.revision,
          validationState: t.validationState,
          updatedAt: t.updatedAt,
          area: t.constraints.area,
          startDate: t.constraints.startDate,
          endDate: t.constraints.endDate,
        }));
      return ok(TripList, { items, nextCursor: null });
    },

    /** K09 GET /api/v1/trips/{id} */
    async getTrip(tripId: string): Promise<MockResult<Trip>> {
      await pause();
      if (scenario === 'error') return unavailable();
      const trip = trips.get(tripId);
      return trip ? ok(Trip, trip) : fail('NOT_FOUND');
    },

    /** K01 POST /local/v1/generations. Returns 202 JobAccepted; the job outcome comes from getJob. */
    async generate(request: ClientInput<typeof GenerateRequest>): Promise<MockResult<JobAccepted>> {
      await pause();
      const parsed = GenerateRequest.safeParse(request);
      if (!parsed.success) return invalidInput(parsed.error);
      const req = parsed.data;
      if (req.mode === 'replan') {
        const base = req.baseTripId ? trips.get(req.baseTripId) : undefined;
        if (!base) return fail('NOT_FOUND');
        if (base.revision !== req.expectedRevision) {
          return fail('REVISION_CONFLICT', undefined, { expectedRevision: req.expectedRevision, currentRevision: base.revision });
        }
      }
      const jobId = nextId('mock_job');
      const batchId = nextId('mock_batch');
      // The mock ignores the content of the constraints: it always offers the Kanazawa fixture candidates.
      const template = scenario === 'budgetUnknown' ? createBudgetUnknownPlanBatch() : createSamplePlanBatch();
      const batch: PlanBatch = {
        ...template,
        batchId,
        baseTripId: req.mode === 'replan' ? (req.baseTripId ?? null) : null,
        baseRevision: req.mode === 'replan' ? (req.expectedRevision ?? null) : null,
        candidates: (req.constraints.transportMode === 'car' ? template.candidates.map(candidateForCar) : template.candidates).map(c => ({
          ...c,
          warnings: [...c.warnings, GENERATE_MOCK_WARNING],
        })),
        createdAt: now().toISOString(),
      };
      const steps = scenario === 'error' ? ERROR_STEPS : NORMAL_STEPS;
      jobs.set(jobId, {
        jobId,
        steps,
        polls: 0,
        current: steps[0] as JobStep,
        cancelled: false,
        batch,
        constraints: scenario === 'budgetUnknown' ? { ...req.constraints, budget: null } : req.constraints,
        registered: false,
      });
      return ok(JobAccepted, { jobId, state: 'queued', pollAfterMs }, 202);
    },

    /** K02 GET /local/v1/jobs/{id}. Each call advances the job: queued -> running -> succeeded (or failed). */
    async getJob(jobId: string): Promise<MockResult<JobStatus>> {
      await pause();
      const job = jobs.get(jobId);
      if (!job) return fail('NOT_FOUND');
      if (job.cancelled) return ok(JobStatus, jobStatus(job, job.current, 'cancelled'));
      const index = Math.min(Math.floor(job.polls / pollsPerStep), job.steps.length - 1);
      job.polls += 1;
      const step = job.steps[index] as JobStep;
      job.current = step;
      if (step.state === 'succeeded' && !job.registered) {
        // Candidates become readable (K07) only once the job has succeeded.
        batches.set(job.batch.batchId, { batch: job.batch, constraints: job.constraints });
        job.registered = true;
      }
      return ok(JobStatus, jobStatus(job, step));
    },

    /** K21 POST /local/v1/jobs/{id}/cancel. After the batch is saved it says so (409) instead of pretending. */
    async cancelJob(jobId: string): Promise<MockResult<CancelResult>> {
      await pause();
      const job = jobs.get(jobId);
      if (!job) return fail('NOT_FOUND');
      if (job.cancelled) return ok(CancelResult, { jobId, state: 'cancelled', batchId: null });
      if (job.current.state === 'succeeded') return fail('ALREADY_COMMITTED', '候補はすでに保存されています。', { batchId: job.batch.batchId });
      if (job.current.state === 'failed') return ok(CancelResult, { jobId, state: 'failed', batchId: null });
      job.cancelled = true;
      return ok(CancelResult, { jobId, state: 'cancelled', batchId: null }, 202);
    },

    /** K07 GET /api/v1/plan-batches/{id} */
    async getPlanBatch(batchId: string): Promise<MockResult<PlanBatch>> {
      await pause();
      if (scenario === 'error') return unavailable();
      const record = batches.get(batchId);
      return record ? ok(PlanBatch, record.batch) : fail('NOT_FOUND');
    },

    /** K08 POST /api/v1/trips/apply-candidate. 201 when a trip is created, 200 when one is updated. */
    async applyCandidate(request: ClientInput<typeof ApplyCandidateRequest>): Promise<MockResult<TripWriteResult>> {
      await pause();
      if (scenario === 'error') return unavailable();
      const parsed = ApplyCandidateRequest.safeParse(request);
      if (!parsed.success) return invalidInput(parsed.error);
      const req = parsed.data;
      const record = batches.get(req.batchId);
      const candidate = record?.batch.candidates.find(c => c.candidateId === req.candidateId);
      if (!record || !candidate) return fail('NOT_FOUND');
      const stamp = now().toISOString();

      if (req.tripId === null) {
        const tripId = nextId('mock_trip');
        const trip: Trip = {
          schemaVersion: 1,
          tripId,
          ownerId: MOCK_USER_ID,
          title: candidate.title,
          revision: 1,
          constraints: structuredClone(record.constraints),
          days: structuredClone(candidate.days),
          places: structuredClone(record.batch.places),
          validationState: candidate.validationState,
          warnings: [...candidate.warnings],
          createdAt: stamp,
          updatedAt: stamp,
        };
        trips.set(tripId, trip);
        return ok(TripWriteResult, { tripId, revision: 1, trip, warnings: trip.warnings }, 201);
      }

      const existing = trips.get(req.tripId);
      if (!existing) return fail('NOT_FOUND');
      if (req.expectedRevision === null) return fail('VALIDATION_FAILED', '更新には expectedRevision が必要です。');
      if (existing.revision !== req.expectedRevision) {
        return fail('REVISION_CONFLICT', undefined, { expectedRevision: req.expectedRevision, currentRevision: existing.revision });
      }
      const updated: Trip = {
        ...existing,
        revision: existing.revision + 1,
        days: structuredClone(candidate.days),
        places: structuredClone(record.batch.places),
        validationState: candidate.validationState,
        warnings: [...candidate.warnings],
        updatedAt: stamp,
      };
      trips.set(updated.tripId, updated);
      return ok(TripWriteResult, { tripId: updated.tripId, revision: updated.revision, trip: updated, warnings: updated.warnings });
    },

    /**
     * K10 PATCH /api/v1/trips/{id}. Operations apply all-or-nothing on a copy.
     * Any itinerary change marks the trip 'needs_revalidation' (times and legs may be stale); set_title alone does not.
     */
    async patchTrip(tripId: string, request: ClientInput<typeof TripPatchRequest>): Promise<MockResult<TripPatchResult>> {
      await pause();
      if (scenario === 'error') return unavailable();
      const parsed = TripPatchRequest.safeParse(request);
      if (!parsed.success) return invalidInput(parsed.error);
      const req = parsed.data;
      const before = trips.get(tripId);
      if (!before) return fail('NOT_FOUND');
      if (before.revision !== req.expectedRevision) {
        return fail('REVISION_CONFLICT', undefined, { expectedRevision: req.expectedRevision, currentRevision: before.revision });
      }

      const after = structuredClone(before);
      const touched: ItineraryItem[] = []; // items added or updated
      const removed: ItineraryItem[] = [];
      const replaced: ItineraryItem[] = []; // previous versions of updated items
      let itineraryChanged = false;

      const locate = (id: string): { day: number; index: number } | null => {
        for (const [d, day] of after.days.entries()) {
          const index = day.items.findIndex(item => itemId(item) === id);
          if (index >= 0) return { day: d, index };
        }
        return null;
      };
      const unsatisfied = (op: TripOperation, why: string): MockResult<TripPatchResult> =>
        fail('CONSTRAINT_UNSATISFIED', `操作 ${op.op} を適用できません: ${why}`, { op: op.op });

      for (const op of req.operations) {
        switch (op.op) {
          case 'set_title':
            after.title = op.title;
            break;
          case 'add': {
            const day = after.days[op.dayIndex];
            if (!day) return unsatisfied(op, 'dayIndex が範囲外です');
            if (op.position > day.items.length) return unsatisfied(op, 'position が範囲外です');
            if (locate(itemId(op.item))) return unsatisfied(op, 'ID が重複しています');
            day.items.splice(op.position, 0, structuredClone(op.item));
            touched.push(op.item);
            itineraryChanged = true;
            break;
          }
          case 'remove': {
            const at = locate(op.itemId);
            if (!at) return unsatisfied(op, '対象が見つかりません');
            const [item] = (after.days[at.day] as Trip['days'][number]).items.splice(at.index, 1);
            if (item) removed.push(item);
            itineraryChanged = true;
            break;
          }
          case 'move': {
            const at = locate(op.itemId);
            if (!at) return unsatisfied(op, '対象が見つかりません');
            const target = after.days[op.toDayIndex];
            if (!target) return unsatisfied(op, 'toDayIndex が範囲外です');
            const [item] = (after.days[at.day] as Trip['days'][number]).items.splice(at.index, 1);
            if (!item) return unsatisfied(op, '対象が見つかりません');
            if (op.toPosition > target.items.length) return unsatisfied(op, 'toPosition が範囲外です');
            target.items.splice(op.toPosition, 0, item);
            itineraryChanged = true;
            break;
          }
          case 'update': {
            const at = locate(op.itemId);
            if (!at) return unsatisfied(op, '対象が見つかりません');
            if (itemId(op.item) !== op.itemId) return unsatisfied(op, 'item の ID が itemId と一致しません');
            const items = (after.days[at.day] as Trip['days'][number]).items;
            const previous = items[at.index];
            if (previous) replaced.push(previous);
            items[at.index] = structuredClone(op.item);
            touched.push(op.item);
            itineraryChanged = true;
            break;
          }
        }
      }

      // R11: unknown is never treated as 0. If an added/removed/updated item has no known duration,
      // or an updated item had no known duration before, the duration delta is unknown (null);
      // moves and renames do not change durations.
      const durationUnknown = [...touched, ...removed, ...replaced].some(item => durationOf(item) === null);
      const beforeCost = knownCostByCurrency(before);
      const afterCost = knownCostByCurrency(after);
      const knownCostDelta: Money[] = [...new Set([...beforeCost.keys(), ...afterCost.keys()])]
        .sort()
        .map(currency => ({ currency, amountMinor: (afterCost.get(currency) ?? 0) - (beforeCost.get(currency) ?? 0) }))
        .filter(m => m.amountMinor !== 0);
      const diff: TripDiff = {
        durationDeltaSeconds: durationUnknown ? null : sumKnownDurations(after) - sumKnownDurations(before),
        knownCostDelta,
        // Union of before and after (as main K10 does), so removing an unknown-cost item or giving it a
        // price is not shown as "no unknown cost".
        unknownCostItems: [...new Set([...unknownCostIds(before), ...unknownCostIds(after)])],
      };

      after.revision = before.revision + 1;
      after.updatedAt = now().toISOString();
      if (itineraryChanged) after.validationState = 'needs_revalidation';
      trips.set(tripId, after);
      return ok(TripPatchResult, { tripId, revision: after.revision, trip: after, warnings: after.warnings, diff });
    },

    /**
     * K14 GET /api/v1/posts. Cursor is an offset string. 'mine' = posts by the demo user;
     * 'groups' is empty because no group fixtures exist.
     */
    async getFeed(query: ClientInput<typeof FeedQuery>): Promise<MockResult<Feed>> {
      await pause();
      if (scenario === 'error') return unavailable();
      const parsed = FeedQuery.safeParse(query);
      if (!parsed.success) return invalidInput(parsed.error);
      const { scope, cursor, limit } = parsed.data;
      let offset = 0;
      if (cursor !== undefined && cursor !== '') {
        // Only the digit strings this mock issues are valid cursors.
        if (!/^\d+$/.test(cursor)) return fail('VALIDATION_FAILED', 'cursor が不正です。');
        offset = Number(cursor);
      }
      const pool =
        scope === 'public'
          ? feedPosts.filter(p => p.visibility === 'public')
          : scope === 'mine'
            ? feedPosts.filter(p => p.authorDisplayName === MOCK_USER_DISPLAY_NAME)
            : [];
      const items = pool.slice(offset, offset + limit);
      const nextCursor = offset + limit < pool.length ? String(offset + limit) : null;
      return ok(Feed, { items, nextCursor });
    },
  };
}

export type MockApi = ReturnType<typeof createMockApi>;
