/**
 * Edge-case tests for the fixture cases (B04). They complement cases.test.ts and check:
 * isolation between calls, unknown-is-not-zero rules, id integrity, DST data and failure samples.
 */
import { describe, expect, it } from 'vitest';
import { ApiError, ERROR_HTTP_STATUS, Feed, JobStatus, PlanBatch, Trip } from '@tkb/contracts';
import type { ItineraryItem, Trip as TripType } from '@tkb/contracts';
import {
  FIXTURE_NOTICE,
  createBudgetUnknownPlanBatch,
  createBudgetUnknownTrip,
  createCarTrip,
  createEmptyItemsTrip,
  createNoDaysTrip,
  createSampleFeedPosts,
  createSamplePlanBatch,
  domesticTrip,
  emptyFeed,
  emptyTripList,
  extraJobStatuses,
  fixtureTrips,
  overseasTrip,
  sampleApiErrors,
  sampleFeed,
  sampleJobStatuses,
  summarizeKnownCost,
  withUnknownCosts,
} from './index.ts';

const itemId = (item: ItineraryItem): string => (item.type === 'activity' ? item.activityId : item.legId);
const itemsOf = (trip: Pick<TripType, 'days'>): ItineraryItem[] => trip.days.flatMap(d => d.items);
const startOf = (item: ItineraryItem) => (item.type === 'activity' ? item.start : item.departure);
const endOf = (item: ItineraryItem) => (item.type === 'activity' ? item.end : item.arrival);
const moneyOf = (item: ItineraryItem) => (item.type === 'activity' ? item.cost : item.fare);

const allTrips = (): TripType[] => [
  ...fixtureTrips,
  createBudgetUnknownTrip(),
  createCarTrip(),
  createEmptyItemsTrip(),
  createNoDaysTrip(),
];

describe('fixture cases: domestic and overseas samples', () => {
  it('both base samples conform to the Trip schema and carry the fixture label', () => {
    expect(fixtureTrips.map(t => t.tripId)).toEqual(['fx_trip_kanazawa', 'fx_trip_paris']);
    for (const trip of fixtureTrips) {
      expect(Trip.safeParse(trip).success, trip.tripId).toBe(true);
      expect(trip.title, trip.tripId).toContain('fixture');
      for (const place of trip.places) expect(place.dataStatus, place.placeId).toBe('fixture');
    }
    expect(FIXTURE_NOTICE).toContain('fixture');
    // Domestic = Japan time zone and JPY, overseas = Europe/Paris and EUR.
    expect(domesticTrip.constraints.timeZone).toBe('Asia/Tokyo');
    expect(overseasTrip.constraints.timeZone).toBe('Europe/Paris');
    const currencies = (t: TripType) => new Set(itemsOf(t).flatMap(i => moneyOf(i)?.currency ?? []));
    expect([...currencies(domesticTrip)]).toEqual(['JPY']);
    expect([...currencies(overseasTrip)]).toEqual(['EUR']);
  });

  it('trip ids are unique across the base samples and every derived case', () => {
    const ids = allTrips().map(t => t.tripId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('item ids are unique inside every trip and placeIds point at the trip places', () => {
    for (const trip of allTrips()) {
      const ids = itemsOf(trip).map(itemId);
      expect(new Set(ids).size, trip.tripId).toBe(ids.length);
      const known = new Set(trip.places.map(p => p.placeId));
      for (const item of itemsOf(trip)) {
        const refs = item.type === 'activity' ? [item.placeId] : [item.fromPlaceId, item.toPlaceId];
        for (const ref of refs) {
          if (ref !== null) expect(known.has(ref), `${trip.tripId}:${itemId(item)} -> ${ref}`).toBe(true);
        }
      }
    }
  });

  it('day dates stay inside the constraints and every day keeps the trip time zone', () => {
    for (const trip of allTrips()) {
      for (const day of trip.days) {
        expect(day.date >= trip.constraints.startDate && day.date <= trip.constraints.endDate, `${trip.tripId} ${day.date}`).toBe(true);
        expect(day.timeZone, trip.tripId).toBe(trip.constraints.timeZone);
      }
    }
  });
});

describe('fixture cases: daylight saving time (Paris)', () => {
  const offsetMinutes = (utc: string, timeZone: string): number => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(utc));
    const get = (type: string) => Number(parts.find(p => p.type === type)?.value);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return (asUtc - Date.parse(utc)) / 60000;
  };
  const localHm = (utc: string) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(utc));

  it('the two Paris days really sit on both sides of the end of DST (+120 then +60 minutes)', () => {
    const first = overseasTrip.days[0]?.items[0];
    const second = overseasTrip.days[1]?.items[0];
    expect(first?.type === 'activity' && first.start?.utc).toBe('2026-10-24T08:00:00Z');
    expect(second?.type === 'activity' && second.start?.utc).toBe('2026-10-25T09:00:00Z');
    expect(offsetMinutes('2026-10-24T08:00:00Z', 'Europe/Paris')).toBe(120);
    expect(offsetMinutes('2026-10-25T09:00:00Z', 'Europe/Paris')).toBe(60);
    // The transition happens at 01:00Z on 2026-10-25.
    expect(offsetMinutes('2026-10-25T00:59:59Z', 'Europe/Paris')).toBe(120);
    expect(offsetMinutes('2026-10-25T01:00:00Z', 'Europe/Paris')).toBe(60);
  });

  it('every ZonedTime keeps a UTC instant (Z suffix) and its own IANA zone; end is not before start', () => {
    for (const item of itemsOf(overseasTrip)) {
      for (const t of [startOf(item), endOf(item)]) {
        if (t) {
          expect(t.utc).toMatch(/Z$/);
          expect(t.timeZone).toBe('Europe/Paris');
        }
      }
      const [from, to] = [startOf(item), endOf(item)];
      if (from && to) {
        expect(Date.parse(to.utc)).toBeGreaterThanOrEqual(Date.parse(from.utc));
      }
    }
  });

  it('both days start at 10:00 local although the UTC hour differs by one', () => {
    const startOf = (dayIdx: number) => {
      const it = overseasTrip.days[dayIdx]?.items[0];
      if (!it || it.type !== 'activity' || !it.start) throw new Error('missing start');
      return it.start.utc;
    };
    expect(localHm(startOf(0))).toBe('10:00');
    expect(localHm(startOf(1))).toBe('10:00');
    expect(startOf(0).slice(11, 13)).not.toBe(startOf(1).slice(11, 13));
  });
});

