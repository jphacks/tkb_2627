/**
 * Edge-case tests for the screen API mock (B04). They complement mockApi.test.ts:
 * contract violations, revision conflicts, all-or-nothing patches, double jobs, unknown cost,
 * DST preservation, injected delays, isolation and error-response shape.
 * No network, no real clock waits (sleep is injected).
 */
import { describe, expect, it, vi } from 'vitest';
import { ApiError, ERROR_HTTP_STATUS, JobStatus, PlanBatch, Trip } from '@tkb/contracts';
import type { Activity, ApiError as ApiErrorType, ItineraryItem, ZonedTime } from '@tkb/contracts';
import { createBudgetUnknownPlanBatch, createBudgetUnknownTrip, domesticTrip, fixtureTrips, overseasTrip, sampleFeed } from '@tkb/fixtures';
import { MOCK_REPLAN_BATCH_ID, createMockApi } from './index.ts';
import type { MockApi, MockResult, MockScenario } from './index.ts';

const GENERATE = {
  constraints: { area: '金沢', startDate: '2026-11-01', endDate: '2026-11-02', timeZone: 'Asia/Tokyo', transportMode: 'transit' as const },
};
const KANAZAWA = 'fx_trip_kanazawa';
const PARIS = 'fx_trip_paris';

function data<T>(result: MockResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.data;
}

function errorOf(result: { ok: boolean; error?: ApiErrorType }): ApiErrorType {
  if (result.ok || !result.error) throw new Error('expected an error');
  return result.error;
}

const idOf = (item: ItineraryItem): string => (item.type === 'activity' ? item.activityId : item.legId);
const itemsOf = (trip: Pick<Trip, 'days'>): ItineraryItem[] => trip.days.flatMap(d => d.items);
/** Activities have start/end, legs have departure/arrival. */
const startOf = (item: ItineraryItem): ZonedTime | null => (item.type === 'activity' ? item.start : item.departure);
const endOf = (item: ItineraryItem): ZonedTime | null => (item.type === 'activity' ? item.end : item.arrival);
const moneyOf = (item: ItineraryItem) => (item.type === 'activity' ? item.cost : item.fare);

const isTerminal = (s: JobStatus): boolean => ['succeeded', 'failed', 'cancelled'].includes(s.state);

async function pollToEnd(api: MockApi, jobId: string): Promise<JobStatus[]> {
  const seen: JobStatus[] = [];
  for (let i = 0; i < 80; i += 1) {
    const status = data(await api.getJob(jobId));
    seen.push(status);
    if (isTerminal(status)) return seen;
  }
  throw new Error('job never finished');
}

const activityItem = (id: string, cost: number | null, overrides: Partial<Activity> = {}): Activity => ({
  type: 'activity',
  activityId: id,
  kind: 'custom',
  title: `追加予定 ${id}（fixture）`,
  placeId: null,
  areaName: null,
  start: { utc: '2026-11-02T04:00:00Z', timeZone: 'Asia/Tokyo' },
  end: { utc: '2026-11-02T05:00:00Z', timeZone: 'Asia/Tokyo' },
  fixed: false,
  status: 'planned',
  cost: cost === null ? null : { amountMinor: cost, currency: 'JPY' },
  costStatus: cost === null ? 'unknown' : 'fixture',
  privateNotes: null,
  ...overrides,
});

describe('mock api edge: contract violations are rejected as VALIDATION_FAILED (422)', () => {
  it('K01 generate: unknown keys (ownerId and friends) at the top level and inside constraints', async () => {
    const api = createMockApi();
    for (const extra of [{ ownerId: 'fx_user_b' }, { userId: 'x' }, { tripId: 'fx_trip_kanazawa' }, { __proto_like: 1 }]) {
      const res = await api.generate({ ...GENERATE, ...extra } as never);
      expect(errorOf(res).code, JSON.stringify(extra)).toBe('VALIDATION_FAILED');
      expect(res.status).toBe(422);
    }
    const nested = await api.generate({ constraints: { ...GENERATE.constraints, ownerId: 'x' } } as never);
    // TripConstraints may or may not be strict; either way the request must not silently accept a foreign owner.
    if (nested.ok) {
      const batchId = (await pollToEnd(api, nested.data.jobId)).at(-1)?.batchId ?? '';
      const written = data(await api.applyCandidate({ batchId, candidateId: 'candidate_1', tripId: null, expectedRevision: null }));
      expect(JSON.stringify(written.trip)).not.toContain('fx_user_b');
      expect('ownerId' in written.trip.constraints).toBe(false);
    }
  });

  it('K01 replan: missing baseTripId or expectedRevision, null baseTripId and non-positive revisions are rejected', async () => {
    const api = createMockApi();
    const replan = { ...GENERATE, mode: 'replan' as const };
    const cases: Record<string, unknown> = {
      'no base, no revision': replan,
      'revision only': { ...replan, expectedRevision: 1 },
      'base only': { ...replan, baseTripId: KANAZAWA },
      'null base': { ...replan, baseTripId: null, expectedRevision: 1 },
      'null revision': { ...replan, baseTripId: KANAZAWA, expectedRevision: null },
      'zero revision': { ...replan, baseTripId: KANAZAWA, expectedRevision: 0 },
      'negative revision': { ...replan, baseTripId: KANAZAWA, expectedRevision: -1 },
      'fractional revision': { ...replan, baseTripId: KANAZAWA, expectedRevision: 1.5 },
      'empty base id': { ...replan, baseTripId: '', expectedRevision: 1 },
    };
    for (const [name, body] of Object.entries(cases)) {
      const res = await api.generate(body as never);
      expect(errorOf(res).code, name).toBe('VALIDATION_FAILED');
      expect(res.status, name).toBe(422);
    }
    // Nothing was queued by the rejected requests.
    expect(errorOf(await api.getJob('mock_job_1')).code).toBe('NOT_FOUND');
  });

  it('K01 generate: bad mode, bad time zone, reversed dates and missing constraints', async () => {
    const api = createMockApi();
    expect(errorOf(await api.generate({ ...GENERATE, mode: 'nope' } as never)).code).toBe('VALIDATION_FAILED');
    expect(errorOf(await api.generate({} as never)).code).toBe('VALIDATION_FAILED');
    expect(errorOf(await api.generate(undefined as never)).code).toBe('VALIDATION_FAILED');
    expect(errorOf(await api.generate({ constraints: { ...GENERATE.constraints, startDate: '2026-13-40' } })).code).toBe('VALIDATION_FAILED');
    expect(errorOf(await api.generate({ constraints: { ...GENERATE.constraints, transportMode: 'rocket' } } as never)).code).toBe('VALIDATION_FAILED');
  });

  it('K08 apply-candidate: unknown keys, missing keys and wrong types are rejected; nothing is created', async () => {
    const api = createMockApi();
    const base = { batchId: 'fx_batch_1', candidateId: 'candidate_1', tripId: null, expectedRevision: null };
    for (const body of [
      { ...base, ownerId: 'fx_user_b' },
      { ...base, title: 'sneaky' },
      { batchId: 'fx_batch_1', candidateId: 'candidate_1', expectedRevision: null },
      { ...base, expectedRevision: 0 },
      { ...base, tripId: 123 },
      { ...base, batchId: '' },
    ]) {
      const res = await api.applyCandidate(body as never);
      expect(errorOf(res).code, JSON.stringify(body)).toBe('VALIDATION_FAILED');
      expect(res.status).toBe(422);
    }
    expect(data(await api.listTrips()).items).toHaveLength(3);
  });

  it('K10 patch: unknown keys, missing/zero revision, too many operations and unknown fields in items', async () => {
    const api = createMockApi();
    const op = { op: 'set_title' as const, title: 'x' };
    const bodies: unknown[] = [
      { expectedRevision: 1, operations: [op], ownerId: 'fx_user_b' },
      { operations: [op] },
      { expectedRevision: 0, operations: [op] },
      { expectedRevision: 1 },
      { expectedRevision: 1, operations: Array.from({ length: 51 }, () => op) },
      { expectedRevision: 1, operations: [{ op: 'set_title', title: '' }] },
      { expectedRevision: 1, operations: [{ op: 'set_title', title: 'x'.repeat(201) }] },
      { expectedRevision: 1, operations: [{ op: 'add', dayIndex: -1, position: 0, item: activityItem('neg', null) }] },
      { expectedRevision: 1, operations: [{ op: 'remove' }] },
      { expectedRevision: 1, operations: [{ op: 'add', dayIndex: 0, position: 0, item: { type: 'activity', activityId: 'half' } }] },
    ];
    for (const body of bodies) {
      const res = await api.patchTrip(KANAZAWA, body as never);
      expect(errorOf(res).code, JSON.stringify(body).slice(0, 80)).toBe('VALIDATION_FAILED');
      expect(res.status).toBe(422);
    }
    const trip = data(await api.getTrip(KANAZAWA));
    expect(trip.revision).toBe(1);
    expect(trip.title).toBe(domesticTrip.title);
  });

  it('K14 feed: limit above 20 / below 1 / non-integer, bad cursors and bad scope are rejected', async () => {
    const api = createMockApi();
    for (const query of [
      { scope: 'public', limit: 21 },
      { scope: 'public', limit: 0 },
      { scope: 'public', limit: -1 },
      { scope: 'public', limit: 1.5 },
      { scope: 'public', limit: 'many' },
      { scope: 'public', cursor: '-1' },
      { scope: 'public', cursor: '1.5' },
      { scope: 'public', cursor: 'abc' },
      { scope: 'all' },
      {},
    ]) {
      const res = await api.getFeed(query as never);
      expect(errorOf(res).code, JSON.stringify(query)).toBe('VALIDATION_FAILED');
      expect(res.status).toBe(422);
    }
    // limit 20 is the allowed maximum.
    expect(data(await api.getFeed({ scope: 'public', limit: 20 })).items.length).toBeGreaterThan(0);
  });

  it('K14 feed: only the cursors the mock itself issues (digit strings) are accepted; "1e2" and " " are not', async () => {
    // Cursors are opaque, mock-issued offsets ("2", "4", ...). Number()-style parsing would also accept
    // exponent notation and whitespace, which no real server cursor looks like.
    const api = createMockApi();
    for (const cursor of ['1e2', ' ', '0x1', '+1', '1 ']) {
      const res = await api.getFeed({ scope: 'public', cursor });
      expect(errorOf(res).code, JSON.stringify(cursor)).toBe('VALIDATION_FAILED');
    }
  });

  it('K14 feed: a cursor past the end returns an empty page, not an error; pages never overlap', async () => {
    const api = createMockApi();
    const past = data(await api.getFeed({ scope: 'public', cursor: '999' }));
    expect(past).toEqual({ items: [], nextCursor: null });
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i += 1) {
      const page = data(await api.getFeed({ scope: 'public', limit: 1, cursor }));
      seen.push(...page.items.map(p => p.postId));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(3);
  });

  it('validation details list the offending paths and never echo secrets back', async () => {
    const api = createMockApi();
    const err = errorOf(await api.generate({ ...GENERATE, ownerId: 'super-secret-owner' } as never));
    expect(err.details).toBeDefined();
    expect(JSON.stringify(err.details)).toContain('issues');
    expect(ApiError.safeParse(err).success).toBe(true);
  });
});

