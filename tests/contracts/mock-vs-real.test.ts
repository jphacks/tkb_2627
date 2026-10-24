// T01 mock <-> implementation parity. The screen mock (apps/web/src/mocks) and the real servers are driven with
// the same operation and compared by shape only: HTTP status, success/failure, error code, error detail keys,
// top-level keys, schema validity. Values (ids, times) are not compared.
// Known differences from the B04 review are it.skip with the reason; M2 is to fix them before U01
// (see tests/contracts/FINDINGS.md). Each skipped body states what the mock must do once fixed.
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  ApiError, CancelResult, Feed, JobAccepted, JobStatus, PlanBatch, Trip, TripList, TripPatchResult, TripWriteResult,
} from '@tkb/contracts';
import { createSamplePlanBatch, domesticTrip, sampleFeed } from '@tkb/fixtures';
import { insertTrip } from '@tkb/db';
import { createMockApi, type MockResult } from '../../apps/web/src/mocks/index.ts';
import { call, closeAll as closeShared, makeWorld, type World } from '../access/helpers.ts';
import { cancel, closeAll as closeLocal, constraints, envelope, gen, getJob, make, ok, runnerOf, session, settle } from '../ai/harness.ts';

afterEach(async () => { await closeShared(); await closeLocal(); });

/** What the two sides must agree on. */
interface Outcome { status: number; code: string | null; detailKeys: string[]; keys: string[]; schemaOk: boolean }
/** VALIDATION_FAILED: the mock adds details.issues, main returns no details (FINDINGS M-8); compare everything else. */
const noDetails = (o: Outcome): Outcome => ({ ...o, detailKeys: [] });
const keysOf = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort() : []);

function fromHttp(res: { statusCode: number; json: () => unknown }, schema: z.ZodType): Outcome {
  const body = res.json();
  if (res.statusCode >= 400) {
    const e = ApiError.parse(body);
    return { status: res.statusCode, code: e.code, detailKeys: keysOf(e.details), keys: [], schemaOk: true };
  }
  return { status: res.statusCode, code: null, detailKeys: [], keys: keysOf(body), schemaOk: schema.safeParse(body).success };
}
function fromMock<T>(r: MockResult<T>, schema: z.ZodType): Outcome {
  if (!r.ok) return { status: r.status, code: r.error.code, detailKeys: keysOf(r.error.details), keys: [], schemaOk: true };
  return { status: r.status, code: null, detailKeys: [], keys: keysOf(r.data), schemaOk: schema.safeParse(r.data).success };
}

/** Shared server + mock, both seeded with the Kanazawa fixture trip (revision 1) owned by the acting user. */
async function trips() {
  const w: World = await makeWorld();
  const trip = structuredClone(domesticTrip);
  insertTrip(w.db, 'user_a', trip, '2026-10-24T03:00:00Z');
  const mock = createMockApi();
  const owner = w.actors.owner!;
  const batch = createSamplePlanBatch();
  const created = await call(w.app, owner, 'POST', '/api/v1/plan-batches', {
    schemaVersion: 1, baseTripId: null, baseRevision: null, generationId: 'gen_parity', candidates: batch.candidates, places: batch.places, constraints: domesticTrip.constraints,
  });
  const realBatchId = (created.json() as { batchId: string }).batchId;
  const cand = batch.candidates.map(c => c.candidateId);
  return {
    w, mock, tripId: trip.tripId, realBatchId, mockBatchId: batch.batchId, cand,
    both: async <S extends z.ZodType>(schema: S, real: () => Promise<{ statusCode: number; json: () => unknown }>, mocked: () => Promise<MockResult<unknown>>) =>
      ({ real: fromHttp(await real(), schema), mock: fromMock(await mocked(), schema) }),
    get: (url: string) => call(w.app, owner, 'GET', url),
    send: (method: 'POST' | 'PATCH', url: string, body: unknown) => call(w.app, owner, method, url, body),
  };
}
type T = Awaited<ReturnType<typeof trips>>;
const patchBody = (rev: number, ops: unknown[]) => ({ expectedRevision: rev, operations: ops });
const titleOp = [{ op: 'set_title', title: 'renamed' }];

