import { describe, expect, it, vi } from 'vitest';
import { Feed, JobAccepted, JobStatus, PlanBatch, Trip, TripList, TripPatchResult, TripWriteResult } from '@tkb/contracts';
import type { Activity } from '@tkb/contracts';
import { domesticTrip, fixtureTrips, sampleFeed } from '@tkb/fixtures';
import { MOCK_NOTICE, createMockApi, toProbe } from './index.ts';
import type { MockApi, MockResult } from './index.ts';

const GENERATE = {
  constraints: { area: '金沢', startDate: '2026-11-01', endDate: '2026-11-02', timeZone: 'Asia/Tokyo', transportMode: 'transit' as const },
};

function data<T>(result: MockResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.data;
}

function errorCode<T>(result: MockResult<T>): string {
  if (result.ok) throw new Error('expected an error');
  return result.error.code;
}

/** Polls until the job is terminal and returns every state seen. */
async function pollToEnd(api: MockApi, jobId: string): Promise<JobStatus[]> {
  const seen: JobStatus[] = [];
  for (let i = 0; i < 50; i += 1) {
    const status = data(await api.getJob(jobId));
    seen.push(status);
    if (['succeeded', 'failed', 'cancelled'].includes(status.state)) return seen;
  }
  throw new Error('job never finished');
}

const activityItem = (id: string, cost: number | null): Activity => ({
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
});

describe('mock api: common', () => {
  it('marks every result as a mock and exposes the notice', async () => {
    const api = createMockApi();
    expect(api.notice).toBe(MOCK_NOTICE);
    const ok = await api.listTrips();
    expect(ok.source).toBe('mock');
    const ng = await api.getTrip('nope');
    expect(ng.source).toBe('mock');
    expect(toProbe(ok).ok).toBe(true);
    expect(toProbe(ng)).toEqual({ ok: false, error: expect.any(String) });
  });

  it('does not touch the network or browser storage', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const api = createMockApi();
      await api.listTrips();
      await api.generate(GENERATE);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect('localStorage' in globalThis).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not mutate the fixture and instances do not share state', async () => {
    const before = JSON.stringify([fixtureTrips, sampleFeed]);
    const a = createMockApi();
    const b = createMockApi();
    await a.patchTrip(domesticTrip.tripId, { expectedRevision: 1, operations: [{ op: 'set_title', title: '変更後' }] });
    expect(data(await a.getTrip(domesticTrip.tripId)).title).toBe('変更後');
    expect(data(await b.getTrip(domesticTrip.tripId)).title).toBe(domesticTrip.title);
    expect(JSON.stringify([fixtureTrips, sampleFeed])).toBe(before);
  });
});