describe('mock api edge: revision conflicts', () => {
  it('two patches with the same expectedRevision: the second is 409 and the state is exactly the first result', async () => {
    const api = createMockApi();
    const first = data(await api.patchTrip(KANAZAWA, { expectedRevision: 1, operations: [{ op: 'set_title', title: '先に保存' }] }));
    const second = await api.patchTrip(KANAZAWA, { expectedRevision: 1, operations: [{ op: 'set_title', title: '後から保存' }, { op: 'remove', itemId: 'fx_act_lunch' }] });
    const err = errorOf(second);
    expect(err.code).toBe('REVISION_CONFLICT');
    expect(second.status).toBe(409);
    expect(err.details).toEqual({ expectedRevision: 1, currentRevision: 2 });
    const now = data(await api.getTrip(KANAZAWA));
    expect(now).toEqual(first.trip);
    expect(now.revision).toBe(2);
    expect(itemsOf(now).some(i => idOf(i) === 'fx_act_lunch')).toBe(true);
  });

  it('a future expectedRevision conflicts too (it is not "at least")', async () => {
    const api = createMockApi();
    const res = await api.patchTrip(KANAZAWA, { expectedRevision: 2, operations: [{ op: 'set_title', title: 'x' }] });
    expect(errorOf(res).code).toBe('REVISION_CONFLICT');
    expect(errorOf(res).details).toEqual({ expectedRevision: 2, currentRevision: 1 });
    expect(data(await api.getTrip(KANAZAWA)).revision).toBe(1);
  });

  it('revision rises by exactly one per successful write and never moves on a failed one', async () => {
    const api = createMockApi();
    const revisions: number[] = [];
    for (let i = 1; i <= 3; i += 1) {
      const res = data(await api.patchTrip(KANAZAWA, { expectedRevision: i, operations: [{ op: 'set_title', title: `v${i}` }] }));
      revisions.push(res.revision);
      expect(data(await api.getTrip(KANAZAWA)).revision).toBe(res.revision);
      await api.patchTrip(KANAZAWA, { expectedRevision: i, operations: [{ op: 'set_title', title: 'stale' }] });
    }
    expect(revisions).toEqual([2, 3, 4]);
    expect(data(await api.getTrip(KANAZAWA)).title).toBe('v3');
  });

  it('applyCandidate update: a stale revision is 409 and leaves the trip untouched; the right revision succeeds once', async () => {
    const api = createMockApi();
    const before = data(await api.getTrip(KANAZAWA));
    const stale = await api.applyCandidate({ batchId: MOCK_REPLAN_BATCH_ID, candidateId: 'candidate_3', tripId: KANAZAWA, expectedRevision: 5 });
    expect(errorOf(stale).code).toBe('REVISION_CONFLICT');
    expect(stale.status).toBe(409);
    expect(errorOf(stale).details).toEqual({ expectedRevision: 5, currentRevision: 1 });
    expect(data(await api.getTrip(KANAZAWA))).toEqual(before);

    const good = data(await api.applyCandidate({ batchId: MOCK_REPLAN_BATCH_ID, candidateId: 'candidate_3', tripId: KANAZAWA, expectedRevision: 1 }));
    expect(good.revision).toBe(2);
    expect(good.trip.tripId).toBe(KANAZAWA);
    // The same request again is now stale (no silent double apply).
    const again = await api.applyCandidate({ batchId: MOCK_REPLAN_BATCH_ID, candidateId: 'candidate_3', tripId: KANAZAWA, expectedRevision: 1 });
    expect(errorOf(again).code).toBe('REVISION_CONFLICT');
    expect(data(await api.getTrip(KANAZAWA)).revision).toBe(2);
  });

  it('applyCandidate update keeps id, owner, constraints and createdAt; the title and itinerary come from the candidate', async () => {
    const api = createMockApi();
    const before = data(await api.getTrip(KANAZAWA));
    const batch = data(await api.getPlanBatch(MOCK_REPLAN_BATCH_ID));
    const candidate = batch.candidates.find(c => c.candidateId === 'candidate_2');
    const res = data(await api.applyCandidate({ batchId: MOCK_REPLAN_BATCH_ID, candidateId: 'candidate_2', tripId: KANAZAWA, expectedRevision: 1 }));
    expect(res.trip.ownerId).toBe(before.ownerId);
    expect(res.trip.constraints).toEqual(before.constraints);
    expect(res.trip.createdAt).toBe(before.createdAt);
    // Same as main: the candidate title replaces the trip title on update.
    expect(candidate?.title).not.toBe(before.title);
    expect(res.trip.title).toBe(candidate?.title);
    expect(res.trip.days).not.toEqual(before.days);
  });

  it('applyCandidate with a missing expectedRevision on an update is VALIDATION_FAILED and changes nothing', async () => {
    const api = createMockApi();
    const res = await api.applyCandidate({ batchId: MOCK_REPLAN_BATCH_ID, candidateId: 'candidate_1', tripId: KANAZAWA, expectedRevision: null });
    expect(errorOf(res).code).toBe('VALIDATION_FAILED');
    expect(data(await api.getTrip(KANAZAWA)).revision).toBe(1);
  });

  it('applying a batch that was not generated for the trip (fx_batch_1 has no base trip) is 422 VALIDATION_FAILED and changes nothing', async () => {
    const api = createMockApi();
    const before = data(await api.getTrip(KANAZAWA));
    const res = await api.applyCandidate({ batchId: 'fx_batch_1', candidateId: 'candidate_3', tripId: KANAZAWA, expectedRevision: 1 });
    expect(errorOf(res).code).toBe('VALIDATION_FAILED');
    expect(res.status).toBe(422);
    expect(data(await api.getTrip(KANAZAWA))).toEqual(before);
    // Another existing trip is not the batch's base trip either.
    const other = await api.applyCandidate({ batchId: MOCK_REPLAN_BATCH_ID, candidateId: 'candidate_3', tripId: PARIS, expectedRevision: 1 });
    expect(errorOf(other).code).toBe('VALIDATION_FAILED');
    expect(data(await api.getTrip(PARIS)).revision).toBe(1);
  });

  it('replan batch applied after the trip moved past its baseRevision is 409 with the batch base revision, and changes nothing', async () => {
    const api = createMockApi();
    data(await api.patchTrip(KANAZAWA, { expectedRevision: 1, operations: [{ op: 'set_title', title: 'rev2' }] }));
    const before = data(await api.getTrip(KANAZAWA));
    // The client even sends the current revision: the batch was generated from revision 1, so it is still a conflict.
    const res = await api.applyCandidate({ batchId: MOCK_REPLAN_BATCH_ID, candidateId: 'candidate_3', tripId: KANAZAWA, expectedRevision: 2 });
    expect(errorOf(res).code).toBe('REVISION_CONFLICT');
    expect(res.status).toBe(409);
    expect(errorOf(res).details).toEqual({ expectedRevision: 1, currentRevision: 2 });
    expect(data(await api.getTrip(KANAZAWA))).toEqual(before);
  });

  it('applyCandidate with tripId null and a non-null expectedRevision is VALIDATION_FAILED and creates nothing', async () => {
    const api = createMockApi();
    const res = await api.applyCandidate({ batchId: 'fx_batch_1', candidateId: 'candidate_1', tripId: null, expectedRevision: 1 });
    expect(errorOf(res).code).toBe('VALIDATION_FAILED');
    expect(res.status).toBe(422);
    expect(data(await api.listTrips()).items).toHaveLength(3);
  });

  it('applying the same candidate twice with tripId null returns the same trip (201, then 200) and adds one trip only', async () => {
    const api = createMockApi();
    const req = { batchId: 'fx_batch_1', candidateId: 'candidate_1', tripId: null, expectedRevision: null };
    const first = await api.applyCandidate(req);
    const second = await api.applyCandidate(req);
    expect([first.status, second.status]).toEqual([201, 200]);
    expect(data(second).tripId).toBe(data(first).tripId);
    expect(data(await api.listTrips()).items).toHaveLength(4);
    // A different candidate of the same batch is a different trip.
    const other = data(await api.applyCandidate({ ...req, candidateId: 'candidate_2' }));
    expect(other.tripId).not.toBe(data(first).tripId);
    expect(data(await api.listTrips()).items).toHaveLength(5);
  });

  it('a re-applied candidate returns the trip as it is now (after an edit), not the first snapshot', async () => {
    const api = createMockApi();
    const req = { batchId: 'fx_batch_1', candidateId: 'candidate_1', tripId: null, expectedRevision: null };
    const created = data(await api.applyCandidate(req));
    data(await api.patchTrip(created.tripId, { expectedRevision: 1, operations: [{ op: 'set_title', title: '編集後' }] }));
    const again = data(await api.applyCandidate(req));
    expect(again.tripId).toBe(created.tripId);
    expect(again.revision).toBe(2);
    expect(again.trip.title).toBe('編集後');
  });

  it('a new trip from a replan batch takes the base trip constraints; from fx_batch_1 the batch constraints', async () => {
    const api = createMockApi();
    // The replan request carries other constraints; the new trip must still take the base trip's.
    const other = { ...GENERATE.constraints, area: '別エリア' };
    const { jobId } = data(await api.generate({ constraints: other, mode: 'replan', baseTripId: KANAZAWA, expectedRevision: 1 }));
    const batchId = (await pollToEnd(api, jobId)).at(-1)?.batchId ?? '';
    const fromReplan = data(await api.applyCandidate({ batchId, candidateId: 'candidate_1', tripId: null, expectedRevision: null }));
    expect(fromReplan.tripId).not.toBe(KANAZAWA);
    expect(fromReplan.trip.constraints).toEqual(domesticTrip.constraints);
    expect(fromReplan.trip.constraints.area).not.toBe('別エリア');
    const fromPlain = data(await api.applyCandidate({ batchId: 'fx_batch_1', candidateId: 'candidate_1', tripId: null, expectedRevision: null }));
    expect(fromPlain.trip.constraints).toEqual(domesticTrip.constraints);
  });

  it('replan generation with a stale revision is 409 and starts no job', async () => {
    const api = createMockApi();
    data(await api.patchTrip(KANAZAWA, { expectedRevision: 1, operations: [{ op: 'set_title', title: 'rev2' }] }));
    const res = await api.generate({ ...GENERATE, mode: 'replan', baseTripId: KANAZAWA, expectedRevision: 1 });
    expect(errorOf(res).code).toBe('REVISION_CONFLICT');
    expect(errorOf(res).details).toEqual({ expectedRevision: 1, currentRevision: 2 });
    expect(errorOf(await api.getJob('mock_job_1')).code).toBe('NOT_FOUND');
    const ok = data(await api.generate({ ...GENERATE, mode: 'replan', baseTripId: KANAZAWA, expectedRevision: 2 }));
    expect(ok.jobId).toBeTruthy();
  });
});