describe('K09 trips: mock and shared server agree', () => {
  it('list', async () => {
    const t = await trips();
    const { real, mock } = await t.both(TripList, () => t.get('/api/v1/trips'), () => t.mock.listTrips());
    expect(mock).toEqual(real);
  });
  it('get one and get missing', async () => {
    const t = await trips();
    const a = await t.both(Trip, () => t.get(`/api/v1/trips/${t.tripId}`), () => t.mock.getTrip(t.tripId));
    expect(a.mock).toEqual(a.real);
    const b = await t.both(Trip, () => t.get('/api/v1/trips/nope'), () => t.mock.getTrip('nope'));
    expect(b.mock).toEqual(b.real);
    expect(b.real.code).toBe('NOT_FOUND');
  });
});

describe('K10 PATCH: mock and shared server agree', () => {
  const cases: [string, (t: T) => { rev: number; ops: unknown[] }][] = [
    ['set_title', () => ({ rev: 1, ops: titleOp })],
    ['stale revision', () => ({ rev: 9, ops: titleOp })],
    ['remove of an unknown item', () => ({ rev: 1, ops: [{ op: 'remove', itemId: 'nope' }] })],
    ['move to a day that does not exist', () => ({ rev: 1, ops: [{ op: 'move', itemId: 'fx_act_omicho', toDayIndex: 9, toPosition: 0 }] })],
    ['add with an out-of-range position', () => ({ rev: 1, ops: [{ op: 'add', dayIndex: 0, position: 99, item: domesticTrip.days[1]!.items[0] }] })],
    ['empty operations', () => ({ rev: 1, ops: [] })],
    ['unknown operation', () => ({ rev: 1, ops: [{ op: 'delete_trip' }] })],
  ];
  it.each(cases)('%s: status and error code', async (_n, make) => {
    const t = await trips();
    const { rev, ops } = make(t);
    const { real, mock } = await t.both(TripPatchResult, () => t.send('PATCH', `/api/v1/trips/${t.tripId}`, patchBody(rev, ops)), () => t.mock.patchTrip(t.tripId, patchBody(rev, ops) as never));
    expect({ status: mock.status, code: mock.code, schemaOk: mock.schemaOk, keys: mock.keys }).toEqual({ status: real.status, code: real.code, schemaOk: real.schemaOk, keys: real.keys });
  });
  it('REVISION_CONFLICT details have the same keys (expectedRevision, currentRevision)', async () => {
    const t = await trips();
    const { real, mock } = await t.both(TripPatchResult, () => t.send('PATCH', `/api/v1/trips/${t.tripId}`, patchBody(9, titleOp)), () => t.mock.patchTrip(t.tripId, patchBody(9, titleOp) as never));
    expect(mock.detailKeys).toEqual(real.detailKeys);
    expect(real.detailKeys).toEqual(['currentRevision', 'expectedRevision']);
  });
  it('patch of a missing trip is 404 on both', async () => {
    const t = await trips();
    const { real, mock } = await t.both(TripPatchResult, () => t.send('PATCH', '/api/v1/trips/nope', patchBody(1, titleOp)), () => t.mock.patchTrip('nope', patchBody(1, titleOp) as never));
    expect(mock).toEqual(real);
  });
  it('an itinerary edit makes the trip needs_revalidation on both', async () => {
    const t = await trips();
    const op = [{ op: 'remove', itemId: 'fx_act_omicho' }];
    const real = (await t.send('PATCH', `/api/v1/trips/${t.tripId}`, patchBody(1, op))).json() as TripPatchResult;
    const mock = await t.mock.patchTrip(t.tripId, patchBody(1, op) as never);
    expect(mock.ok && mock.data.trip.validationState).toBe(real.trip.validationState);
    expect(real.trip.validationState).toBe('needs_revalidation');
  });
  it('diff keys and unknownCostItems agree for a set_title and for a removal', async () => {
    const t = await trips();
    for (const op of [titleOp, [{ op: 'remove', itemId: 'fx_act_lunch' }]]) {
      const t2 = await trips();
      const real = (await t2.send('PATCH', `/api/v1/trips/${t2.tripId}`, patchBody(1, op))).json() as TripPatchResult;
      const mock = await t2.mock.patchTrip(t2.tripId, patchBody(1, op) as never);
      if (!mock.ok) throw new Error('mock failed');
      expect(Object.keys(mock.data.diff).sort()).toEqual(Object.keys(real.diff).sort());
      expect([...mock.data.diff.unknownCostItems].sort()).toEqual([...real.diff.unknownCostItems].sort());
      expect(mock.data.diff.knownCostDelta).toEqual(real.diff.knownCostDelta);
    }
    expect(t.tripId).toBe('fx_trip_kanazawa');
  });
  // B04 review 2: K10 details. Main returns { operationIndex, reason }; the mock returns { op }.
  it.skip('CONSTRAINT_UNSATISFIED details have the same keys (operationIndex, reason) [FINDINGS M-2: mock returns {op}]', async () => {
    const t = await trips();
    const ops = [{ op: 'remove', itemId: 'nope' }];
    const { real, mock } = await t.both(TripPatchResult, () => t.send('PATCH', `/api/v1/trips/${t.tripId}`, patchBody(1, ops)), () => t.mock.patchTrip(t.tripId, patchBody(1, ops) as never));
    expect(mock.detailKeys).toEqual(real.detailKeys);
  });
  // B04 review 3: warnings. Main appends '移動情報を再確認してください' when the trip becomes needs_revalidation.
  it.skip('an itinerary edit adds the same re-check warning on both [FINDINGS M-3: mock keeps warnings unchanged]', async () => {
    const t = await trips();
    const op = [{ op: 'remove', itemId: 'fx_act_omicho' }];
    const real = (await t.send('PATCH', `/api/v1/trips/${t.tripId}`, patchBody(1, op))).json() as TripPatchResult;
    const mock = await t.mock.patchTrip(t.tripId, patchBody(1, op) as never);
    expect(mock.ok && mock.data.warnings).toEqual(real.warnings);
  });
});

