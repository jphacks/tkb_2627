import { describe, expect, it, vi } from 'vitest';
import { Feed, JobAccepted, JobStatus, PlanBatch, Trip, TripList, TripPatchResult, TripWriteResult } from '@tkb/contracts';
import type { Activity } from '@tkb/contracts';
import { domesticTrip, fixtureTrips, sampleFeed } from '@tkb/fixtures';
import { MOCK_NOTICE, MOCK_REPLAN_BATCH_ID, createMockApi, toProbe } from './index.ts';
import type { MockApi, MockResult } from './index.ts';

// Items of the Kanazawa fixture whose cost is unknown. K10 diff lists them on every edit (union of before and after, as main does).
// Plan order of the dense fixture: every activity without a known cost (lunch, kenrokuen and the legs with a fare are known).
const KANAZAWA_UNKNOWN = [
  'fx_act_station', 'fx_act_omicho', 'fx_act_omicho_walk', 'fx_act_castle', 'fx_act_museum', 'fx_act_dinner', 'fx_act_stop_musashi', 'fx_act_hotel',
  'fx_act_higashi', 'fx_act_higashi_tea', 'fx_act_higashi_sweets', 'fx_act_kazue', 'fx_act_oyama',
  'fx_act_lunch2', 'fx_act_nishi', 'fx_act_myoryuji', 'fx_act_nagamachi', 'fx_act_station_end',
];
/** KANAZAWA_UNKNOWN with `id` inserted right before 'fx_act_higashi' (the first item of day 2). */
const unknownWithAddedBeforeHigashi = (id: string) => KANAZAWA_UNKNOWN.flatMap(x => (x === 'fx_act_higashi' ? [id, x] : [x]));

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