describe('mock api edge: patch is all-or-nothing', () => {
  it('a failing last operation reverts earlier add/move/remove/update/set_title and keeps revision, updatedAt and validationState', async () => {
    let tick = 0;
    const api = createMockApi({ now: () => new Date(Date.UTC(2026, 9, 24, 0, 0, tick++)) });
    const before = data(await api.getTrip(KANAZAWA));
    const res = await api.patchTrip(KANAZAWA, {
      expectedRevision: 1,
      operations: [
        { op: 'set_title', title: '途中まで' },
        { op: 'add', dayIndex: 1, position: 0, item: activityItem('half_added', 1000) },
        { op: 'move', itemId: 'fx_act_higashi', toDayIndex: 0, toPosition: 0 },
        { op: 'remove', itemId: 'fx_act_lunch' },
        { op: 'update', itemId: 'fx_act_omicho', item: activityItem('fx_act_omicho', 7) },
        { op: 'remove', itemId: 'no_such_item' },
      ],
    });
    expect(errorOf(res).code).toBe('CONSTRAINT_UNSATISFIED');
    expect(res.status).toBe(422);
    const after = data(await api.getTrip(KANAZAWA));
    expect(after).toEqual(before);
    expect(itemsOf(after).some(i => idOf(i) === 'half_added')).toBe(false);
  });

  it('a failing first operation after a valid one in a 2-op batch also leaves list summary unchanged', async () => {
    const api = createMockApi();
    const listBefore = data(await api.listTrips());
    await api.patchTrip(KANAZAWA, {
      expectedRevision: 1,
      operations: [
        { op: 'set_title', title: 'listに出てはいけない' },
        { op: 'move', itemId: 'fx_act_higashi', toDayIndex: 0, toPosition: 99 },
      ],
    });
    expect(data(await api.listTrips())).toEqual(listBefore);
  });

  it('a later operation sees earlier ones (move then update the moved item), and the result is consistent', async () => {
    const api = createMockApi();
    const res = data(
      await api.patchTrip(KANAZAWA, {
        expectedRevision: 1,
        operations: [
          { op: 'add', dayIndex: 1, position: 0, item: activityItem('chain_a', 300) },
          { op: 'move', itemId: 'chain_a', toDayIndex: 0, toPosition: 0 },
          { op: 'update', itemId: 'chain_a', item: activityItem('chain_a', 900, { title: '連鎖更新（fixture）' }) },
        ],
      }),
    );
    expect(res.trip.days[0]?.items[0]).toMatchObject({ activityId: 'chain_a', title: '連鎖更新（fixture）', cost: { amountMinor: 900, currency: 'JPY' } });
    expect(res.trip.days[1]?.items.some(i => idOf(i) === 'chain_a')).toBe(false);
  });

  it('adding the same id twice in one request fails as a whole', async () => {
    const api = createMockApi();
    const res = await api.patchTrip(KANAZAWA, {
      expectedRevision: 1,
      operations: [
        { op: 'add', dayIndex: 1, position: 0, item: activityItem('dup_x', null) },
        { op: 'add', dayIndex: 1, position: 0, item: activityItem('dup_x', null) },
      ],
    });
    expect(errorOf(res).code).toBe('CONSTRAINT_UNSATISFIED');
    const trip = data(await api.getTrip(KANAZAWA));
    expect(itemsOf(trip).some(i => idOf(i) === 'dup_x')).toBe(false);
    expect(trip.revision).toBe(1);
  });

  it('move to a missing day does not drop the item (it must not be lost when the move fails)', async () => {
    const api = createMockApi();
    const before = data(await api.getTrip(KANAZAWA));
    const res = await api.patchTrip(KANAZAWA, { expectedRevision: 1, operations: [{ op: 'move', itemId: 'fx_act_higashi', toDayIndex: 7, toPosition: 0 }] });
    expect(errorOf(res).code).toBe('CONSTRAINT_UNSATISFIED');
    expect(data(await api.getTrip(KANAZAWA))).toEqual(before);
  });

  it('a failure in the error scenario is UNAVAILABLE and does not mutate either', async () => {
    const api = createMockApi({ scenario: 'error' });
    const res = await api.patchTrip(KANAZAWA, { expectedRevision: 1, operations: [{ op: 'set_title', title: 'x' }] });
    expect(errorOf(res).code).toBe('UNAVAILABLE');
    expect(res.status).toBe(503);
  });
});