describe('K07/K08 plan batches and apply-candidate: mock and shared server agree', () => {
  it('GET batch: existing and missing', async () => {
    const t = await trips();
    const a = await t.both(PlanBatch, () => t.get(`/api/v1/plan-batches/${t.realBatchId}`), () => t.mock.getPlanBatch(t.mockBatchId));
    expect(a.mock).toEqual(a.real);
    const b = await t.both(PlanBatch, () => t.get('/api/v1/plan-batches/nope'), () => t.mock.getPlanBatch('nope'));
    expect(b.mock).toEqual(b.real);
  });
  it('apply into a new trip: 201 TripWriteResult on both', async () => {
    const t = await trips();
    const body = (id: string) => ({ batchId: id, candidateId: t.cand[0]!, tripId: null, expectedRevision: null });
    const { real, mock } = await t.both(TripWriteResult, () => t.send('POST', '/api/v1/trips/apply-candidate', body(t.realBatchId)), () => t.mock.applyCandidate(body(t.mockBatchId)));
    expect(mock).toEqual(real);
    expect(real.status).toBe(201);
  });
  it('apply of an unknown batch or candidate: 404 on both', async () => {
    const t = await trips();
    const b1 = { batchId: 'nope', candidateId: t.cand[0]!, tripId: null, expectedRevision: null };
    const a = await t.both(TripWriteResult, () => t.send('POST', '/api/v1/trips/apply-candidate', b1), () => t.mock.applyCandidate(b1));
    expect(a.mock).toEqual(a.real);
    const b = await t.both(TripWriteResult, () => t.send('POST', '/api/v1/trips/apply-candidate', { ...b1, batchId: t.realBatchId, candidateId: 'nope' }), () => t.mock.applyCandidate({ ...b1, batchId: t.mockBatchId, candidateId: 'nope' }));
    expect(b.mock).toEqual(b.real);
  });
  it('apply with an unknown key or a tripId without expectedRevision is 422 on both', async () => {
    const t = await trips();
    const unknown = { batchId: t.mockBatchId, candidateId: t.cand[0]!, tripId: null, expectedRevision: null, ownerId: 'x' };
    const a = await t.both(TripWriteResult, () => t.send('POST', '/api/v1/trips/apply-candidate', { ...unknown, batchId: t.realBatchId }), () => t.mock.applyCandidate(unknown as never));
    expect(noDetails(a.mock)).toEqual(noDetails(a.real));
    expect(a.real.status).toBe(422);
  });
  // B04 review 4: K08 422 rules the mock does not implement.
  it.skip('apply of a candidate onto a trip it was not generated for is 422 on both [FINDINGS M-4: mock applies it]', async () => {
    const t = await trips();
    const body = (id: string) => ({ batchId: id, candidateId: t.cand[0]!, tripId: t.tripId, expectedRevision: 1 });
    const { real, mock } = await t.both(TripWriteResult, () => t.send('POST', '/api/v1/trips/apply-candidate', body(t.realBatchId)), () => t.mock.applyCandidate(body(t.mockBatchId)));
    expect(mock).toEqual(real);
    expect(real.code).toBe('VALIDATION_FAILED');
  });
});

