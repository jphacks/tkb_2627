// T01 sweep: every export of @tkb/fixtures, every response of the screen mock API and every K23 sample
// must satisfy the contract schemas. A guard fails when a new fixture export is not registered here,
// so a fixture can not be added without being checked.
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  ApiError, CancelResult, ERROR_HTTP_STATUS, ErrorCode, Feed, JobAccepted, JobStatus, PlanBatch, PlanBlueprint, PlanCandidate,
  PostSummary, Trip, TripList, TripPatchResult, TripWriteResult,
} from '@tkb/contracts';
import * as fx from '@tkb/fixtures';
import { createMockApi, type MockResult, type MockScenario } from '../../apps/web/src/mocks/index.ts';

const parse = (s: z.ZodType, v: unknown, label: string) => {
  const r = s.safeParse(v);
  expect(r.success, `${label}: ${r.success ? '' : JSON.stringify(r.error.issues.slice(0, 3))}`).toBe(true);
};

/** How each export is validated. Functions are called with no arguments (all fixture factories take none). */
const registry: Record<string, { schema: z.ZodType; list?: boolean; record?: boolean } | 'skip'> = {
  FIXTURE_NOTICE: 'skip',
  kanazawaPlaces: 'skip', // covered through the trips that embed them
  parisPlaces: 'skip',
  domesticTrip: { schema: Trip },
  overseasTrip: { schema: Trip },
  fixtureTrips: { schema: Trip, list: true },
  samplePlanBlueprint: { schema: PlanBlueprint },
  sampleJobStatuses: { schema: JobStatus, record: true },
  sampleFeed: { schema: Feed },
  createBudgetUnknownTrip: { schema: Trip },
  createBudgetUnknownOverseasTrip: { schema: Trip },
  createCarTrip: { schema: Trip },
  createEmptyItemsTrip: { schema: Trip },
  createNoDaysTrip: { schema: Trip },
  emptyTripList: { schema: TripList },
  emptyFeed: { schema: Feed },
  createSamplePlanBatch: { schema: PlanBatch },
  createBudgetUnknownPlanBatch: { schema: PlanBatch },
  sampleApiErrors: { schema: ApiError, record: true },
  extraJobStatuses: { schema: JobStatus, record: true },
  createSampleFeedPosts: { schema: PostSummary, list: true },
  summarizeKnownCost: 'skip', // helpers with arguments, tested in packages/fixtures
  withUnknownCosts: 'skip',
};