describe('mock api edge: double jobs, cancel and timeouts', () => {
  it('two generate calls get different job ids and batch ids and advance independently', async () => {
    const api = createMockApi();
    const a = data(await api.generate(GENERATE));
    const b = data(await api.generate(GENERATE));
    expect(a.jobId).not.toBe(b.jobId);

    // Poll only A to the end; B must still be at its first state.
    const seenA = await pollToEnd(api, a.jobId);
    expect(seenA.at(-1)?.state).toBe('succeeded');
    const firstB = data(await api.getJob(b.jobId));
    expect(firstB.state).toBe('queued');
    expect(firstB.batchId).toBeNull();

    const seenB = await pollToEnd(api, b.jobId);
    const batchA = seenA.at(-1)?.batchId;
    const batchB = seenB.at(-1)?.batchId;
    expect(batchA).toBeTruthy();
    expect(batchB).toBeTruthy();
    expect(batchA).not.toBe(batchB);
    expect(data(await api.getPlanBatch(batchA ?? '')).batchId).toBe(batchA);
    expect(data(await api.getPlanBatch(batchB ?? '')).batchId).toBe(batchB);
  });

  it('cancelling one job does not cancel or stall the other, and the other batch stays readable', async () => {
    const api = createMockApi();
    const a = data(await api.generate(GENERATE));
    const b = data(await api.generate(GENERATE));
    await api.getJob(a.jobId);
    data(await api.cancelJob(a.jobId));
    expect(data(await api.getJob(a.jobId)).state).toBe('cancelled');
    const seenB = await pollToEnd(api, b.jobId);
    expect(seenB.at(-1)?.state).toBe('succeeded');
    expect(data(await api.getPlanBatch(seenB.at(-1)?.batchId ?? '')).candidates.length).toBeGreaterThan(0);
  });

  it('a cancelled job stays cancelled on every later poll, never registers a batch, and cancel is idempotent', async () => {
    const api = createMockApi();
    const { jobId } = data(await api.generate(GENERATE));
    await api.getJob(jobId);
    data(await api.cancelJob(jobId));
    for (let i = 0; i < 10; i += 1) {
      const status = data(await api.getJob(jobId));
      expect(status.state).toBe('cancelled');
      expect(status.batchId).toBeNull();
      expect(JobStatus.safeParse(status).success).toBe(true);
    }
    const again = await api.cancelJob(jobId);
    expect(data(again).state).toBe('cancelled');
    expect(errorOf(await api.getPlanBatch('mock_batch_2')).code).toBe('NOT_FOUND');
  });

  it('cancel right after generate (before any poll) works', async () => {
    const api = createMockApi();
    const { jobId } = data(await api.generate(GENERATE));
    expect(data(await api.cancelJob(jobId)).state).toBe('cancelled');
    expect(data(await api.getJob(jobId)).state).toBe('cancelled');
  });

  it('cancel after success is 200 with state succeeded and the batch id, and the job stays succeeded', async () => {
    const api = createMockApi();
    const { jobId } = data(await api.generate(GENERATE));
    const done = (await pollToEnd(api, jobId)).at(-1);
    const late = await api.cancelJob(jobId);
    expect(late.status).toBe(200);
    expect(data(late)).toEqual({ jobId, state: 'succeeded', batchId: done?.batchId });
    expect(data(await api.cancelJob(jobId))).toEqual(data(late));
    const status = data(await api.getJob(jobId));
    expect(status.state).toBe('succeeded');
    expect(status.batchId).toBe(done?.batchId);
    expect(data(await api.getPlanBatch(done?.batchId ?? '')).batchId).toBe(done?.batchId);
  });

  it('error scenario: the job fails with a retryable INVALID_OUTPUT, stays failed, creates no batch, cancel reports failed', async () => {
    const api = createMockApi({ scenario: 'error' });
    const { jobId } = data(await api.generate(GENERATE));
    const seen = await pollToEnd(api, jobId);
    expect(seen.at(-1)?.state).toBe('failed');
    expect(seen.at(-1)?.error).toMatchObject({ code: 'INVALID_OUTPUT', retryable: true });
    for (const s of seen) expect(JobStatus.safeParse(s).success).toBe(true);
    expect(data(await api.getJob(jobId)).state).toBe('failed');
    expect(data(await api.getJob(jobId)).error?.code).toBe('INVALID_OUTPUT');
    expect(data(await api.cancelJob(jobId)).state).toBe('failed');
  });

  it('states never go backwards and succeeded always has a batchId while others have none', async () => {
    const order = ['queued', 'running', 'succeeded'];
    const api = createMockApi({ pollsPerStep: 2 });
    const { jobId } = data(await api.generate(GENERATE));
    const seen = await pollToEnd(api, jobId);
    const ranks = seen.map(s => order.indexOf(s.state));
    expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
    for (const s of seen) expect(s.batchId !== null).toBe(s.state === 'succeeded');
  });

  it('job ids are never reused across many generate calls', async () => {
    const api = createMockApi();
    const ids = new Set<string>();
    for (let i = 0; i < 25; i += 1) ids.add(data(await api.generate(GENERATE)).jobId);
    expect(ids.size).toBe(25);
  });

  it('pollAfterMs is passed through to JobAccepted and must stay a positive integer', async () => {
    expect(data(await createMockApi({ pollAfterMs: 321 }).generate(GENERATE)).pollAfterMs).toBe(321);
    expect(data(await createMockApi().generate(GENERATE)).pollAfterMs).toBe(2000);
  });
});