describe('K14 feed: mock and shared server agree', () => {
  async function feedWorld() {
    const t = await trips();
    // Three public posts so the real feed paginates like the mock's three-post feed.
    for (let i = 0; i < 3; i += 1) await t.w.publish(t.w.actors.owner!, t.w.tripA.tripId, 'public', `story ${i}`);
    return t;
  }
  it('public scope: 200 Feed with items and a continuation cursor at limit 1', async () => {
    const t = await feedWorld();
    const { real, mock } = await t.both(Feed, () => t.get('/api/v1/posts?scope=public&limit=1'), () => t.mock.getFeed({ scope: 'public', limit: 1 }));
    expect(mock).toEqual(real);
    const rf = (await t.get('/api/v1/posts?scope=public&limit=1')).json() as Feed;
    const mf = await t.mock.getFeed({ scope: 'public', limit: 1 });
    expect(Boolean(mf.ok && mf.data.nextCursor)).toBe(Boolean(rf.nextCursor));
  });
  it('validation: bad scope, limit over 20 and limit 0 are 422 on both', async () => {
    const t = await feedWorld();
    for (const [q, m] of [['scope=all', { scope: 'all' }], ['scope=public&limit=21', { scope: 'public', limit: 21 }], ['scope=public&limit=0', { scope: 'public', limit: 0 }]] as const) {
      const { real, mock } = await t.both(Feed, () => t.get(`/api/v1/posts?${q}`), () => t.mock.getFeed(m as never));
      expect(noDetails(mock), q).toEqual(noDetails(real));
      expect(real.status, q).toBe(422);
    }
  });
  it('a malformed cursor is 422 on both', async () => {
    const t = await feedWorld();
    const { real, mock } = await t.both(Feed, () => t.get('/api/v1/posts?scope=public&cursor=zzz'), () => t.mock.getFeed({ scope: 'public', cursor: 'zzz' }));
    expect(mock).toEqual(real);
    expect(real.status).toBe(422);
  });
  it('paging to the end terminates with nextCursor null on both', async () => {
    const t = await feedWorld();
    let rc: string | null | undefined, mc: string | null | undefined, rn = 0, mn = 0;
    do {
      const r = (await t.get(`/api/v1/posts?scope=public&limit=1${rc ? `&cursor=${rc}` : ''}`)).json() as Feed;
      rc = r.nextCursor; rn += 1;
    } while (rc && rn < 10);
    do {
      const m = await t.mock.getFeed({ scope: 'public', limit: 1, ...(mc ? { cursor: mc } : {}) });
      mc = m.ok ? m.data.nextCursor : null; mn += 1;
    } while (mc && mn < 10);
    expect(rc).toBeNull();
    expect(mc).toBeNull();
    expect(sampleFeed.items.length).toBeGreaterThan(0);
  });
  // B04 review 5: cursor. Main issues an opaque base64url([createdAt,id]); the mock issues a digit offset.
  it.skip('a cursor issued by the mock is a valid cursor for the real feed (same opaque encoding) [FINDINGS M-5: mock cursor is an offset]', async () => {
    const t = await feedWorld();
    const mf = await t.mock.getFeed({ scope: 'public', limit: 1 });
    const cursor = mf.ok ? mf.data.nextCursor : null;
    expect(cursor).not.toBeNull();
    const res = await t.get(`/api/v1/posts?scope=public&limit=1&cursor=${cursor}`);
    expect(res.statusCode).toBe(200);
  });
  // Documented mock limit (mockApi.ts header): no authorization. Not a defect to fix before U01, a screen rule.
  it('documents: anonymous groups scope is 401 on main but an empty 200 on the mock (screens must not rely on it)', async () => {
    const t = await feedWorld();
    const real = fromHttp(await call(t.w.app, null, 'GET', '/api/v1/posts?scope=groups'), Feed);
    const mock = fromMock(await t.mock.getFeed({ scope: 'groups' }), Feed);
    expect(real.code).toBe('UNAUTHENTICATED');
    expect(mock.status).toBe(200);
  });
});

