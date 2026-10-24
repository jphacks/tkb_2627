import { describe, expect, it } from 'vitest';
import { ApiError, Feed, JobStatus, PlanBatch, Trip, TripList } from '@tkb/contracts';
import {
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
  sampleApiErrors,
  sampleJobStatuses,
  summarizeKnownCost,
} from './index.ts';

describe('fixture cases', () => {
  it('trips conform to the Trip schema and are labelled as fixtures', () => {
    for (const trip of [createBudgetUnknownTrip(), createCarTrip(), createEmptyItemsTrip(), createNoDaysTrip()]) {
      expect(Trip.safeParse(trip).success, trip.tripId).toBe(true);
      expect(trip.title).toContain('fixture');
    }
  });

  it('budget-unknown trip has no budget and no known cost or fare (never 0)', () => {
    const trip = createBudgetUnknownTrip();
    expect(trip.constraints.budget).toBeNull();
    const items = trip.days.flatMap(d => d.items);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      if (item.type === 'activity') {
        expect(item.cost).toBeNull();
        expect(item.costStatus).toBe('unknown');
      } else {
        expect(item.fare).toBeNull();
      }
    }
    const summary = summarizeKnownCost(trip.days);
    expect(summary.totalKnownCost).toEqual([]);
    expect(summary.hasUnknownCost).toBe(true);
  });

  it('car trip uses car legs only (plus walking) and no fares', () => {
    const trip = createCarTrip();
    expect(trip.constraints.transportMode).toBe('car');
    const legs = trip.days.flatMap(d => d.items).filter(i => i.type === 'leg');
    expect(legs.some(l => l.mode === 'car')).toBe(true);
    expect(legs.some(l => l.mode === 'transit')).toBe(false);
    expect(legs.every(l => l.fare === null)).toBe(true);
  });

  it('empty trips, trip list and feed are valid and empty', () => {
    expect(createEmptyItemsTrip().days.every(d => d.items.length === 0)).toBe(true);
    expect(createNoDaysTrip().days).toEqual([]);
    expect(TripList.parse(emptyTripList).items).toEqual([]);
    expect(Feed.parse(emptyFeed).items).toEqual([]);
  });

  it('plan batches conform and totals are computed, not invented', () => {
    for (const batch of [createSamplePlanBatch(), createBudgetUnknownPlanBatch()]) {
      expect(PlanBatch.safeParse(batch).success, batch.batchId).toBe(true);
      expect(batch.candidates.length).toBeGreaterThanOrEqual(2);
      for (const c of batch.candidates) {
        expect({ totalKnownCost: c.totalKnownCost, hasUnknownCost: c.hasUnknownCost }, c.candidateId).toEqual(summarizeKnownCost(c.days));
      }
    }
    const [c1, c2, c3] = createSamplePlanBatch().candidates;
    expect(c1?.totalKnownCost).toEqual([{ currency: 'JPY', amountMinor: 200 + 320 + 4000 }]);
    expect(c1?.hasUnknownCost).toBe(true);
    expect(c2?.hasUnknownCost).toBe(true);
    expect(c3?.hasUnknownCost).toBe(false);
    expect(c3?.totalKnownCost).toEqual([{ currency: 'JPY', amountMinor: 4520 }]);
    expect(createBudgetUnknownPlanBatch().candidates.every(c => c.hasUnknownCost && c.totalKnownCost.length === 0)).toBe(true);
  });

  it('succeeded sample job points at the sample batch', () => {
    expect(createSamplePlanBatch().batchId).toBe(sampleJobStatuses.succeeded.batchId);
  });

  it('error and job samples conform', () => {
    for (const error of Object.values(sampleApiErrors)) expect(ApiError.safeParse(error).success, error.code).toBe(true);
    for (const status of Object.values(extraJobStatuses)) expect(JobStatus.safeParse(status).success, status.jobId).toBe(true);
    expect(extraJobStatuses.cancelled.state).toBe('cancelled');
    expect(extraJobStatuses.failedInvalidOutput.error.code).toBe('INVALID_OUTPUT');
  });

  it('feed posts conform and allow pagination', () => {
    const posts = createSampleFeedPosts();
    expect(posts.length).toBeGreaterThan(2);
    expect(Feed.safeParse({ items: posts, nextCursor: null }).success).toBe(true);
  });

  it('building cases does not mutate the base fixture', () => {
    const before = JSON.stringify(domesticTrip);
    createBudgetUnknownTrip();
    createCarTrip();
    createEmptyItemsTrip();
    createSamplePlanBatch().candidates[0]?.days[0]?.items.splice(0);
    createBudgetUnknownPlanBatch();
    expect(JSON.stringify(domesticTrip)).toBe(before);
  });
});
