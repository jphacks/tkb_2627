import { describe, expect, it } from 'vitest';
import {
  ERROR_HTTP_STATUS,
  ErrorCode,
  GenerateRequest,
  JobStatus,
  Money,
  NonNegativeMoney,
  PlanBatchCreate,
  PlanBlueprint,
  PostPatchRequest,
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

describe('reviewer findings (bootstrap PR)', () => {
  const trip = fixtureTrips[0]!;
  it('PostSnapshot drops departure/return and budget (possible home address, private budget)', () => {
    const snap = PostSnapshot.parse({
      schemaVersion: 1,
      title: trip.title,
      constraints: {
        ...trip.constraints,
        departure: { placeId: null, label: '自宅 東京都文京区…', time: null },
        budget: { amountMinor: 50000, currency: 'JPY' },
      },
      days: trip.days,
      places: trip.places,
      redactionVersion: 1,
    });
    const json = JSON.stringify(snap);
    expect(json).not.toContain('自宅');
    expect(snap.constraints).not.toHaveProperty('budget');
    expect(snap.constraints).not.toHaveProperty('departure');
  });
  it('replan requires baseTripId and expectedRevision', () => {
    expect(GenerateRequest.safeParse({ mode: 'replan', constraints }).success).toBe(false);
    expect(GenerateRequest.safeParse({ mode: 'replan', constraints, baseTripId: 't1', expectedRevision: 3 }).success).toBe(true);
  });
  it('blueprint rejects duplicate place ids', () => {
    const c = { ...samplePlanBlueprint.candidates[0]!, activityOrder: ['a', 'a'] };
    expect(PlanBlueprint.safeParse({ schemaVersion: 1, candidates: [c] }).success).toBe(false);
  });
  it('post patch keeps visibility and groupId consistent', () => {
    expect(PostPatchRequest.safeParse({ expectedPostRevision: 1, visibility: 'group' }).success).toBe(false);
    expect(PostPatchRequest.safeParse({ expectedPostRevision: 1, groupId: 'g1' }).success).toBe(false);
    expect(PostPatchRequest.safeParse({ expectedPostRevision: 1, visibility: 'private' }).success).toBe(true);
  });
  it('null cost is marked unknown in fixtures', () => {
    for (const d of trip.days) for (const i of d.items) if (i.type === 'activity' && i.cost === null) expect(i.costStatus).toBe('unknown');
  });
});

describe('PlanBatchCreate constraints (K07)', () => {
  const base = { schemaVersion: 1, baseTripId: null, baseRevision: null, generationId: 'g1', candidates: [{ candidateId: 'c1', title: 't', days: [], reasons: [], warnings: [], excludedPlaceIds: [], totalKnownCost: [], hasUnknownCost: false, validationState: 'needs_review' }], places: [] };
  it('constraints is optional and validated when present', () => {
    expect(PlanBatchCreate.safeParse(base).success).toBe(true);
    expect(PlanBatchCreate.safeParse({ ...base, constraints }).success).toBe(true);
    expect(PlanBatchCreate.safeParse({ ...base, constraints: { area: 'x' } }).success).toBe(false);
  });
});

describe('K05 PlanningContextRequest additive fields (C-1, schemaVersion stays 1)', () => {
  const base = { area: '金沢', transportMode: 'transit' as const };
  const q = { fromPlaceId: 'a', toPlaceId: 'b', departureUtc: '2026-11-01T00:00:00Z', mode: 'walk' as const };
  it('old requests still parse; maxPlaces still defaults to 8', async () => {
    const { PlanningContextRequest } = await import('../src/index.ts');
    expect(PlanningContextRequest.parse(base)).toEqual({ ...base, maxPlaces: 8 });
  });
  it('accepts timeZone and up to 8 leg queries, and rejects more, bad zones and malformed queries', async () => {
    const { PlanningContextRequest, SCHEMA_VERSION } = await import('../src/index.ts');
    expect(SCHEMA_VERSION).toBe(1);
    expect(PlanningContextRequest.parse({ ...base, timeZone: 'Asia/Tokyo', legs: [q] }).legs).toEqual([q]);
    expect(PlanningContextRequest.safeParse({ ...base, legs: Array.from({ length: 9 }, () => q) }).success).toBe(false);
    expect(PlanningContextRequest.safeParse({ ...base, timeZone: '+09:00' }).success).toBe(false);
    expect(PlanningContextRequest.safeParse({ ...base, legs: [{ ...q, mode: 'boat' }] }).success).toBe(false);
    expect(PlanningContextRequest.safeParse({ ...base, legs: [{ ...q, departureUtc: 'tomorrow' }] }).success).toBe(false);
  });
});

describe('compatible additions (R6 per-day mode, R05 transit stops)', () => {
  it('transportModeByDate is optional, keyed by local date, values transit|car, and public', () => {
    expect(TripConstraints.safeParse({ ...constraints, transportModeByDate: { '2026-11-02': 'car' } }).success).toBe(true);
    expect(TripConstraints.safeParse({ ...constraints, transportModeByDate: { '2026-11-02': 'walk' } }).success).toBe(false);
    expect(TripConstraints.safeParse({ ...constraints, transportModeByDate: { 'day-2': 'car' } }).success).toBe(false);
    expect(TripConstraints.safeParse(constraints).success).toBe(true);
  });
  it('TravelLeg.transit is optional and keeps unknown stops as null', () => {
    const leg = fixtureTrips[0]!.days[0]!.items.find((i) => i.type === 'leg')!;
    expect(Trip.shape.days.element.shape.items.element.safeParse({ ...leg, transit: { boardingStop: null, alightingStop: '兼六園下', transferStops: [] } }).success).toBe(true);
    expect(Trip.shape.days.element.shape.items.element.safeParse({ ...leg, transit: { boardingStop: 1 } }).success).toBe(false);
  });
});

describe('K10 extension: alternatives preview (A05, schemaVersion stays 1)', () => {
  const op = { op: 'move' as const, itemId: 'a1', toDayIndex: 0, toPosition: 2 };
  it('request is the strict PATCH body plus optional maxAlternatives 1..3', async () => {
    const { AlternativesRequest } = await import('../src/index.ts');
    expect(AlternativesRequest.parse({ expectedRevision: 1, operations: [op] })).toEqual({ expectedRevision: 1, operations: [op] });
    expect(AlternativesRequest.safeParse({ expectedRevision: 1, operations: [op], maxAlternatives: 3 }).success).toBe(true);
    for (const bad of [0, 4, 1.5, '2']) expect(AlternativesRequest.safeParse({ expectedRevision: 1, operations: [op], maxAlternatives: bad }).success).toBe(false);
    expect(AlternativesRequest.safeParse({ expectedRevision: 1, operations: [op], extra: true }).success).toBe(false);
    expect(AlternativesRequest.safeParse({ expectedRevision: 1, operations: [] }).success).toBe(false);
  });
  it('affected segments never report unknown travel as 0, and operations may be null', async () => {
    const { AffectedSegment, AlternativeCandidate } = await import('../src/index.ts');
    expect(AffectedSegment.safeParse({ dayIndex: 0, fromItemId: 'a', toItemId: 'b', travel: 'unknown' }).success).toBe(true);
    expect(AffectedSegment.safeParse({ dayIndex: 0, fromItemId: 'a', toItemId: 'b', travel: 0 }).success).toBe(false);
    expect(AlternativeCandidate.shape.operations.safeParse(null).success).toBe(true);
    expect(AlternativeCandidate.shape.kind.options).toEqual(['requested', 'reorder', 'swap']);
  });
});