describe('K01/K02/K21 generation: mock and personal entry agree', () => {
  const key = 'key-parity-0001';
  async function local() {
    const { runner } = runnerOf(async () => ok(envelope()));
    const c = make({ app: { runner, save: async () => ({ batchId: 'batch_1' }) } });
    const { h } = await session(c);
    return { c, h };
  }
  it('generate: 202 JobAccepted with the same keys', async () => {
    const { c, h } = await local();
    const mock = createMockApi();
    const real = fromHttp(await gen(c, h, key), JobAccepted);
    const m = fromMock(await mock.generate({ constraints } as never), JobAccepted);
    expect(m).toEqual(real);
  });
  it('generate with invalid input is 422 on both', async () => {
    const { c, h } = await local();
    const mock = createMockApi();
    const bad = { constraints: { ...constraints, startDate: '2026-02-30' } };
    expect(noDetails(fromMock(await mock.generate(bad as never), JobAccepted))).toEqual(noDetails(fromHttp(await gen(c, h, key, bad), JobAccepted)));
    const owner = { constraints, ownerId: 'u2' };
    expect(noDetails(fromMock(await mock.generate(owner as never), JobAccepted))).toEqual(noDetails(fromHttp(await gen(c, h, 'key-parity-0002', owner), JobAccepted)));
  });
  it('job: unknown id is 404 and cancel of unknown id is 404 on both', async () => {
    const { c, h } = await local();
    const mock = createMockApi();
    expect(fromMock(await mock.getJob('nope'), JobStatus)).toEqual(fromHttp(await getJob(c, h, 'nope'), JobStatus));
    expect(fromMock(await mock.cancelJob('nope'), CancelResult)).toEqual(fromHttp(await cancel(c, h, 'nope'), CancelResult));
  });
  it('a job ends succeeded with a batchId; states seen are a subset of the contract and never regress', async () => {
    const { c, h } = await local();
    const mock = createMockApi();
    const real = await settle(c, h, ((await gen(c, h, key)).json() as { jobId: string }).jobId);
    const acc = await mock.generate({ constraints } as never);
    if (!acc.ok) throw new Error('mock generate failed');
    let last = null as JobStatus | null;
    for (let i = 0; i < 10; i += 1) {
      const j = await mock.getJob(acc.data.jobId);
      if (!j.ok) throw new Error('mock job failed');
      last = j.data;
      if (last.state === 'succeeded') break;
    }
    expect(last).not.toBeNull();
    expect(last!.state).toBe(real.state);
    expect(last!.batchId).not.toBeNull();
    expect(real.batchId).not.toBeNull();
    expect(Object.keys(last!).sort()).toEqual(Object.keys(real).sort());
  });
  // B04 review 1: stage. Main (and the K02 docs example) report 'done' for a finished job; the mock reports 'saved'.
  it.skip("a succeeded job is at stage 'done' on both [FINDINGS M-1: mock ends at 'saved']", async () => {
    const { c, h } = await local();
    const mock = createMockApi();
    const real = await settle(c, h, ((await gen(c, h, key)).json() as { jobId: string }).jobId);
    const acc = await mock.generate({ constraints } as never);
    if (!acc.ok) throw new Error('mock generate failed');
    let last = null as JobStatus | null;
    for (let i = 0; i < 10 && last?.state !== 'succeeded'; i += 1) {
      const j = await mock.getJob(acc.data.jobId);
      if (j.ok) last = j.data;
    }
    expect(last!.stage).toBe(real.stage);
    expect(real.stage).toBe('done');
  });
  it('cancel of a running job is 202 cancelled on both', async () => {
    const hang = runnerOf(() => new Promise(() => {}));
    const c = make({ app: { runner: hang.runner, save: async () => ({ batchId: 'b' }) } });
    const { h } = await session(c);
    const id = ((await gen(c, h, key)).json() as { jobId: string }).jobId;
    const real = fromHttp(await cancel(c, h, id), CancelResult);
    const mock = createMockApi();
    const acc = await mock.generate({ constraints } as never);
    if (!acc.ok) throw new Error('mock generate failed');
    expect(fromMock(await mock.cancelJob(acc.data.jobId), CancelResult)).toEqual(real);
  });
  // K21 (documented in docs/03_CONTRACTS.md, "実装で確定した事項"): cancelling a succeeded job is 200 with state and batchId.
  it.skip('cancel after success is 200 {state: succeeded, batchId} on both [FINDINGS M-6: mock returns 409 ALREADY_COMMITTED]', async () => {
    const { c, h } = await local();
    const id = ((await gen(c, h, key)).json() as { jobId: string }).jobId;
    await settle(c, h, id);
    const real = fromHttp(await cancel(c, h, id), CancelResult);
    const mock = createMockApi();
    const acc = await mock.generate({ constraints } as never);
    if (!acc.ok) throw new Error('mock generate failed');
    for (let i = 0; i < 10; i += 1) await mock.getJob(acc.data.jobId);
    expect(fromMock(await mock.cancelJob(acc.data.jobId), CancelResult)).toEqual(real);
    expect(real.status).toBe(200);
  });
  // Documented mock limit (mockApi.ts header, K01): main rejects mode=replan and baseTripId with 422 until A04.
  it.skip('replan and baseTripId are 422 on both until A04 [FINDINGS M-7: mock accepts them and answers 404/409]', async () => {
    const { c, h } = await local();
    const mock = createMockApi();
    const body = { mode: 'replan', constraints, baseTripId: 'fx_trip_kanazawa', expectedRevision: 1 };
    expect(fromMock(await mock.generate(body as never), JobAccepted)).toEqual(fromHttp(await gen(c, h, key, body), JobAccepted));
  });
});