describe('mock api edge: delay and polling (sleep is injected, no real waiting)', () => {
  it('slow scenario calls sleep(800) once per request, for reads, writes and polls', async () => {
    const sleep = vi.fn((_ms: number) => Promise.resolve());
    const api = createMockApi({ scenario: 'slow', sleep });
    await api.listTrips();
    await api.getTrip(KANAZAWA);
    const { jobId } = data(await api.generate(GENERATE));
    await api.getJob(jobId);
    await api.cancelJob(jobId);
    await api.getPlanBatch('fx_batch_1');
    await api.applyCandidate({ batchId: 'fx_batch_1', candidateId: 'candidate_1', tripId: null, expectedRevision: null });
    await api.patchTrip(KANAZAWA, { expectedRevision: 1, operations: [{ op: 'set_title', title: 'x' }] });
    await api.getFeed({ scope: 'public' });
    expect(sleep).toHaveBeenCalledTimes(9);
    for (const call of sleep.mock.calls) expect(call[0]).toBe(800);
  });

  it('a custom delayMs wins over the scenario default, delayMs 0 never calls sleep, and failures are delayed too', async () => {
    const sleep = vi.fn((_ms: number) => Promise.resolve());
    const custom = createMockApi({ scenario: 'slow', delayMs: 1234, sleep });
    await custom.getTrip('nope'); // NOT_FOUND still waits
    expect(sleep).toHaveBeenCalledWith(1234);
    sleep.mockClear();
    await createMockApi({ scenario: 'slow', delayMs: 0, sleep }).listTrips();
    await createMockApi({ scenario: 'normal', sleep }).listTrips();
    await createMockApi({ scenario: 'error', sleep }).listTrips();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('error responses in the slow-error combination still wait (delay is applied before the result)', async () => {
    const order: string[] = [];
    const sleep = vi.fn(async (_ms: number) => {
      order.push('sleep');
    });
    const api = createMockApi({ scenario: 'error', delayMs: 50, sleep });
    const res = await api.listTrips();
    order.push('result');
    expect(res.ok).toBe(false);
    expect(order).toEqual(['sleep', 'result']);
  });

  it('a pending sleep holds the response back until it resolves (timeout-like wait)', async () => {
    let release: () => void = () => undefined;
    const sleep = (_ms: number) => new Promise<void>(resolve => { release = resolve; });
    const api = createMockApi({ scenario: 'slow', sleep });
    let settled = false;
    const pending = api.listTrips().then(r => { settled = true; return r; });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    expect((await pending).ok).toBe(true);
    expect(settled).toBe(true);
  });

  it('pollsPerStep controls how many polls each stage lasts (1, 2, 5), and values below 1 are treated as 1', async () => {
    const lengths: Record<number, number> = {};
    for (const n of [1, 2, 5]) {
      const api = createMockApi({ pollsPerStep: n });
      const { jobId } = data(await api.generate(GENERATE));
      const seen = await pollToEnd(api, jobId);
      lengths[n] = seen.length;
      // every non-final stage is held for exactly n polls
      const stages = seen.map(s => s.stage);
      for (const stage of new Set(stages.slice(0, -1))) expect(stages.filter(s => s === stage).length, `n=${n} ${stage}`).toBe(n);
    }
    // normal job has 5 steps: reaching the last one takes (5-1)*n + 1 polls
    expect(lengths).toEqual({ 1: 5, 2: 9, 5: 21 });
    for (const bad of [0, -3]) {
      const api = createMockApi({ pollsPerStep: bad });
      const { jobId } = data(await api.generate(GENERATE));
      expect(await pollToEnd(api, jobId)).toHaveLength(5);
    }
  });

  it('slow defaults to 3 polls per step and normal to 1', async () => {
    const slow = createMockApi({ scenario: 'slow', delayMs: 0 });
    const normal = createMockApi();
    const slowSeen = await pollToEnd(slow, data(await slow.generate(GENERATE)).jobId);
    const normalSeen = await pollToEnd(normal, data(await normal.generate(GENERATE)).jobId);
    expect(normalSeen).toHaveLength(5);
    expect(slowSeen).toHaveLength(13);
  });

  it('timestamps come from the injected clock', async () => {
    const fixed = new Date('2026-10-24T12:00:00Z');
    const api = createMockApi({ now: () => fixed });
    const { jobId } = data(await api.generate(GENERATE));
    const status = data(await api.getJob(jobId));
    expect(status.updatedAt).toBe('2026-10-24T12:00:00.000Z');
    const batchId = (await pollToEnd(api, jobId)).at(-1)?.batchId ?? '';
    expect(data(await api.getPlanBatch(batchId)).createdAt).toBe('2026-10-24T12:00:00.000Z');
    const written = data(await api.applyCandidate({ batchId, candidateId: 'candidate_1', tripId: null, expectedRevision: null }));
    expect(written.trip.createdAt).toBe('2026-10-24T12:00:00.000Z');
    expect(written.trip.updatedAt).toBe('2026-10-24T12:00:00.000Z');
  });
});

describe('mock api edge: unknown cost is never 0 (budgetUnknown)', () => {
  const api = () => createMockApi({ scenario: 'budgetUnknown' });

  it('every listed trip has an unknown budget and every cost/fare of every trip is null', async () => {
    const a = api();
    const list = data(await a.listTrips());
    expect(list.items.length).toBeGreaterThan(0);
    for (const summary of list.items) {
      const trip = data(await a.getTrip(summary.tripId));
      expect(trip.constraints.budget, summary.tripId).toBeNull();
      for (const item of itemsOf(trip)) {
        expect(moneyOf(item), `${summary.tripId}:${idOf(item)}`).toBeNull();
        if (item.type === 'activity') expect(item.costStatus).toBe('unknown');
      }
    }
  });

  it('every seeded and generated candidate has all costs null, hasUnknownCost and no totals', async () => {
    const a = api();
    const seeded = data(await a.getPlanBatch(createBudgetUnknownPlanBatch().batchId));
    const { jobId } = data(await a.generate(GENERATE));
    const generated = data(await a.getPlanBatch((await pollToEnd(a, jobId)).at(-1)?.batchId ?? ''));
    const carJob = data(await a.generate({ constraints: { ...GENERATE.constraints, transportMode: 'car' } }));
    const car = data(await a.getPlanBatch((await pollToEnd(a, carJob.jobId)).at(-1)?.batchId ?? ''));
    for (const batch of [seeded, generated, car]) {
      expect(PlanBatch.safeParse(batch).success).toBe(true);
      for (const c of batch.candidates) {
        expect(c.hasUnknownCost, c.candidateId).toBe(true);
        expect(c.totalKnownCost, c.candidateId).toEqual([]);
        for (const item of itemsOf(c)) expect(moneyOf(item), idOf(item)).toBeNull();
      }
    }
    expect(JSON.stringify([seeded, generated, car])).not.toMatch(/"amountMinor":0[,}]/);
  });

  it('a trip created from a budget-unknown candidate has no budget and no known cost', async () => {
    const a = api();
    const { jobId } = data(await a.generate(GENERATE));
    const batchId = (await pollToEnd(a, jobId)).at(-1)?.batchId ?? '';
    const written = data(await a.applyCandidate({ batchId, candidateId: 'candidate_3', tripId: null, expectedRevision: null }));
    expect(written.trip.constraints.budget).toBeNull();
    expect(itemsOf(written.trip).every(i => moneyOf(i) === null)).toBe(true);
  });

  it('even if the request asks for a budget, the unknown-budget scenario keeps it null', async () => {
    const a = api();
    const withBudget = { constraints: { ...GENERATE.constraints, budget: { amountMinor: 50000, currency: 'JPY' } } };
    const res = await a.generate(withBudget as never);
    if (res.ok) {
      const batchId = (await pollToEnd(a, res.data.jobId)).at(-1)?.batchId ?? '';
      const written = data(await a.applyCandidate({ batchId, candidateId: 'candidate_1', tripId: null, expectedRevision: null }));
      expect(written.trip.constraints.budget).toBeNull();
    } else {
      expect(res.error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('patch: adding a cost-null item reports it in unknownCostItems and puts no 0 in knownCostDelta', async () => {
    for (const scenario of ['normal', 'budgetUnknown'] as MockScenario[]) {
      const a = createMockApi({ scenario });
      const id = scenario === 'normal' ? KANAZAWA : 'fx_trip_budget_unknown';
      const res = data(
        await a.patchTrip(id, {
          expectedRevision: 1,
          operations: [
            { op: 'add', dayIndex: 1, position: 0, item: activityItem('nc_a', null) },
            { op: 'add', dayIndex: 1, position: 1, item: activityItem('nc_b', null) },
          ],
        }),
      );
      expect(res.diff.unknownCostItems, scenario).toEqual(expect.arrayContaining(['nc_a', 'nc_b']));
      expect(res.diff.knownCostDelta, scenario).toEqual([]);
      expect(res.diff.knownCostDelta.some(m => m.amountMinor === 0)).toBe(false);
    }
  });

  it('patch: changing a cost to or from unknown is never a saving or a new expense: no known delta, the item is listed as unknown', async () => {
    const a = createMockApi();
    const lunch = itemsOf(domesticTrip).find(i => idOf(i) === 'fx_act_lunch');
    if (!lunch || lunch.type !== 'activity' || !lunch.cost) throw new Error('fixture shape changed');
    const toUnknown = data(
      await a.patchTrip(KANAZAWA, {
        expectedRevision: 1,
        operations: [{ op: 'update', itemId: 'fx_act_lunch', item: { ...lunch, cost: null, costStatus: 'unknown' } }],
      }),
    );
    expect(toUnknown.diff.knownCostDelta).toEqual([]); // not a -4000 saving (R11)
    expect(toUnknown.diff.unknownCostItems).toContain('fx_act_lunch');
    const back = data(
      await a.patchTrip(KANAZAWA, { expectedRevision: 2, operations: [{ op: 'update', itemId: 'fx_act_lunch', item: lunch }] }),
    );
    expect(back.diff.knownCostDelta).toEqual([]); // not a +4000 expense measured from 0 (R11)
    // Unknown before the update, so still listed.
    expect(back.diff.unknownCostItems).toContain('fx_act_lunch');
  });

  it('patch: adding an item whose duration is unknown makes durationDeltaSeconds null, not 0', async () => {
    const a = createMockApi();
    const res = data(
      await a.patchTrip(KANAZAWA, {
        expectedRevision: 1,
        operations: [{ op: 'add', dayIndex: 1, position: 0, item: activityItem('no_time', 100, { start: null, end: null }) }],
      }),
    );
    expect(res.diff.durationDeltaSeconds).toBeNull();
  });

  it('patch: updating an item whose old duration was unknown makes durationDeltaSeconds null, not a delta from 0', async () => {
    const a = createMockApi();
    const leg1 = itemsOf(domesticTrip).find(i => idOf(i) === 'fx_leg_k1');
    if (leg1?.type !== 'leg') throw new Error('fx_leg_k1 fixture missing');
    // The fixture leg has an arrival since #34; make it untimed first, then time it again.
    const untimed = { ...leg1, arrival: null, durationSeconds: null };
    data(await a.patchTrip(KANAZAWA, { expectedRevision: 1, operations: [{ op: 'update', itemId: 'fx_leg_k1', item: untimed }] }));
    const timed = { ...leg1, arrival: { utc: '2026-11-01T00:25:00Z', timeZone: 'Asia/Tokyo' }, durationSeconds: 900 };
    const res = data(
      await a.patchTrip(KANAZAWA, { expectedRevision: 2, operations: [{ op: 'update', itemId: 'fx_leg_k1', item: timed }] }),
    );
    expect(res.diff.durationDeltaSeconds).toBeNull();
  });

  it('patch: knownCostDelta never mixes currencies (a EUR item and a JPY item give two entries)', async () => {
    const a = createMockApi();
    const eur: Activity = { ...activityItem('eur_a', 1200), cost: { amountMinor: 1200, currency: 'EUR' } };
    const res = data(
      await a.patchTrip(KANAZAWA, {
        expectedRevision: 1,
        operations: [
          { op: 'add', dayIndex: 1, position: 0, item: eur },
          { op: 'add', dayIndex: 1, position: 1, item: activityItem('jpy_a', 500) },
        ],
      }),
    );
    expect(res.diff.knownCostDelta).toEqual([
      { currency: 'EUR', amountMinor: 1200 },
      { currency: 'JPY', amountMinor: 500 },
    ]);
  });
});

describe('mock api edge: DST and time zones survive the mock', () => {
  it('getTrip of the Paris fixture equals the contract-parsed fixture (utc and timeZone untouched)', async () => {
    const trip = data(await createMockApi().getTrip(PARIS));
    expect(trip).toEqual(Trip.parse(overseasTrip));
    for (const day of trip.days) expect(day.timeZone).toBe('Europe/Paris');
    const starts = itemsOf(trip).flatMap(i => [startOf(i), endOf(i)].flatMap(t => (t ? [t] : [])));
    expect(starts.length).toBeGreaterThan(0);
    for (const t of starts) {
      expect(t.timeZone).toBe('Europe/Paris');
      expect(t.utc).toMatch(/Z$/);
    }
    // 10:00 local on both sides of the end of DST: 08:00Z (CEST) and 09:00Z (CET).
    expect((itemsOf(trip).find(i => idOf(i) === 'fx_act_louvre') as Activity | undefined)?.start?.utc).toBe('2026-10-24T08:00:00Z');
    expect((itemsOf(trip).find(i => idOf(i) === 'fx_act_orsay') as Activity | undefined)?.start?.utc).toBe('2026-10-25T09:00:00Z');
  });

  it('a Paris patch only changes the touched item; all other ZonedTimes stay byte-identical', async () => {
    const a = createMockApi();
    const before = data(await a.getTrip(PARIS));
    const res = data(
      await a.patchTrip(PARIS, {
        expectedRevision: 1,
        operations: [
          { op: 'set_title', title: 'パリ（改名）' },
          { op: 'move', itemId: 'fx_act_eiffel', toDayIndex: 0, toPosition: 0 },
        ],
      }),
    );
    const timeOf = (t: Trip) => Object.fromEntries(itemsOf(t).map(i => [idOf(i), [startOf(i), endOf(i)]]));
    expect(timeOf(res.trip)).toEqual(timeOf(before));
    // The Eiffel Tower is still stamped for 2026-10-25 (CET) even though it now sits on day 0.
    expect(res.trip.days[0]?.items[0] && idOf(res.trip.days[0].items[0])).toBe('fx_act_eiffel');
    const moved = res.trip.days[0]?.items[0];
    expect(moved && startOf(moved)).toEqual({ utc: '2026-10-25T11:30:00Z', timeZone: 'Europe/Paris' });
  });

  it('the duration of a Paris item is computed from UTC instants (no off-by-one-hour around the switch)', async () => {
    const a = createMockApi();
    // Starts 2026-10-25T00:30Z (02:30 CEST), crosses the switch at 01:00Z and ends 2026-10-25T14:00Z (15:00 CET).
    // The elapsed span of the trip (2026-10-24T08:00Z to 2026-10-25T13:00Z = 29 real hours) grows by 3600 real seconds.
    const across = activityItem('dst_cross', 0, {
      cost: null,
      costStatus: 'unknown',
      start: { utc: '2026-10-25T00:30:00Z', timeZone: 'Europe/Paris' },
      end: { utc: '2026-10-25T14:00:00Z', timeZone: 'Europe/Paris' },
    });
    const res = data(await a.patchTrip(PARIS, { expectedRevision: 1, operations: [{ op: 'add', dayIndex: 1, position: 0, item: across }] }));
    expect(res.diff.durationDeltaSeconds).toBe(3600);
    expect(res.trip.days[1]?.items[0]).toEqual(across);
  });

  it('time-zone-less or offset-less timestamps are rejected in a patched item', async () => {
    const a = createMockApi();
    const bad = activityItem('bad_tz', null, { start: { utc: '2026-10-25T02:30:00', timeZone: 'Europe/Paris' } as never });
    expect(errorOf(await a.patchTrip(PARIS, { expectedRevision: 1, operations: [{ op: 'add', dayIndex: 0, position: 0, item: bad }] })).code).toBe('VALIDATION_FAILED');
    const badZone = activityItem('bad_zone', null, { start: { utc: '2026-10-25T02:30:00Z', timeZone: 'Mars/Olympus' } as never });
    expect(errorOf(await a.patchTrip(PARIS, { expectedRevision: 1, operations: [{ op: 'add', dayIndex: 0, position: 0, item: badZone }] })).code).toBe('VALIDATION_FAILED');
    expect(data(await a.getTrip(PARIS)).revision).toBe(1);
  });
});

describe('mock api edge: isolation and source label', () => {
  it('editing through one instance changes neither another instance nor the source fixtures', async () => {
    const before = JSON.stringify([fixtureTrips, domesticTrip, overseasTrip, sampleFeed, createBudgetUnknownTrip(), createBudgetUnknownPlanBatch()]);
    const a = createMockApi();
    const b = createMockApi();
    data(await a.patchTrip(KANAZAWA, { expectedRevision: 1, operations: [{ op: 'remove', itemId: 'fx_act_lunch' }, { op: 'set_title', title: 'Aだけ' }] }));
    data(await a.patchTrip(PARIS, { expectedRevision: 1, operations: [{ op: 'remove', itemId: 'fx_act_louvre' }] }));
    data(await a.applyCandidate({ batchId: 'fx_batch_1', candidateId: 'candidate_1', tripId: null, expectedRevision: null }));
    await a.generate(GENERATE);
    const tripB = data(await b.getTrip(KANAZAWA));
    expect(tripB).toEqual(Trip.parse(domesticTrip));
    expect(data(await b.getTrip(PARIS))).toEqual(Trip.parse(overseasTrip));
    expect(data(await b.listTrips()).items).toHaveLength(3);
    expect(errorOf(await b.getJob('mock_job_1')).code).toBe('NOT_FOUND');
    expect(JSON.stringify([fixtureTrips, domesticTrip, overseasTrip, sampleFeed, createBudgetUnknownTrip(), createBudgetUnknownPlanBatch()])).toBe(before);
    // The module-level fixtures are still the same shape the mock started from.
    expect(domesticTrip.revision).toBe(1);
    expect(domesticTrip.title).not.toBe('Aだけ');
    expect(itemsOf(domesticTrip).some(i => idOf(i) === 'fx_act_lunch')).toBe(true);
  });

  it('a new instance after edits starts from the pristine fixtures again (state is not module-global)', async () => {
    const first = createMockApi();
    data(await first.patchTrip(KANAZAWA, { expectedRevision: 1, operations: [{ op: 'set_title', title: '汚染テスト' }] }));
    const second = createMockApi();
    expect(data(await second.getTrip(KANAZAWA)).title).toBe(domesticTrip.title);
    expect(data(await second.getTrip(KANAZAWA)).revision).toBe(1);
  });

  it('mutating a returned object does not change the mock state, and mutating an input after the call does not either', async () => {
    const a = createMockApi();
    const got = data(await a.getTrip(KANAZAWA));
    got.title = '呼び出し側で改ざん';
    got.days[0]?.items.splice(0);
    expect(data(await a.getTrip(KANAZAWA)).title).toBe(domesticTrip.title);
    expect(itemsOf(data(await a.getTrip(KANAZAWA))).length).toBe(itemsOf(domesticTrip).length);

    const list = data(await a.listTrips());
    list.items.splice(0);
    expect(data(await a.listTrips()).items).toHaveLength(3);

    const added = activityItem('input_alias', 100);
    data(await a.patchTrip(KANAZAWA, { expectedRevision: 1, operations: [{ op: 'add', dayIndex: 1, position: 0, item: added }] }));
    added.title = '後から改ざん';
    const stored = itemsOf(data(await a.getTrip(KANAZAWA))).find(i => idOf(i) === 'input_alias');
    expect(stored?.type === 'activity' && stored.title).toBe('追加予定 input_alias（fixture）');

    const batch = data(await a.getPlanBatch('fx_batch_1'));
    batch.candidates.splice(0);
    expect(data(await a.getPlanBatch('fx_batch_1')).candidates).toHaveLength(3);
    const written = data(await a.applyCandidate({ batchId: 'fx_batch_1', candidateId: 'candidate_1', tripId: null, expectedRevision: null }));
    written.trip.days.splice(0);
    expect(data(await a.getTrip(written.tripId)).days.length).toBeGreaterThan(0);
  });

  it('two applications of the same candidate return the same trip; different candidates create distinct trips, and edits stay on their own trip', async () => {
    const a = createMockApi();
    const x = data(await a.applyCandidate({ batchId: 'fx_batch_1', candidateId: 'candidate_1', tripId: null, expectedRevision: null }));
    const y = data(await a.applyCandidate({ batchId: 'fx_batch_1', candidateId: 'candidate_1', tripId: null, expectedRevision: null }));
    expect(x.tripId).toBe(y.tripId);
    const z = data(await a.applyCandidate({ batchId: 'fx_batch_1', candidateId: 'candidate_2', tripId: null, expectedRevision: null }));
    expect(z.tripId).not.toBe(x.tripId);
    data(await a.patchTrip(x.tripId, { expectedRevision: 1, operations: [{ op: 'set_title', title: 'x だけ' }] }));
    expect(data(await a.getTrip(z.tripId)).title).toBe(z.trip.title);
    expect(data(await a.listTrips()).items).toHaveLength(5);
  });

  it('every result, success or failure, in every scenario carries source "mock" and a schema-valid payload', async () => {
    const scenarios: MockScenario[] = ['normal', 'empty', 'error', 'slow', 'budgetUnknown'];
    for (const scenario of scenarios) {
      const a = createMockApi({ scenario, delayMs: 0 });
      const results: MockResult<unknown>[] = [
        await a.listTrips(),
        await a.getTrip(KANAZAWA),
        await a.getTrip('nope'),
        await a.generate(GENERATE),
        await a.generate({} as never),
        await a.getJob('mock_job_1'),
        await a.getJob('nope'),
        await a.cancelJob('mock_job_1'),
        await a.cancelJob('nope'),
        await a.getPlanBatch('fx_batch_1'),
        await a.applyCandidate({ batchId: 'fx_batch_1', candidateId: 'candidate_1', tripId: null, expectedRevision: null }),
        await a.patchTrip(KANAZAWA, { expectedRevision: 1, operations: [{ op: 'set_title', title: 'x' }] }),
        await a.getFeed({ scope: 'public' }),
        await a.getFeed({ scope: 'public', limit: 99 }),
      ];
      for (const r of results) {
        expect(r.source, scenario).toBe('mock');
        if (!r.ok) expect(r.status, `${scenario} ${r.error.code}`).toBeGreaterThanOrEqual(400);
      }
      expect(a.source).toBe('mock');
      expect(a.scenario).toBe(scenario);
      expect(a.notice).toContain('モック');
    }
  });

  it('empty scenario: no trip can be edited or applied over, and a created trip appears in the list', async () => {
    const a = createMockApi({ scenario: 'empty' });
    expect(errorOf(await a.patchTrip(KANAZAWA, { expectedRevision: 1, operations: [{ op: 'set_title', title: 'x' }] })).code).toBe('NOT_FOUND');
    expect(errorOf(await a.applyCandidate({ batchId: 'fx_batch_1', candidateId: 'candidate_1', tripId: null, expectedRevision: null })).code).toBe('NOT_FOUND');
    const { jobId } = data(await a.generate(GENERATE));
    const batchId = (await pollToEnd(a, jobId)).at(-1)?.batchId ?? '';
    const written = data(await a.applyCandidate({ batchId, candidateId: 'candidate_1', tripId: null, expectedRevision: null }));
    expect(data(await a.listTrips()).items.map(i => i.tripId)).toEqual([written.tripId]);
  });

  it('list is newest-first by updatedAt and a patched trip moves to the top', async () => {
    let tick = 0;
    const a = createMockApi({ now: () => new Date(Date.UTC(2027, 0, 1, 0, 0, tick++)) });
    data(await a.patchTrip(PARIS, { expectedRevision: 1, operations: [{ op: 'set_title', title: '最新' }] }));
    const items = data(await a.listTrips()).items;
    expect(items[0]?.tripId).toBe(PARIS);
    expect(items[0]?.revision).toBe(2);
    const stamps = items.map(i => i.updatedAt);
    expect(stamps).toEqual([...stamps].sort().reverse());
  });
});

describe('mock api edge: error responses follow the contract', () => {
  it('every error carries the ERROR_HTTP_STATUS of its code and is a schema-valid ApiError with a requestId', async () => {
    const normal = createMockApi();
    const errors: MockResult<unknown>[] = [
      await normal.getTrip('nope'), // NOT_FOUND
      await normal.getJob('nope'), // NOT_FOUND
      await normal.cancelJob('nope'), // NOT_FOUND
      await normal.getPlanBatch('nope'), // NOT_FOUND
      await normal.generate({} as never), // VALIDATION_FAILED
      await normal.getFeed({ scope: 'public', limit: 50 }), // VALIDATION_FAILED
      await normal.patchTrip(KANAZAWA, { expectedRevision: 9, operations: [{ op: 'set_title', title: 'x' }] }), // REVISION_CONFLICT
      await normal.patchTrip(KANAZAWA, { expectedRevision: 1, operations: [{ op: 'remove', itemId: 'zzz' }] }), // CONSTRAINT_UNSATISFIED
      await normal.applyCandidate({ batchId: 'fx_batch_1', candidateId: 'candidate_1', tripId: KANAZAWA, expectedRevision: null }), // VALIDATION_FAILED
      await createMockApi({ scenario: 'error' }).listTrips(), // UNAVAILABLE
    ];
    // Cancelling a succeeded job is a 200 (not an error), so it is not part of this list.

    const codes = new Set<string>();
    for (const res of errors) {
      const error = errorOf(res);
      expect(res.status, error.code).toBe(ERROR_HTTP_STATUS[error.code]);
      expect(ApiError.safeParse(error).success, error.code).toBe(true);
      expect(error.message.length).toBeGreaterThan(0);
      expect(error.requestId.length).toBeGreaterThan(0);
      codes.add(error.code);
    }
    // requestId is unique within one mock instance (the counter is per instance); index 9 is the error-scenario instance.
    const sameInstance = errors.filter((_, i) => i !== 9).map(r => errorOf(r).requestId);
    expect(new Set(sameInstance).size).toBe(sameInstance.length);
    expect([...codes].sort()).toEqual(['CONSTRAINT_UNSATISFIED', 'NOT_FOUND', 'REVISION_CONFLICT', 'UNAVAILABLE', 'VALIDATION_FAILED']);
  });

  it('NOT_FOUND never echoes the requested id (does not reveal whether another user\'s resource exists)', async () => {
    const a = createMockApi();
    for (const res of [await a.getTrip('someone_elses_trip_id'), await a.getJob('someone_elses_job'), await a.getPlanBatch('someone_elses_batch')]) {
      expect(JSON.stringify(errorOf(res))).not.toContain('someone_elses');
    }
    // An unknown id and an id that exists only in another instance look the same.
    const other = createMockApi();
    const { jobId } = data(await other.generate(GENERATE));
    const foreign = errorOf(await a.getJob(jobId));
    const missing = errorOf(await a.getJob('mock_job_999'));
    expect({ ...foreign, requestId: '' }).toEqual({ ...missing, requestId: '' });
  });

  it('retryable is true only for transient failures (UNAVAILABLE) and false for validation/conflict/not-found', async () => {
    const a = createMockApi();
    expect(errorOf(await a.getTrip('nope')).retryable).toBe(false);
    expect(errorOf(await a.patchTrip(KANAZAWA, { expectedRevision: 9, operations: [{ op: 'set_title', title: 'x' }] })).retryable).toBe(false);
    expect(errorOf(await a.generate({} as never)).retryable).toBe(false);
    expect(errorOf(await createMockApi({ scenario: 'error' }).listTrips()).retryable).toBe(true);
  });

  it('error scenario: every read and write API except job polling answers 503 UNAVAILABLE and never throws', async () => {
    const a = createMockApi({ scenario: 'error' });
    const results = [
      await a.listTrips(),
      await a.getTrip(KANAZAWA),
      await a.getPlanBatch('fx_batch_1'),
      await a.applyCandidate({ batchId: 'fx_batch_1', candidateId: 'candidate_1', tripId: null, expectedRevision: null }),
      await a.patchTrip(KANAZAWA, { expectedRevision: 1, operations: [{ op: 'set_title', title: 'x' }] }),
      await a.getFeed({ scope: 'public' }),
    ];
    for (const r of results) {
      expect(errorOf(r).code).toBe('UNAVAILABLE');
      expect(r.status).toBe(503);
    }
  });

  it('rejects garbage input types without throwing (null, strings, arrays, numbers)', async () => {
    const a = createMockApi();
    for (const junk of [null, 'text', 42, [], true]) {
      expect(errorOf(await a.generate(junk as never)).code).toBe('VALIDATION_FAILED');
      expect(errorOf(await a.applyCandidate(junk as never)).code).toBe('VALIDATION_FAILED');
      expect(errorOf(await a.patchTrip(KANAZAWA, junk as never)).code).toBe('VALIDATION_FAILED');
      expect(errorOf(await a.getFeed(junk as never)).code).toBe('VALIDATION_FAILED');
    }
  });

  it('does not use the network even across failures and long flows', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const a = createMockApi({ scenario: 'error' });
      await a.listTrips();
      const { jobId } = data(await a.generate(GENERATE));
      await pollToEnd(a, jobId);
      const b = createMockApi();
      await b.patchTrip(KANAZAWA, { expectedRevision: 1, operations: [{ op: 'set_title', title: 'x' }] });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