describe('mock api: scenarios', () => {
  it('normal: lists trips that conform to the schema', async () => {
    const list = data(await createMockApi().listTrips());
    expect(TripList.safeParse(list).success).toBe(true);
    expect(list.items.length).toBeGreaterThanOrEqual(2);
    expect(list.items.map(i => i.tripId)).toContain('fx_trip_kanazawa');
    expect(Trip.safeParse(data(await createMockApi().getTrip('fx_trip_paris'))).success).toBe(true);
  });

  it('empty: no trips, no feed, no stored batches; generation still works', async () => {
    const api = createMockApi({ scenario: 'empty' });
    expect(data(await api.listTrips()).items).toEqual([]);
    expect(data(await api.getFeed({ scope: 'public' })).items).toEqual([]);
    expect(errorCode(await api.getTrip('fx_trip_kanazawa'))).toBe('NOT_FOUND');
    expect(errorCode(await api.getPlanBatch('fx_batch_1'))).toBe('NOT_FOUND');
    const accepted = data(await api.generate(GENERATE));
    expect((await pollToEnd(api, accepted.jobId)).at(-1)?.state).toBe('succeeded');
  });

  it('error: reads and writes fail with UNAVAILABLE, the job fails with INVALID_OUTPUT', async () => {
    const api = createMockApi({ scenario: 'error' });
    const res = await api.listTrips();
    expect(errorCode(res)).toBe('UNAVAILABLE');
    expect(!res.ok && res.status).toBe(503);
    expect(!res.ok && res.error.retryable).toBe(true);
    expect(errorCode(await api.getTrip('fx_trip_kanazawa'))).toBe('UNAVAILABLE');
    expect(errorCode(await api.getFeed({ scope: 'public' }))).toBe('UNAVAILABLE');
    expect(errorCode(await api.getPlanBatch('fx_batch_1'))).toBe('UNAVAILABLE');

    const accepted = data(await api.generate(GENERATE));
    const seen = await pollToEnd(api, accepted.jobId);
    const last = seen.at(-1);
    expect(last?.state).toBe('failed');
    expect(last?.error?.code).toBe('INVALID_OUTPUT');
    expect(last?.batchId).toBeNull();
    expect(errorCode(await api.getPlanBatch('mock_batch_2'))).toBe('UNAVAILABLE');
  });

  it('slow: injects the delay through sleep and holds each job step longer', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const api = createMockApi({ scenario: 'slow', sleep });
    await api.listTrips();
    expect(sleep).toHaveBeenCalledWith(800);

    const fast = createMockApi({ scenario: 'normal' });
    const slow = createMockApi({ scenario: 'slow', delayMs: 0 });
    const fastJob = data(await fast.generate(GENERATE));
    const slowJob = data(await slow.generate(GENERATE));
    const fastSeen = await pollToEnd(fast, fastJob.jobId);
    const slowSeen = await pollToEnd(slow, slowJob.jobId);
    expect(slowSeen.length).toBe(fastSeen.length * 3 - 2);
  });

  it('slow: works with fake timers', async () => {
    vi.useFakeTimers();
    try {
      const api = createMockApi({ scenario: 'slow', delayMs: 500 });
      const pending = api.listTrips();
      await vi.advanceTimersByTimeAsync(500);
      expect((await pending).ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('budgetUnknown: no budget and no cost is turned into 0', async () => {
    const api = createMockApi({ scenario: 'budgetUnknown' });
    const trips = data(await api.listTrips());
    const detail = data(await api.getTrip(trips.items[0]?.tripId ?? ''));
    expect(detail.constraints.budget).toBeNull();
    const batch = data(await api.getPlanBatch('fx_batch_budget_unknown'));
    for (const c of batch.candidates) {
      expect(c.hasUnknownCost).toBe(true);
      expect(c.totalKnownCost).toEqual([]);
    }
    const accepted = data(await api.generate(GENERATE));
    const done = (await pollToEnd(api, accepted.jobId)).at(-1);
    const generated = data(await api.getPlanBatch(done?.batchId ?? ''));
    expect(generated.candidates.every(c => c.totalKnownCost.length === 0 && c.hasUnknownCost)).toBe(true);
    const written = data(await api.applyCandidate({ batchId: generated.batchId, candidateId: 'candidate_1', tripId: null, expectedRevision: null }));
    expect(written.trip.constraints.budget).toBeNull();
  });
});

describe('mock api: K01/K02/K21 jobs', () => {
  it('generate returns a valid JobAccepted (202) and rejects bad requests', async () => {
    const api = createMockApi();
    const res = await api.generate(GENERATE);
    expect(res.status).toBe(202);
    expect(JobAccepted.safeParse(data(res)).success).toBe(true);

    expect(errorCode(await api.generate({ constraints: { ...GENERATE.constraints, endDate: '2026-10-01' } }))).toBe('VALIDATION_FAILED');
    // K01 is strict: ownerId must be rejected.
    expect(errorCode(await api.generate({ ...GENERATE, ownerId: 'x' } as never))).toBe('VALIDATION_FAILED');
    expect(errorCode(await api.generate({ ...GENERATE, mode: 'replan' }))).toBe('VALIDATION_FAILED');
  });

  it('getJob goes queued -> running -> succeeded and then stays', async () => {
    const api = createMockApi();
    const { jobId } = data(await api.generate(GENERATE));
    const seen = await pollToEnd(api, jobId);
    const states = seen.map(s => s.state);
    expect(states[0]).toBe('queued');
    expect(states).toContain('running');
    expect(states.at(-1)).toBe('succeeded');
    expect(states.filter(s => s === 'running').length).toBeGreaterThanOrEqual(1);
    for (const s of seen) expect(JobStatus.safeParse(s).success).toBe(true);
    const last = seen.at(-1);
    expect(last?.stage).toBe('saved');
    expect(last?.batchId).toBeTruthy();
    expect(data(await api.getJob(jobId)).state).toBe('succeeded');
  });

  it('the batch is readable only after the job succeeded', async () => {
    const api = createMockApi();
    const { jobId } = data(await api.generate(GENERATE));
    expect(errorCode(await api.getPlanBatch('mock_batch_2'))).toBe('NOT_FOUND');
    const batchId = (await pollToEnd(api, jobId)).at(-1)?.batchId ?? '';
    const batch = data(await api.getPlanBatch(batchId));
    expect(PlanBatch.safeParse(batch).success).toBe(true);
    expect(batch.candidates.length).toBeGreaterThanOrEqual(2);
  });

  it('unknown job id is NOT_FOUND', async () => {
    const api = createMockApi();
    expect(errorCode(await api.getJob('nope'))).toBe('NOT_FOUND');
    expect(errorCode(await api.cancelJob('nope'))).toBe('NOT_FOUND');
  });

  it('cancel stops a running job; a saved job cannot be cancelled', async () => {
    const api = createMockApi();
    const { jobId } = data(await api.generate(GENERATE));
    await api.getJob(jobId);
    await api.getJob(jobId);
    const cancel = await api.cancelJob(jobId);
    expect(cancel.status).toBe(202);
    expect(data(cancel).state).toBe('cancelled');
    expect(data(await api.getJob(jobId)).state).toBe('cancelled');

    const second = data(await api.generate(GENERATE));
    const done = (await pollToEnd(api, second.jobId)).at(-1);
    const late = await api.cancelJob(second.jobId);
    expect(errorCode(late)).toBe('ALREADY_COMMITTED');
    expect(!late.ok && late.error.details).toEqual({ batchId: done?.batchId });
  });

  it('car requests get car legs without fares', async () => {
    const api = createMockApi();
    const { jobId } = data(await api.generate({ constraints: { ...GENERATE.constraints, transportMode: 'car' } }));
    const batchId = (await pollToEnd(api, jobId)).at(-1)?.batchId ?? '';
    const legs = data(await api.getPlanBatch(batchId)).candidates.flatMap(c => c.days.flatMap(d => d.items)).filter(i => i.type === 'leg');
    expect(legs.some(l => l.mode === 'transit')).toBe(false);
    expect(legs.some(l => l.mode === 'car')).toBe(true);
  });

  it('replan checks the base trip and revision', async () => {
    const api = createMockApi();
    const base = { ...GENERATE, mode: 'replan' as const, baseTripId: 'fx_trip_kanazawa' };
    expect(errorCode(await api.generate({ ...base, expectedRevision: 9 }))).toBe('REVISION_CONFLICT');
    expect(errorCode(await api.generate({ ...base, baseTripId: 'nope', expectedRevision: 1 }))).toBe('NOT_FOUND');
    const { jobId } = data(await api.generate({ ...base, expectedRevision: 1 }));
    const batchId = (await pollToEnd(api, jobId)).at(-1)?.batchId ?? '';
    const batch = data(await api.getPlanBatch(batchId));
    expect(batch.baseTripId).toBe('fx_trip_kanazawa');
    expect(batch.baseRevision).toBe(1);
  });
});

describe('mock api: K08 apply-candidate', () => {
  it('creates a new trip (201) from the seeded batch and lists it', async () => {
    const api = createMockApi();
    const res = await api.applyCandidate({ batchId: 'fx_batch_1', candidateId: 'candidate_2', tripId: null, expectedRevision: null });
    expect(res.status).toBe(201);
    const written = data(res);
    expect(TripWriteResult.safeParse(written).success).toBe(true);
    expect(written.revision).toBe(1);
    expect(written.trip.ownerId).toBe('fx_user_a');
    expect(data(await api.listTrips()).items.map(i => i.tripId)).toContain(written.tripId);
  });

  it('updates an existing trip (200) and bumps the revision; stale revisions conflict', async () => {
    const api = createMockApi();
    const res = await api.applyCandidate({ batchId: 'fx_batch_1', candidateId: 'candidate_3', tripId: 'fx_trip_kanazawa', expectedRevision: 1 });
    expect(res.status).toBe(200);
    expect(data(res).revision).toBe(2);
    const stale = await api.applyCandidate({ batchId: 'fx_batch_1', candidateId: 'candidate_3', tripId: 'fx_trip_kanazawa', expectedRevision: 1 });
    expect(errorCode(stale)).toBe('REVISION_CONFLICT');
    expect(!stale.ok && stale.error.details).toEqual({ expectedRevision: 1, currentRevision: 2 });
  });

  it('rejects unknown batch/candidate/trip and missing expectedRevision', async () => {
    const api = createMockApi();
    expect(errorCode(await api.applyCandidate({ batchId: 'nope', candidateId: 'candidate_1', tripId: null, expectedRevision: null }))).toBe('NOT_FOUND');
    expect(errorCode(await api.applyCandidate({ batchId: 'fx_batch_1', candidateId: 'nope', tripId: null, expectedRevision: null }))).toBe('NOT_FOUND');
    expect(errorCode(await api.applyCandidate({ batchId: 'fx_batch_1', candidateId: 'candidate_1', tripId: 'nope', expectedRevision: 1 }))).toBe('NOT_FOUND');
    expect(errorCode(await api.applyCandidate({ batchId: 'fx_batch_1', candidateId: 'candidate_1', tripId: 'fx_trip_kanazawa', expectedRevision: null }))).toBe('VALIDATION_FAILED');
    expect(errorCode(await api.applyCandidate({ batchId: 'fx_batch_1' } as never))).toBe('VALIDATION_FAILED');
  });
});

describe('mock api: K10 patchTrip', () => {
  const id = 'fx_trip_kanazawa';

  it('set_title bumps the revision, keeps validationState and has an empty diff', async () => {
    const api = createMockApi();
    const res = data(await api.patchTrip(id, { expectedRevision: 1, operations: [{ op: 'set_title', title: '新しい名前' }] }));
    expect(TripPatchResult.safeParse(res).success).toBe(true);
    expect(res.revision).toBe(2);
    expect(res.trip.title).toBe('新しい名前');
    expect(res.trip.validationState).toBe(domesticTrip.validationState);
    expect(res.diff).toEqual({ durationDeltaSeconds: 0, knownCostDelta: [], unknownCostItems: [] });
  });

  it('remove: known cost goes down, unknown cost is not counted as 0', async () => {
    const api = createMockApi();
    const lunch = data(await api.patchTrip(id, { expectedRevision: 1, operations: [{ op: 'remove', itemId: 'fx_act_lunch' }] }));
    expect(lunch.diff.knownCostDelta).toEqual([{ currency: 'JPY', amountMinor: -4000 }]);
    expect(lunch.diff.durationDeltaSeconds).toBe(-3600);
    expect(lunch.trip.validationState).toBe('needs_revalidation');
    expect(lunch.trip.days.flatMap(d => d.items).some(i => i.type === 'activity' && i.activityId === 'fx_act_lunch')).toBe(false);

    // The museum has no known cost: removing it must not produce a cost delta.
    const museum = data(await api.patchTrip(id, { expectedRevision: 2, operations: [{ op: 'remove', itemId: 'fx_act_museum' }] }));
    expect(museum.diff.knownCostDelta).toEqual([]);
    expect(museum.diff.unknownCostItems).toEqual([]);
  });

  it('remove of a leg with unknown duration makes the duration delta unknown (null)', async () => {
    const api = createMockApi();
    const res = data(await api.patchTrip(id, { expectedRevision: 1, operations: [{ op: 'remove', itemId: 'fx_leg_3' }] }));
    expect(res.diff.durationDeltaSeconds).toBeNull();
  });

  it('move reorders within and across days without changing cost or duration', async () => {
    const api = createMockApi();
    const res = data(
      await api.patchTrip(id, {
        expectedRevision: 1,
        operations: [
          { op: 'move', itemId: 'fx_act_omicho', toDayIndex: 0, toPosition: 0 },
          { op: 'move', itemId: 'fx_act_higashi', toDayIndex: 0, toPosition: 1 },
        ],
      }),
    );
    const day0 = res.trip.days[0]?.items.map(i => (i.type === 'activity' ? i.activityId : i.legId));
    expect(day0?.slice(0, 2)).toEqual(['fx_act_omicho', 'fx_act_higashi']);
    expect(res.trip.days[1]?.items).toEqual([]);
    expect(res.diff).toEqual({ durationDeltaSeconds: 0, knownCostDelta: [], unknownCostItems: [] });
    expect(res.trip.validationState).toBe('needs_revalidation');
  });

  it('add reports unknown-cost items instead of 0, update replaces the item', async () => {
    const api = createMockApi();
    const added = data(
      await api.patchTrip(id, {
        expectedRevision: 1,
        operations: [
          { op: 'add', dayIndex: 1, position: 1, item: activityItem('mock_add_a', null) },
          { op: 'add', dayIndex: 1, position: 2, item: activityItem('mock_add_b', 1500) },
        ],
      }),
    );
    expect(added.diff.unknownCostItems).toEqual(['mock_add_a']);
    expect(added.diff.knownCostDelta).toEqual([{ currency: 'JPY', amountMinor: 1500 }]);
    expect(added.diff.durationDeltaSeconds).toBe(7200);

    const updated = data(
      await api.patchTrip(id, {
        expectedRevision: 2,
        operations: [{ op: 'update', itemId: 'mock_add_a', item: { ...activityItem('mock_add_a', 800), title: '更新後（fixture）' } }],
      }),
    );
    expect(updated.diff.knownCostDelta).toEqual([{ currency: 'JPY', amountMinor: 800 }]);
    expect(updated.diff.unknownCostItems).toEqual([]);
    expect(updated.trip.days[1]?.items.some(i => i.type === 'activity' && i.title === '更新後（fixture）')).toBe(true);
  });

  it('stale expectedRevision is REVISION_CONFLICT (409) with the current revision', async () => {
    const api = createMockApi();
    data(await api.patchTrip(id, { expectedRevision: 1, operations: [{ op: 'set_title', title: 'A' }] }));
    const res = await api.patchTrip(id, { expectedRevision: 1, operations: [{ op: 'set_title', title: 'B' }] });
    expect(errorCode(res)).toBe('REVISION_CONFLICT');
    expect(!res.ok && res.status).toBe(409);
    expect(!res.ok && res.error.details).toEqual({ expectedRevision: 1, currentRevision: 2 });
    expect(data(await api.getTrip(id)).title).toBe('A');
  });

  it('is all-or-nothing: a failing operation leaves the trip untouched', async () => {
    const api = createMockApi();
    const res = await api.patchTrip(id, {
      expectedRevision: 1,
      operations: [
        { op: 'set_title', title: '途中まで' },
        { op: 'remove', itemId: 'does_not_exist' },
      ],
    });
    expect(errorCode(res)).toBe('CONSTRAINT_UNSATISFIED');
    const trip = data(await api.getTrip(id));
    expect(trip.title).toBe(domesticTrip.title);
    expect(trip.revision).toBe(1);
  });

  it('rejects out-of-range positions, duplicate ids, id mismatch, unknown trip and bad bodies', async () => {
    const api = createMockApi();
    const patch = (operations: never[]) => api.patchTrip(id, { expectedRevision: 1, operations });
    expect(errorCode(await patch([{ op: 'add', dayIndex: 9, position: 0, item: activityItem('x1', null) }] as never))).toBe('CONSTRAINT_UNSATISFIED');
    expect(errorCode(await patch([{ op: 'add', dayIndex: 1, position: 9, item: activityItem('x2', null) }] as never))).toBe('CONSTRAINT_UNSATISFIED');
    expect(errorCode(await patch([{ op: 'add', dayIndex: 1, position: 0, item: activityItem('fx_act_higashi', null) }] as never))).toBe('CONSTRAINT_UNSATISFIED');
    expect(errorCode(await patch([{ op: 'move', itemId: 'fx_act_higashi', toDayIndex: 5, toPosition: 0 }] as never))).toBe('CONSTRAINT_UNSATISFIED');
    expect(errorCode(await patch([{ op: 'move', itemId: 'fx_act_higashi', toDayIndex: 1, toPosition: 9 }] as never))).toBe('CONSTRAINT_UNSATISFIED');
    expect(errorCode(await patch([{ op: 'update', itemId: 'fx_act_higashi', item: activityItem('other', null) }] as never))).toBe('CONSTRAINT_UNSATISFIED');
    expect(errorCode(await api.patchTrip('nope', { expectedRevision: 1, operations: [{ op: 'set_title', title: 'x' }] }))).toBe('NOT_FOUND');
    expect(errorCode(await patch([] as never))).toBe('VALIDATION_FAILED');
    expect(errorCode(await patch([{ op: 'delete_everything' }] as never))).toBe('VALIDATION_FAILED');
    expect(data(await api.getTrip(id)).revision).toBe(1);
  });
});

describe('mock api: K14 feed', () => {
  it('returns a valid public feed and paginates with a cursor', async () => {
    const api = createMockApi();
    const first = data(await api.getFeed({ scope: 'public', limit: 2 }));
    expect(Feed.safeParse(first).success).toBe(true);
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe('2');
    const second = data(await api.getFeed({ scope: 'public', limit: 2, cursor: first.nextCursor ?? undefined }));
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map(p => p.postId)).size).toBe(3);
  });

  it('mine returns only the demo user, groups is empty, bad input is rejected', async () => {
    const api = createMockApi();
    const mine = data(await api.getFeed({ scope: 'mine' }));
    expect(mine.items.length).toBeGreaterThan(0);
    expect(mine.items.every(p => p.authorDisplayName === 'デモ利用者A')).toBe(true);
    expect(data(await api.getFeed({ scope: 'groups' })).items).toEqual([]);
    expect(errorCode(await api.getFeed({ scope: 'public', cursor: 'abc' }))).toBe('VALIDATION_FAILED');
    expect(errorCode(await api.getFeed({ scope: 'everyone' } as never))).toBe('VALIDATION_FAILED');
    expect(errorCode(await api.getFeed({ scope: 'public', limit: 99 }))).toBe('VALIDATION_FAILED');
  });
});