describe('fixture cases: isolation (fresh copy per call)', () => {
  it('each factory returns an independent object; mutating one result does not leak into the next', () => {
    const trip = createBudgetUnknownTrip();
    trip.title = 'mutated';
    trip.days[0]?.items.splice(0);
    trip.places.splice(0);
    const again = createBudgetUnknownTrip();
    expect(again.title).not.toBe('mutated');
    expect(again.days[0]?.items.length).toBeGreaterThan(0);
    expect(again.places.length).toBeGreaterThan(0);

    const batch = createSamplePlanBatch();
    batch.candidates.splice(0);
    batch.places.splice(0);
    expect(createSamplePlanBatch().candidates).toHaveLength(3);
    expect(createSamplePlanBatch().places.length).toBeGreaterThan(0);

    const posts = createSampleFeedPosts();
    posts.splice(0);
    expect(createSampleFeedPosts().length).toBeGreaterThan(2);
  });

  it('candidates of a batch do not share item objects with each other or with the base trip', () => {
    const before = JSON.stringify(domesticTrip);
    const batch = createSamplePlanBatch();
    const [c1, c2] = batch.candidates;
    const a = c1?.days[0]?.items.find(i => itemId(i) === 'fx_act_kenrokuen');
    const b = c2?.days[0]?.items.find(i => itemId(i) === 'fx_act_kenrokuen');
    expect(a).toBeDefined();
    expect(a).toEqual(b);
    if (a?.type === 'activity') a.title = 'edited';
    expect(b?.type === 'activity' && b.title).not.toBe('edited');
    expect(JSON.stringify(domesticTrip)).toBe(before);
  });

  it('derived trips do not share nested objects with the base samples', () => {
    const before = JSON.stringify([fixtureTrips, sampleFeed, sampleJobStatuses]);
    for (const trip of [createBudgetUnknownTrip(), createCarTrip(), createEmptyItemsTrip(), createNoDaysTrip()]) {
      trip.constraints.area = 'changed';
      trip.places.splice(0);
      for (const item of itemsOf(trip)) if (item.type === 'activity') item.title = 'changed';
    }
    for (const p of createSampleFeedPosts()) p.title = 'changed';
    expect(JSON.stringify([fixtureTrips, sampleFeed, sampleJobStatuses])).toBe(before);
  });

  it('withUnknownCosts and summarizeKnownCost do not mutate their input', () => {
    const days = structuredClone(domesticTrip.days);
    const before = JSON.stringify(days);
    withUnknownCosts(days);
    summarizeKnownCost(days);
    expect(JSON.stringify(days)).toBe(before);
  });
});

