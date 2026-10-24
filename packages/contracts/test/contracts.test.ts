import { describe, expect, it } from 'vitest';
import {
  ERROR_HTTP_STATUS,
  ErrorCode,
  GenerateRequest,
  JobStatus,
  Money,
  NonNegativeMoney,
  PlanBlueprint,
  PostPreviewRequest,
  PostSnapshot,
  TimeZone,
  Trip,
  TripConstraints,
  UtcInstant,
} from '@tkb/contracts';
import { fixtureTrips, sampleFeed, sampleJobStatuses, samplePlanBlueprint } from '@tkb/fixtures';

const constraints = { area: '金沢', startDate: '2026-11-01', endDate: '2026-11-02', timeZone: 'Asia/Tokyo', transportMode: 'transit' };

describe('fixtures conform to schema v1', () => {
  it.each(fixtureTrips.map(t => [t.tripId, t] as const))('%s is a valid Trip', (_id, trip) => {
    expect(Trip.parse(trip)).toEqual(trip);
  });
  it('job, blueprint and feed samples are valid', () => {
    for (const s of Object.values(sampleJobStatuses)) JobStatus.parse(s);
    PlanBlueprint.parse(samplePlanBlueprint);
    expect(sampleFeed.items.length).toBeGreaterThan(0);
  });
  it('every fixture item is labelled as non-live data', () => {
    for (const trip of fixtureTrips) {
      for (const p of trip.places) expect(p.dataStatus).toBe('fixture');
      for (const d of trip.days) for (const i of d.items) if (i.type === 'leg') expect(['fixture', 'unknown']).toContain(i.dataStatus);
    }
  });
});

describe('value types reject invalid input', () => {
  it('money must be an integer minor unit with an ISO code', () => {
    expect(Money.safeParse({ amountMinor: 10.5, currency: 'JPY' }).success).toBe(false);
    expect(Money.safeParse({ amountMinor: 100, currency: 'yen' }).success).toBe(false);
    expect(NonNegativeMoney.safeParse({ amountMinor: -1, currency: 'JPY' }).success).toBe(false);
    expect(Money.safeParse({ amountMinor: -1, currency: 'JPY' }).success).toBe(true);
  });
  it('instants must be UTC with Z', () => {
    expect(UtcInstant.safeParse('2026-11-01T09:00:00+09:00').success).toBe(false);
    expect(UtcInstant.safeParse('2026-11-01T00:00:00Z').success).toBe(true);
  });
  it('time zones must be IANA names', () => {
    expect(TimeZone.safeParse('Asia/Tokyo').success).toBe(true);
    expect(TimeZone.safeParse('+09:00').success).toBe(false);
    expect(TimeZone.safeParse('Mars/Olympus').success).toBe(false);
  });
  it('endDate before startDate is rejected', () => {
    expect(TripConstraints.safeParse({ ...constraints, endDate: '2026-10-31' }).success).toBe(false);
  });
});

describe('request boundaries', () => {
  it('K01 rejects ownerId and unknown fields', () => {
    expect(GenerateRequest.safeParse({ constraints }).success).toBe(true);
    expect(GenerateRequest.safeParse({ constraints, ownerId: 'user_b' }).success).toBe(false);
  });
  it('K12 requires groupId exactly for group visibility', () => {
    const base = { tripId: 't1', sourceRevision: 1, story: 's' };
    expect(PostPreviewRequest.safeParse({ ...base, visibility: 'group' }).success).toBe(false);
    expect(PostPreviewRequest.safeParse({ ...base, visibility: 'group', groupId: 'g1' }).success).toBe(true);
    expect(PostPreviewRequest.safeParse({ ...base, visibility: 'public', groupId: 'g1' }).success).toBe(false);
  });
  it('PostSnapshot strips private notes', () => {
    const trip = fixtureTrips[0]!;
    const snap = PostSnapshot.parse({ schemaVersion: 1, title: trip.title, constraints: trip.constraints, days: trip.days, places: trip.places, redactionVersion: 1 });
    expect(JSON.stringify(snap)).not.toContain('privateNotes');
  });
  it('job status invariants', () => {
    const now = '2026-10-24T00:00:00Z';
    expect(JobStatus.safeParse({ jobId: 'j', state: 'succeeded', stage: 'saved', batchId: null, error: null, updatedAt: now }).success).toBe(false);
    expect(JobStatus.safeParse({ jobId: 'j', state: 'failed', stage: 'generating', batchId: null, error: null, updatedAt: now }).success).toBe(false);
  });
  it('blueprint allows at most three candidates', () => {
    const c = samplePlanBlueprint.candidates[0]!;
    expect(PlanBlueprint.safeParse({ schemaVersion: 1, candidates: [c, c, c, c] }).success).toBe(false);
  });
  it('every error code maps to an HTTP status', () => {
    for (const code of ErrorCode.options) expect(ERROR_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
  });
});