const activityItem = (
  id: string,
  cost: number | null,
  timeZone = 'Asia/Tokyo',
  startUtc = '2026-11-02T04:00:00Z',
  endUtc = '2026-11-02T05:00:00Z',
): Activity => ({
  type: 'activity',
  activityId: id,
  kind: 'custom',
  title: `追加予定 ${id}（fixture）`,
  placeId: null,
  areaName: null,
  start: { utc: startUtc, timeZone },
  end: { utc: endUtc, timeZone },
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
    expect(toProbe(ng)).toEqual({ ok: false, error: expect.any(String), source: 'mock' });
  });

  it('toProbe keeps source on both success and failure', async () => {
    const api = createMockApi();
    const good = toProbe(await api.listTrips());
    expect(good.source).toBe('mock');
    expect(good.ok && good.data.items.length).toBeGreaterThan(0);
    const bad = toProbe(await api.getTrip('nope'));
    expect(bad).toEqual({ ok: false, error: '見つかりませんでした。', source: 'mock' });
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

  it('cancel stops a running job; a saved job is reported as succeeded with its batch id (200)', async () => {
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
    expect(late.status).toBe(200);
    expect(data(late)).toEqual({ jobId: second.jobId, state: 'succeeded', batchId: done?.batchId });
    expect(data(late).batchId).toBeTruthy();
    expect(data(await api.getJob(second.jobId)).state).toBe('succeeded');
  });

  it('car requests get car legs without fares', async () => {
    const api = createMockApi();
    const { jobId } = data(await api.generate({ constraints: { ...GENERATE.constraints, transportMode: 'car' } }));
    const batchId = (await pollToEnd(api, jobId)).at(-1)?.batchId ?? '';
    const legs = data(await api.getPlanBatch(batchId)).candidates.flatMap(c => c.days.flatMap(d => d.items)).filter(i => i.type === 'leg');
    expect(legs.some(l => l.mode === 'transit')).toBe(false);
    expect(legs.some(l => l.mode === 'car')).toBe(true);
  });

  it('car legs do not borrow public-transit times, durations or fares: they are unknown (null)', async () => {
    const api = createMockApi();
    const { jobId } = data(await api.generate({ constraints: { ...GENERATE.constraints, transportMode: 'car' } }));
    const batchId = (await pollToEnd(api, jobId)).at(-1)?.batchId ?? '';
    const cars = data(await api.getPlanBatch(batchId)).candidates.flatMap(c => c.days.flatMap(d => d.items)).filter(i => i.type === 'leg' && i.mode === 'car');
    expect(cars.length).toBeGreaterThan(0);
    for (const l of cars) {
      if (l.type !== 'leg') continue;
      expect([l.departure, l.arrival, l.durationSeconds, l.lineName, l.platform, l.transfers, l.fare, l.provenance]).toEqual([null, null, null, null, null, null, null, null]);
      expect(l.dataStatus).toBe('unknown');
    }
    // The seeded car trip is the same: its car legs carry no transit times either.
    const trip = data(await api.getTrip('fx_trip_kanazawa_car'));
    for (const l of trip.days.flatMap(d => d.items)) {
      if (l.type === 'leg' && l.mode === 'car') expect([l.departure, l.arrival, l.durationSeconds]).toEqual([null, null, null]);
    }
  });

  it('car legs never carry transit stop names from the source transit legs', async () => {
    const sourceLeg = domesticTrip.days.flatMap(d => d.items).find(i => i.type === 'leg' && i.mode === 'transit');
    if (!sourceLeg || sourceLeg.type !== 'leg') throw new Error('fixture has no transit leg');
    const original = sourceLeg.transit;
    const hadTransit = 'transit' in sourceLeg;
    sourceLeg.transit = { boardingStop: '金沢駅', alightingStop: '兼六園下', transferStops: ['香林坊'] };
    try {
      const api = createMockApi();
      const { jobId } = data(await api.generate({ constraints: { ...GENERATE.constraints, transportMode: 'car' } }));
      const batchId = (await pollToEnd(api, jobId)).at(-1)?.batchId ?? '';
      const cars = data(await api.getPlanBatch(batchId)).candidates.flatMap(c => c.days.flatMap(d => d.items)).filter(i => i.type === 'leg' && i.mode === 'car');
      expect(cars.length).toBeGreaterThan(0);
      for (const l of cars) {
        if (l.type !== 'leg') continue;
        expect(l.transit).toBeNull();
      }
    } finally {
      if (hadTransit) sourceLeg.transit = original;
      else delete sourceLeg.transit;
    }
  });

  it('Idempotency-Key: the same key and body returns the same job, a different body is 409, no key makes a new job', async () => {
    const api = createMockApi();
    const key = 'idem_key_0001';
    const first = await api.generate(GENERATE, { idempotencyKey: key });
    const again = await api.generate(structuredClone(GENERATE), { idempotencyKey: key });
    expect(first.status).toBe(202);
    expect(again.status).toBe(202);
    expect(data(again).jobId).toBe(data(first).jobId);

    const other = { constraints: { ...GENERATE.constraints, area: '東京' } };
    const conflict = await api.generate(other, { idempotencyKey: key });
    expect(errorCode(conflict)).toBe('IDEMPOTENCY_CONFLICT');
    expect(!conflict.ok && conflict.status).toBe(409);

    // A different key is a different job; without a key every call is a new job.
    const second = data(await api.generate(other, { idempotencyKey: 'idem_key_0002' }));
    expect(second.jobId).not.toBe(data(first).jobId);
    const none1 = data(await api.generate(GENERATE));
    const none2 = data(await api.generate(GENERATE));
    expect(none1.jobId).not.toBe(none2.jobId);

    // Keys are per mock instance.
    expect(data(await createMockApi().generate(other, { idempotencyKey: key })).jobId).toBeTruthy();
  });

  it('Idempotency-Key: a malformed key is 422, and the conflict is checked after the body is validated', async () => {
    const api = createMockApi();
    for (const bad of ['short', 'has space in key', 'a'.repeat(129), '日本語のキーです１２３４５']) {
      const res = await api.generate(GENERATE, { idempotencyKey: bad });
      expect(errorCode(res), bad).toBe('VALIDATION_FAILED');
      expect(!res.ok && res.status).toBe(422);
    }
    data(await api.generate(GENERATE, { idempotencyKey: 'a'.repeat(128) }));
    expect(errorCode(await api.generate({ constraints: {} } as never, { idempotencyKey: 'idem_key_0003' }))).toBe('VALIDATION_FAILED');
    // The invalid body did not reserve the key.
    data(await api.generate(GENERATE, { idempotencyKey: 'idem_key_0003' }));
    // Now the key is reserved: an invalid body with it is still 422 (body first), not 409.
    const invalidWithReserved = await api.generate({ constraints: {} } as never, { idempotencyKey: 'idem_key_0003' });
    expect(errorCode(invalidWithReserved)).toBe('VALIDATION_FAILED');
    expect(!invalidWithReserved.ok && invalidWithReserved.status).toBe(422);
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
    const res = await api.applyCandidate({ batchId: MOCK_REPLAN_BATCH_ID, candidateId: 'candidate_3', tripId: 'fx_trip_kanazawa', expectedRevision: 1 });
    expect(res.status).toBe(200);
    expect(data(res).revision).toBe(2);
    const stale = await api.applyCandidate({ batchId: MOCK_REPLAN_BATCH_ID, candidateId: 'candidate_3', tripId: 'fx_trip_kanazawa', expectedRevision: 1 });
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

  it('replan batch is seeded for the Kanazawa trip; fx_batch_1 is not (it only creates new trips)', async () => {
    const api = createMockApi();
    const replan = data(await api.getPlanBatch(MOCK_REPLAN_BATCH_ID));
    expect(replan.baseTripId).toBe('fx_trip_kanazawa');
    expect(replan.baseRevision).toBe(1);
    expect(data(await api.getPlanBatch('fx_batch_1')).baseTripId).toBeNull();
    const wrong = await api.applyCandidate({ batchId: 'fx_batch_1', candidateId: 'candidate_3', tripId: 'fx_trip_kanazawa', expectedRevision: 1 });
    expect(wrong.status).toBe(422);
    expect(errorCode(wrong)).toBe('VALIDATION_FAILED');
  });

  it('applying the same candidate again with tripId null returns the same trip (200)', async () => {
    const api = createMockApi();
    const req = { batchId: 'fx_batch_1', candidateId: 'candidate_2', tripId: null, expectedRevision: null };
    const first = await api.applyCandidate(req);
    const second = await api.applyCandidate(req);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(data(second).tripId).toBe(data(first).tripId);
  });
});

describe('mock api: K10 patchTrip', () => {
  const id = 'fx_trip_kanazawa';

  it('set_title bumps the revision, keeps validationState and changes no cost or duration', async () => {
    const api = createMockApi();
    const res = data(await api.patchTrip(id, { expectedRevision: 1, operations: [{ op: 'set_title', title: '新しい名前' }] }));
    expect(TripPatchResult.safeParse(res).success).toBe(true);
    expect(res.revision).toBe(2);
    expect(res.trip.title).toBe('新しい名前');
    expect(res.trip.validationState).toBe(domesticTrip.validationState);
    // fx_leg_k1 has no arrival, so the elapsed span of the Kanazawa trip is unknown and so is its delta (main does the same).
    expect(res.diff).toEqual({ durationDeltaSeconds: null, knownCostDelta: [], unknownCostItems: KANAZAWA_UNKNOWN });
  });

  it('remove: known cost goes down, unknown cost is not counted as 0', async () => {
    const api = createMockApi();
    const lunch = data(await api.patchTrip(id, { expectedRevision: 1, operations: [{ op: 'remove', itemId: 'fx_act_lunch' }] }));
    expect(lunch.diff.knownCostDelta).toEqual([{ currency: 'JPY', amountMinor: -2200 }]);
    expect(lunch.diff.durationDeltaSeconds).toBeNull(); // the untimed fx_leg_k1 makes the span unknown
    expect(lunch.trip.validationState).toBe('needs_revalidation');
    expect(lunch.trip.days.flatMap(d => d.items).some(i => i.type === 'activity' && i.activityId === 'fx_act_lunch')).toBe(false);

    // The museum has no known cost: removing it must not produce a known delta, and it stays listed as unknown
    // so the change is not shown as "cost 0". Order as main: after's plan order, then ids only in before.
    const museum = data(await api.patchTrip(id, { expectedRevision: 2, operations: [{ op: 'remove', itemId: 'fx_act_museum' }] }));
    expect(museum.diff.knownCostDelta).toEqual([]);
    expect(museum.diff.unknownCostItems).toEqual([...KANAZAWA_UNKNOWN.filter(x => x !== 'fx_act_museum'), 'fx_act_museum']);
  });

  it('remove of a leg with unknown duration makes the duration delta unknown (null)', async () => {
    const api = createMockApi();
    const res = data(await api.patchTrip(id, { expectedRevision: 1, operations: [{ op: 'remove', itemId: 'fx_leg_k1' }] }));
    expect(res.diff.durationDeltaSeconds).toBeNull();
  });

  it('move reorders within and across days without changing cost or duration', async () => {
    const api = createMockApi();
    const res = data(
      await api.patchTrip(id, {
        expectedRevision: 1,
        operations: [
          { op: 'move', itemId: 'fx_act_kazue', toDayIndex: 0, toPosition: 0 },
          { op: 'move', itemId: 'fx_act_oyama', toDayIndex: 0, toPosition: 1 },
        ],
      }),
    );
    const day0 = res.trip.days[0]?.items.map(i => (i.type === 'activity' ? i.activityId : i.legId));
    expect(day0?.slice(0, 2)).toEqual(['fx_act_kazue', 'fx_act_oyama']);
    const day1 = res.trip.days[1]?.items.map(i => (i.type === 'activity' ? i.activityId : i.legId));
    expect(day1).not.toContain('fx_act_kazue');
    expect(day1).not.toContain('fx_act_oyama');
    expect(day1?.length).toBe(domesticTrip.days[1]!.items.length - 2);
    expect(res.diff.durationDeltaSeconds).toBeNull();
    expect(res.diff.knownCostDelta).toEqual([]);
    // Same unknown-cost items, listed in the new plan order (as main).
    expect([...res.diff.unknownCostItems].sort()).toEqual([...KANAZAWA_UNKNOWN].sort());
    expect(res.diff.unknownCostItems.slice(0, 2)).toEqual(['fx_act_kazue', 'fx_act_oyama']);
    expect(res.trip.validationState).toBe('needs_revalidation');
  });

  it('add reports unknown-cost items instead of 0, update replaces the item', async () => {
    const api = createMockApi();
    const added = data(
      await api.patchTrip(id, {
        expectedRevision: 1,
        operations: [
          { op: 'add', dayIndex: 1, position: 0, item: activityItem('mock_add_a', null) },
          { op: 'add', dayIndex: 1, position: 1, item: activityItem('mock_add_b', 1500) },
        ],
      }),
    );
    expect(added.diff.unknownCostItems).toEqual(unknownWithAddedBeforeHigashi('mock_add_a'));
    expect(added.diff.knownCostDelta).toEqual([{ currency: 'JPY', amountMinor: 1500 }]);
    expect(added.diff.durationDeltaSeconds).toBeNull(); // the Kanazawa trip has an untimed leg

    const updated = data(
      await api.patchTrip(id, {
        expectedRevision: 2,
        operations: [{ op: 'update', itemId: 'mock_add_a', item: { ...activityItem('mock_add_a', 800), title: '更新後（fixture）' } }],
      }),
    );
    // It was unknown before the update, so +800 would be a delta from 0 (R11): it is left out of the known
    // delta and only listed as unknown, as main does.
    expect(updated.diff.knownCostDelta).toEqual([]);
    expect(updated.diff.unknownCostItems).toEqual(unknownWithAddedBeforeHigashi('mock_add_a'));
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
    expect(errorCode(await patch([{ op: 'add', dayIndex: 1, position: 99, item: activityItem('x2', null) }] as never))).toBe('CONSTRAINT_UNSATISFIED');
    expect(errorCode(await patch([{ op: 'add', dayIndex: 1, position: 0, item: activityItem('fx_act_higashi', null) }] as never))).toBe('CONSTRAINT_UNSATISFIED');
    expect(errorCode(await patch([{ op: 'move', itemId: 'fx_act_higashi', toDayIndex: 5, toPosition: 0 }] as never))).toBe('CONSTRAINT_UNSATISFIED');
    expect(errorCode(await patch([{ op: 'move', itemId: 'fx_act_higashi', toDayIndex: 1, toPosition: 99 }] as never))).toBe('CONSTRAINT_UNSATISFIED');
    expect(errorCode(await patch([{ op: 'update', itemId: 'fx_act_higashi', item: activityItem('other', null) }] as never))).toBe('CONSTRAINT_UNSATISFIED');
    expect(errorCode(await api.patchTrip('nope', { expectedRevision: 1, operations: [{ op: 'set_title', title: 'x' }] }))).toBe('NOT_FOUND');
    expect(errorCode(await patch([] as never))).toBe('VALIDATION_FAILED');
    expect(errorCode(await patch([{ op: 'delete_everything' }] as never))).toBe('VALIDATION_FAILED');
    expect(data(await api.getTrip(id)).revision).toBe(1);
  });

  it('rejects an unknown placeId (add and update) and an item type change on update, as main does (422)', async () => {
    const api = createMockApi();
    const patch = (operations: unknown[]) => api.patchTrip(id, { expectedRevision: 1, operations } as never);
    const elsewhere = { ...activityItem('x_place', null), placeId: 'no_such_place' };
    const res = await patch([{ op: 'add', dayIndex: 1, position: 0, item: elsewhere }]);
    expect(errorCode(res)).toBe('CONSTRAINT_UNSATISFIED');
    expect(!res.ok && res.status).toBe(422);
    expect(errorCode(await patch([{ op: 'update', itemId: 'fx_act_higashi', item: { ...activityItem('fx_act_higashi', null), placeId: 'no_such_place' } }]))).toBe(
      'CONSTRAINT_UNSATISFIED',
    );
    const leg = (extra: object) => ({
      type: 'leg', legId: 'fx_act_higashi', mode: 'walk', fromPlaceId: 'fx_omicho', toPlaceId: 'fx_higashi', departure: null, arrival: null,
      durationSeconds: null, lineName: null, platform: null, transfers: null, fare: null, dataStatus: 'unknown', provenance: null, ...extra,
    });
    // Same id but a leg instead of an activity: the type must not change.
    expect(errorCode(await patch([{ op: 'update', itemId: 'fx_act_higashi', item: leg({}) }]))).toBe('CONSTRAINT_UNSATISFIED');
    // A leg that points at a place outside the trip is rejected on add too.
    expect(errorCode(await patch([{ op: 'add', dayIndex: 1, position: 0, item: leg({ legId: 'new_leg', toPlaceId: 'no_such_place' }) }]))).toBe(
      'CONSTRAINT_UNSATISFIED',
    );
    // A null placeId and places that the trip has are fine.
    data(await patch([{ op: 'add', dayIndex: 1, position: 0, item: { ...activityItem('x_ok', null), placeId: 'fx_higashi' } }]));
    expect(data(await api.getTrip(id)).revision).toBe(2);
  });

  it('durationDeltaSeconds is the change of the elapsed span (main: earliest start to latest end), null when unknown', async () => {
    const paris = 'fx_trip_paris';
    const api = createMockApi();
    // Span 2026-10-24T08:00Z to 2026-10-25T13:00Z. Removing the last activity moves the end to the leg's arrival (11:30Z): -1.5 h.
    const removed = data(await api.patchTrip(paris, { expectedRevision: 1, operations: [{ op: 'remove', itemId: 'fx_act_eiffel' }] }));
    expect(removed.diff.durationDeltaSeconds).toBe(-5400);
    // An activity inside the span, or a move/rename, does not change the span: 0 (not unknown).
    const inside = data(
      await api.patchTrip(paris, {
        expectedRevision: 2,
        operations: [
          { op: 'set_title', title: '改名' },
          { op: 'add', dayIndex: 0, position: 0, item: activityItem('inside', null, 'Europe/Paris', '2026-10-24T09:00:00Z', '2026-10-24T09:30:00Z') },
        ],
      }),
    );
    expect(inside.diff.durationDeltaSeconds).toBe(0);
    // The span, not the sum of durations: a 30 minute activity far from the others stretches it by the whole gap.
    const far = data(
      await api.patchTrip(paris, {
        expectedRevision: 3,
        operations: [{ op: 'add', dayIndex: 1, position: 0, item: activityItem('far', null, 'Europe/Paris', '2026-10-26T09:00:00Z', '2026-10-26T09:30:00Z') }],
      }),
    );
    expect(far.diff.durationDeltaSeconds).toBe(Date.parse('2026-10-26T09:30:00Z') / 1000 - Date.parse('2026-10-25T11:30:00Z') / 1000);
    // Removing every item leaves an empty trip whose span is unknown.
    const all = data(await createMockApi().getTrip(paris)).days.flatMap(d => d.items).map(i => ({ op: 'remove' as const, itemId: i.type === 'activity' ? i.activityId : i.legId }));
    const empty = data(await createMockApi().patchTrip(paris, { expectedRevision: 1, operations: all }));
    expect(empty.diff.durationDeltaSeconds).toBeNull();
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