describe('fixture cases: unknown cost is never 0', () => {
  it('summarizeKnownCost: empty input has no totals and no unknown flag', () => {
    expect(summarizeKnownCost([])).toEqual({ totalKnownCost: [], hasUnknownCost: false });
    expect(summarizeKnownCost([{ date: '2026-11-01', timeZone: 'Asia/Tokyo', items: [] }])).toEqual({ totalKnownCost: [], hasUnknownCost: false });
  });

  it('summarizeKnownCost: currencies stay apart and sorted; null adds neither 0 nor a currency entry', () => {
    const jpy = itemsOf(domesticTrip).find(i => i.type === 'activity' && i.cost?.currency === 'JPY');
    const eur = itemsOf(overseasTrip).find(i => i.type === 'activity' && i.cost?.currency === 'EUR');
    const unknown = itemsOf(overseasTrip).find(i => i.type === 'activity' && i.cost === null);
    if (!jpy || !eur || !unknown) throw new Error('fixture shape changed');
    const jpyAmount = moneyOf(jpy)?.amountMinor ?? NaN;
    const eurAmount = moneyOf(eur)?.amountMinor ?? NaN;
    const summary = summarizeKnownCost([{ date: '2026-10-24', timeZone: 'Europe/Paris', items: [jpy, unknown, eur, structuredClone(eur)] }]);
    expect(summary.totalKnownCost).toEqual([
      { currency: 'EUR', amountMinor: eurAmount * 2 },
      { currency: 'JPY', amountMinor: jpyAmount },
    ]);
    expect(summary.hasUnknownCost).toBe(true);
    expect(summary.totalKnownCost.every(m => m.amountMinor > 0)).toBe(true);
  });

  it('summarizeKnownCost: an explicitly known zero stays known (not flagged unknown)', () => {
    const activity = structuredClone(itemsOf(domesticTrip).find(i => i.type === 'activity'));
    if (!activity || activity.type !== 'activity') throw new Error('fixture shape changed');
    activity.cost = { amountMinor: 0, currency: 'JPY' };
    expect(summarizeKnownCost([{ date: '2026-11-01', timeZone: 'Asia/Tokyo', items: [activity] }])).toEqual({
      totalKnownCost: [{ currency: 'JPY', amountMinor: 0 }],
      hasUnknownCost: false,
    });
  });

  it('withUnknownCosts nulls every cost, fare and costStatus, and keeps ids and times', () => {
    const out = withUnknownCosts(domesticTrip.days);
    expect(out.map(d => d.items.map(itemId))).toEqual(domesticTrip.days.map(d => d.items.map(itemId)));
    for (const item of itemsOf({ days: out })) {
      if (item.type === 'activity') {
        expect(item.cost).toBeNull();
        expect(item.costStatus).toBe('unknown');
      } else {
        expect(item.fare).toBeNull();
      }
    }
    expect(summarizeKnownCost(out)).toEqual({ totalKnownCost: [], hasUnknownCost: true });
    expect(itemsOf({ days: out }).map(startOf)).toEqual(itemsOf(domesticTrip).map(startOf));
  });

  it('budget-unknown trip and plan batch contain no 0 amount and no budget object', () => {
    const trip = createBudgetUnknownTrip();
    const text = JSON.stringify([trip, createBudgetUnknownPlanBatch()]);
    expect(text).not.toMatch(/"amountMinor":0[,}]/);
    expect(trip.constraints.budget).toBeNull();
  });

  it('the base samples keep unknown values null instead of 0 (Paris has an unknown fare and cost)', () => {
    const paris = itemsOf(overseasTrip);
    expect(paris.some(i => i.type === 'leg' && i.fare === null)).toBe(true);
    expect(paris.some(i => i.type === 'activity' && i.cost === null)).toBe(true);
    expect(JSON.stringify(fixtureTrips)).not.toMatch(/"amountMinor":0[,}]/);
  });
});