describe('validation detail parity', () => {
  it.skip('VALIDATION_FAILED carries no details on both: main never echoes what was wrong [FINDINGS M-8: mock adds details.issues]', async () => {
    const t = await trips();
    const { real, mock } = await t.both(Feed, () => t.get('/api/v1/posts?scope=all'), () => t.mock.getFeed({ scope: 'all' } as never));
    expect(mock.detailKeys).toEqual(real.detailKeys);
  });
});

describe('error envelope parity', () => {
  it('every error the mock can return is an ApiError whose status is the one the real server uses for that code', async () => {
    const t = await trips();
    const probes: [string, () => Promise<MockResult<unknown>>][] = [
      ['getTrip missing', () => t.mock.getTrip('nope')],
      ['getPlanBatch missing', () => t.mock.getPlanBatch('nope')],
      ['patch stale', () => t.mock.patchTrip(t.tripId, patchBody(9, titleOp) as never)],
      ['feed bad cursor', () => t.mock.getFeed({ scope: 'public', cursor: 'zzz' })],
      ['getJob missing', () => t.mock.getJob('nope')],
    ];
    for (const [label, run] of probes) {
      const r = await run();
      expect(r.ok, label).toBe(false);
      if (r.ok) continue;
      expect(ApiError.safeParse(r.error).success, label).toBe(true);
      expect(typeof r.error.requestId, label).toBe('string');
      expect(r.error.retryable, label).toBe(false);
    }
  });
});