describe('fixtures: every export is registered and valid', () => {
  it('no export is left out of the registry', () => {
    expect(Object.keys(fx).sort()).toEqual(Object.keys(registry).sort());
  });
  it.each(Object.entries(registry).filter(([, v]) => v !== 'skip') as [string, Exclude<(typeof registry)[string], 'skip'>][])('%s', (name, spec) => {
    const raw = (fx as Record<string, unknown>)[name];
    const value = typeof raw === 'function' ? (raw as () => unknown)() : raw;
    const items = spec.record ? Object.entries(value as object) : spec.list ? (value as unknown[]).map((v, i) => [String(i), v] as const) : [[name, value] as const];
    expect(items.length).toBeGreaterThan(0);
    for (const [k, v] of items) parse(spec.schema, v, `${name}.${k}`);
  });
  it('plan-batch candidates are valid PlanCandidates and their cost summary matches the items', () => {
    for (const batch of [fx.createSamplePlanBatch(), fx.createBudgetUnknownPlanBatch()]) {
      for (const c of batch.candidates) {
        parse(PlanCandidate, c, c.candidateId);
        const s = fx.summarizeKnownCost(c.days);
        expect(c.totalKnownCost).toEqual(s.totalKnownCost);
        expect(c.hasUnknownCost).toBe(s.hasUnknownCost);
      }
    }
  });
  it('factories return fresh copies (mutating one result never changes the next)', () => {
    const a = fx.createSamplePlanBatch();
    a.candidates[0]!.title = 'MUTATED';
    expect(fx.createSamplePlanBatch().candidates[0]!.title).not.toBe('MUTATED');
    const t = fx.createCarTrip();
    t.title = 'MUTATED';
    expect(fx.createCarTrip().title).not.toBe('MUTATED');
  });
  it('every fixture is JSON-stable (no undefined, Date or class instances)', () => {
    for (const v of [fx.domesticTrip, fx.overseasTrip, fx.createSamplePlanBatch(), fx.sampleFeed, fx.sampleApiErrors, fx.extraJobStatuses, fx.sampleJobStatuses]) {
      expect(JSON.parse(JSON.stringify(v))).toEqual(v);
    }
  });
  it('sampleJobStatuses covers every terminal and active state; a succeeded job is at stage done (K02)', () => {
    expect(Object.values(fx.sampleJobStatuses).map(j => j.state).sort()).toEqual(['failed', 'queued', 'running', 'succeeded']);
    expect(fx.sampleJobStatuses.succeeded.stage).toBe('done');
    const all = [...Object.values(fx.sampleJobStatuses), ...Object.values(fx.extraJobStatuses)];
    expect(new Set(all.map(j => j.state))).toEqual(new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled']));
  });
  it('sampleApiErrors: key equals code, HTTP status is defined, retryable errors are the transient ones', () => {
    for (const [key, e] of Object.entries(fx.sampleApiErrors)) {
      expect(e.code).toBe(key);
      expect(ERROR_HTTP_STATUS[e.code]).toBeGreaterThanOrEqual(400);
    }
    // A client that sees retryable=false must not blindly retry: these must never be marked retryable.
    for (const code of ['UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'REVISION_CONFLICT', 'VALIDATION_FAILED', 'ALREADY_COMMITTED'] as const) {
      expect(fx.sampleApiErrors[code].retryable, code).toBe(false);
    }
    for (const code of ['RATE_LIMITED', 'UNAVAILABLE', 'PROVIDER_UNAVAILABLE'] as const) expect(fx.sampleApiErrors[code].retryable, code).toBe(true);
  });
  it('REVISION_CONFLICT sample carries expectedRevision and currentRevision (K10/K08 details)', () => {
    expect(fx.sampleApiErrors.REVISION_CONFLICT.details).toEqual({ expectedRevision: 1, currentRevision: 2 });
  });
});

describe('screen mock API: every response in every scenario', () => {
  const scenarios: MockScenario[] = ['normal', 'empty', 'error', 'slow', 'budgetUnknown'];
  const generate = { constraints: { area: '金沢', startDate: '2026-11-01', endDate: '2026-11-02', timeZone: 'Asia/Tokyo', transportMode: 'transit' as const } };

  /** Success data must parse with its schema; failure must be an ApiError whose status is ERROR_HTTP_STATUS[code]. */
  function check<T>(label: string, r: MockResult<T>, schema: z.ZodType): MockResult<T> {
    expect(r.source, label).toBe('mock');
    if (r.ok) {
      parse(schema, r.data, label);
      expect(r.status, label).toBeGreaterThanOrEqual(200);
      expect(r.status, label).toBeLessThan(300);
    } else {
      parse(ApiError, r.error, `${label} error`);
      expect(r.status, label).toBe(ERROR_HTTP_STATUS[r.error.code]);
      expect(ErrorCode.options).toContain(r.error.code);
    }
    return r;
  }

  it.each(scenarios)('%s', async (scenario) => {
    const api = createMockApi({ scenario, delayMs: 0, pollsPerStep: 1 });
    const list = check('listTrips', await api.listTrips(), TripList);
    const firstId = list.ok ? list.data.items[0]?.tripId : undefined;
    check('getTrip', await api.getTrip(firstId ?? 'fx_trip_kanazawa'), Trip);
    check('getTrip missing', await api.getTrip('nope'), Trip);
    check('getFeed public', await api.getFeed({ scope: 'public' }), Feed);
    check('getFeed mine', await api.getFeed({ scope: 'mine' }), Feed);
    check('getFeed groups', await api.getFeed({ scope: 'groups' }), Feed);
    check('getPlanBatch missing', await api.getPlanBatch('nope'), PlanBatch);
    check('getJob missing', await api.getJob('nope'), JobStatus);
    check('cancelJob missing', await api.cancelJob('nope'), CancelResult);
    const gen = check('generate', await api.generate(generate), JobAccepted);
    if (!gen.ok) throw new Error('generate failed');
    let batchId: string | null = null;
    for (let i = 0; i < 10; i += 1) {
      const j = check('getJob', await api.getJob(gen.data.jobId), JobStatus);
      if (j.ok && j.data.batchId) batchId = j.data.batchId;
      if (j.ok && ['succeeded', 'failed', 'cancelled'].includes(j.data.state)) break;
    }
    if (batchId) {
      const b = check('getPlanBatch', await api.getPlanBatch(batchId), PlanBatch);
      const cand = b.ok ? b.data.candidates[0]?.candidateId : undefined;
      const applied = check('applyCandidate', await api.applyCandidate({ batchId, candidateId: cand ?? 'x', tripId: null, expectedRevision: null }), TripWriteResult);
      if (applied.ok) {
        check('patchTrip', await api.patchTrip(applied.data.tripId, { expectedRevision: 1, operations: [{ op: 'set_title', title: 'new' }] }), TripPatchResult);
        check('patchTrip conflict', await api.patchTrip(applied.data.tripId, { expectedRevision: 1, operations: [{ op: 'set_title', title: 'again' }] }), TripPatchResult);
      }
      check('cancelJob after success', await api.cancelJob(gen.data.jobId), CancelResult);
    }
    check('applyCandidate missing', await api.applyCandidate({ batchId: 'nope', candidateId: 'x', tripId: null, expectedRevision: null }), TripWriteResult);
    // Invalid input becomes a VALIDATION_FAILED envelope, never a throw.
    const bad = await api.generate({ constraints: { area: '' } } as never);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('VALIDATION_FAILED');
  });
});