describe('fixture cases: plan batch integrity', () => {
  it('candidate ids are unique, days align with the domestic trip and place references resolve', () => {
    for (const batch of [createSamplePlanBatch(), createBudgetUnknownPlanBatch()]) {
      expect(PlanBatch.safeParse(batch).success, batch.batchId).toBe(true);
      expect(new Set(batch.candidates.map(c => c.candidateId)).size).toBe(batch.candidates.length);
      const places = new Set(batch.places.map(p => p.placeId));
      for (const c of batch.candidates) {
        expect(c.days.map(d => d.date), c.candidateId).toEqual(domesticTrip.days.map(d => d.date));
        const ids = itemsOf(c).map(itemId);
        expect(new Set(ids).size, c.candidateId).toBe(ids.length);
        for (const id of c.excludedPlaceIds) expect(places.has(id), `${c.candidateId} excluded ${id}`).toBe(true);
        for (const item of itemsOf(c)) {
          if (item.type === 'activity' && item.placeId !== null) expect(places.has(item.placeId)).toBe(true);
        }
      }
    }
  });

  it('excluded places are not scheduled in the same candidate', () => {
    for (const c of createSamplePlanBatch().candidates) {
      const scheduled = new Set(itemsOf(c).flatMap(i => (i.type === 'activity' && i.placeId ? [i.placeId] : [])));
      for (const id of c.excludedPlaceIds) expect(scheduled.has(id), `${c.candidateId} schedules excluded ${id}`).toBe(false);
    }
  });

  it('batch ids differ and only the sample batch is the one the succeeded job points at', () => {
    expect(createBudgetUnknownPlanBatch().batchId).not.toBe(createSamplePlanBatch().batchId);
    expect(sampleJobStatuses.succeeded.batchId).toBe(createSamplePlanBatch().batchId);
  });

  it('a candidate with unknown cost carries a warning so it does not look complete', () => {
    const [, , c3] = createSamplePlanBatch().candidates;
    expect(c3?.hasUnknownCost).toBe(false);
    expect(c3?.validationState).toBe('valid');
    for (const c of createSamplePlanBatch().candidates) {
      expect(Array.isArray(c.reasons)).toBe(true);
      if (c.hasUnknownCost) expect(c.warnings.length, c.candidateId).toBeGreaterThan(0);
    }
  });
});

describe('fixture cases: failure and waiting states', () => {
  it('every sampled API error carries its own code, a unique request id and a 4xx/5xx status', () => {
    const requestIds = new Set<string>();
    for (const [code, error] of Object.entries(sampleApiErrors)) {
      expect(error.code).toBe(code);
      expect(ApiError.safeParse(error).success, code).toBe(true);
      expect(error.requestId).not.toBe('');
      requestIds.add(error.requestId);
      expect(ERROR_HTTP_STATUS[error.code]).toBeGreaterThanOrEqual(400);
    }
    expect(requestIds.size).toBe(Object.keys(sampleApiErrors).length);
  });

  it('retryable matches the failure kind: transient errors retry, permission and conflict errors do not', () => {
    for (const code of ['UNAVAILABLE', 'RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'INVALID_OUTPUT'] as const) {
      expect(sampleApiErrors[code].retryable, code).toBe(true);
    }
    for (const code of ['UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'REVISION_CONFLICT', 'ALREADY_COMMITTED', 'VALIDATION_FAILED', 'AI_UNAVAILABLE'] as const) {
      expect(sampleApiErrors[code].retryable, code).toBe(false);
    }
  });

  it('REVISION_CONFLICT carries both revisions; NOT_FOUND reveals nothing about other users', () => {
    expect(sampleApiErrors.REVISION_CONFLICT.details).toEqual({ expectedRevision: 1, currentRevision: 2 });
    expect('details' in sampleApiErrors.NOT_FOUND).toBe(false);
    expect(sampleApiErrors.NOT_FOUND.message).not.toMatch(/fx_|owner|他のユーザー/);
  });

  it('AI_UNAVAILABLE points to manual planning instead of inventing a plan', () => {
    expect(sampleApiErrors.AI_UNAVAILABLE.message).toContain('手動');
    expect(sampleApiErrors.AI_UNAVAILABLE.details).toEqual({ reason: 'CLAUDE_EXECUTION_DISABLED' });
  });

  it('job samples: failures have an error and no batch; succeeded has a batch and no error; waiting has neither', () => {
    const all: JobStatus[] = [...Object.values(sampleJobStatuses), ...Object.values(extraJobStatuses)];
    for (const status of all) {
      expect(JobStatus.safeParse(status).success, `${status.jobId}/${status.state}`).toBe(true);
      if (status.state === 'failed') {
        expect(status.error).not.toBeNull();
        expect(status.batchId).toBeNull();
      } else if (status.state === 'succeeded') {
        expect(status.error).toBeNull();
        expect(status.batchId).not.toBeNull();
      } else {
        expect(status.batchId).toBeNull();
        expect(status.error).toBeNull();
      }
    }
    expect(new Set([sampleJobStatuses.queued.jobId, sampleJobStatuses.running.jobId, sampleJobStatuses.succeeded.jobId]).size).toBe(1);
    const otherIds = [sampleJobStatuses.failed, extraJobStatuses.cancelled, extraJobStatuses.failedInvalidOutput, extraJobStatuses.failedAiUnavailable].map(s => s.jobId);
    expect(new Set(otherIds).size).toBe(otherIds.length);
    expect(otherIds).not.toContain(sampleJobStatuses.queued.jobId);
  });

  it('timeout sample: CLI_TIMEOUT is retryable', () => {
    const err = sampleJobStatuses.failed.error;
    expect(err?.code).toBe('CLI_TIMEOUT');
    expect(err?.retryable).toBe(true);
  });

  it('job timestamps move forward from queued to running to succeeded', () => {
    const t = (s: JobStatus) => Date.parse(s.updatedAt);
    expect(t(sampleJobStatuses.queued)).toBeLessThan(t(sampleJobStatuses.running));
    expect(t(sampleJobStatuses.running)).toBeLessThan(t(sampleJobStatuses.succeeded));
  });
});

describe('fixture cases: empty and feed', () => {
  it('empty list/feed are schema-valid', () => {
    expect(Feed.safeParse(emptyFeed).success).toBe(true);
    expect(emptyFeed).toEqual({ items: [], nextCursor: null });
    expect(emptyTripList).toEqual({ items: [], nextCursor: null });
  });

  it('empty-items trip keeps its days but has no items, places or warnings; no-days trip has no days', () => {
    const empty = createEmptyItemsTrip();
    expect(empty.days.map(d => d.date)).toEqual(domesticTrip.days.map(d => d.date));
    expect(empty.places).toEqual([]);
    expect(empty.warnings).toEqual([]);
    expect(createNoDaysTrip().days).toEqual([]);
    expect(createNoDaysTrip().revision).toBe(1);
  });

  it('feed posts have unique ids and several authors; all are public fixtures', () => {
    const posts = createSampleFeedPosts();
    expect(new Set(posts.map(p => p.postId)).size).toBe(posts.length);
    expect(new Set(posts.map(p => p.authorDisplayName)).size).toBeGreaterThanOrEqual(2);
    for (const p of posts) {
      expect(p.visibility).toBe('public');
      expect(p.groupId).toBeNull();
      expect(`${p.title}${p.story}`).toContain('fixture');
    }
    expect(posts[0]).toEqual(sampleFeed.items[0]);
  });

  it('car trip changes only transit legs: ids, times and activities are unchanged and the warning mentions fuel/tolls', () => {
    const car = createCarTrip();
    expect(itemsOf(car).map(itemId)).toEqual(itemsOf(domesticTrip).map(itemId));
    expect(itemsOf(car).map(startOf)).toEqual(itemsOf(domesticTrip).map(startOf));
    expect(itemsOf(car).filter(i => i.type === 'activity')).toEqual(itemsOf(domesticTrip).filter(i => i.type === 'activity'));
    expect(car.warnings.join('')).toMatch(/燃料|高速/);
  });
});
