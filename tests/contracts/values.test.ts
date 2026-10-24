// T01 value boundaries, schema breakage and AI input/output schemas (R01 R07 R28).
// Written from packages/contracts and docs/03_CONTRACTS.md; complements packages/contracts/test/contracts.test.ts
// (which already covers the basic reject cases) with boundaries and with breakage of every schemaVersion carrier.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Activity, ApiError, ApplyCandidateRequest, Capabilities, CopyRequest, CurrencyCode, ExportRequest, GenerateRequest,
  GenerationInput, GroupCreateRequest, GroupInviteAccept, GroupInviteCreate, Health, Id, JobAccepted, JobStatus, LocalDate,
  LoginRequest, Money, NonNegativeMoney, PlanBatchCreate, PlanBlueprint, PostCreateRequest, PostPatchRequest, PostPreviewRequest,
  PostSnapshot, TimeZone, Trip, TripConstraints, TripPatchRequest, UtcInstant, ZonedTime,
} from '@tkb/contracts';
import { domesticTrip, fixtureTrips, samplePlanBlueprint } from '@tkb/fixtures';

const ok = (s: z.ZodType, v: unknown) => s.safeParse(v).success;
const constraints = { area: '金沢', startDate: '2026-11-01', endDate: '2026-11-02', timeZone: 'Asia/Tokyo', transportMode: 'transit' };
const clone = <T>(v: T): T => structuredClone(v);
/** Messages of the issues, with the path they were reported on. */
const paths = (s: z.ZodType, v: unknown) => {
  const r = s.safeParse(v);
  return r.success ? [] : r.error.issues.map(i => i.path.join('.'));
};

describe('date-time values (R07)', () => {
  it.each([
    ['2026-02-30T00:00:00Z', 'non-existent calendar day'],
    ['2026-13-01T00:00:00Z', 'month 13'],
    ['2026-11-01T24:00:00Z', 'hour 24'],
    ['2026-11-01T23:59:60Z', 'leap second'],
    ['2026-11-01T00:00:00+09:00', 'offset'],
    ['2026-11-01T00:00:00+00:00', 'zero offset is still an offset (must be Z)'],
    ['2026-11-01T00:00:00', 'no designator'],
    ['2026-11-01T00:00:00z', 'lower-case z'],
    ['2026-11-01 00:00:00Z', 'space instead of T'],
    ['2026-11-01', 'date only'],
    ['', 'empty'],
  ])('UtcInstant rejects %s (%s)', (v) => {
    expect(ok(UtcInstant, v)).toBe(false);
  });
  it.each(['2026-11-01T00:00:00Z', '2026-11-01T00:00:00.123Z', '2028-02-29T23:59:59Z'])('UtcInstant accepts %s', (v) => {
    expect(ok(UtcInstant, v)).toBe(true);
  });
  it.each(['2026-02-30', '2026-02-29', '2026-04-31', '2026-1-1', '2026-11-01T00:00:00Z', '20261101', ''])('LocalDate rejects %s', (v) => {
    expect(ok(LocalDate, v)).toBe(false);
  });
  it.each(['2026-11-01', '2028-02-29', '2000-02-29'])('LocalDate accepts %s (leap years included)', (v) => {
    expect(ok(LocalDate, v)).toBe(true);
  });
  it('1900-02-29 is not a leap day', () => {
    expect(ok(LocalDate, '1900-02-29')).toBe(false);
  });
  it.each(['+09:00', 'JST', 'GMT', 'Mars/Olympus', '', ' Asia/Tokyo', 'Asia/Tokyo\n'])('TimeZone rejects %j', (v) => {
    expect(ok(TimeZone, v)).toBe(false);
  });
  it.each(['Asia/Tokyo', 'Europe/Paris', 'America/New_York', 'UTC'])('TimeZone accepts %s', (v) => {
    expect(ok(TimeZone, v)).toBe(true);
  });
  // Documented limit: the check is Intl-based, which resolves zone names case-insensitively, so non-canonical
  // spellings pass. Stored values should be normalized by the writer (FINDINGS C-3).
  it('documents [FINDINGS C-3: 修正時は反転]: a lower-case zone name (asia/tokyo) is accepted today', () => {
    expect(ok(TimeZone, 'asia/tokyo')).toBe(true);
    expect(ok(TimeZone, 'utc')).toBe(false);
  });
  it('ZonedTime needs both utc and timeZone, and rejects an offset instant (R07)', () => {
    expect(ok(ZonedTime, { utc: '2026-11-01T00:00:00Z', timeZone: 'Asia/Tokyo' })).toBe(true);
    expect(ok(ZonedTime, { utc: '2026-11-01T00:00:00Z' })).toBe(false);
    expect(ok(ZonedTime, { timeZone: 'Asia/Tokyo' })).toBe(false);
    expect(ok(ZonedTime, { utc: '2026-11-01T09:00:00+09:00', timeZone: 'Asia/Tokyo' })).toBe(false);
  });
  it('a bad instant inside a nested activity is reported at its path', () => {
    const a = clone(domesticTrip.days[0]!.items.find(i => i.type === 'activity')!);
    (a as { start: unknown }).start = { utc: '2026-02-30T00:00:00Z', timeZone: 'Asia/Tokyo' };
    expect(paths(Activity, a)).toEqual(['start.utc']);
  });
  it('TripConstraints rejects an impossible date and reports the field', () => {
    expect(paths(TripConstraints, { ...constraints, startDate: '2026-02-30' })).toContain('startDate');
    expect(paths(TripConstraints, { ...constraints, endDate: '2026-11-31' })).toContain('endDate');
  });
  it('one-day trips (endDate === startDate) are valid, reversed ones are rejected on endDate', () => {
    expect(ok(TripConstraints, { ...constraints, endDate: constraints.startDate })).toBe(true);
    expect(paths(TripConstraints, { ...constraints, endDate: '2026-10-31' })).toEqual(['endDate']);
  });
  // Documented limit: the schema cannot know that a ZonedTime.utc matches the zone's local day or that a
  // DST gap exists; that is checked by packages/planner (D-series), not by the contract.
  it('documents: an instant is not checked against the trip day or zone', () => {
    const t = clone(domesticTrip);
    (t.days[0]!.items[1] as Activity).start = { utc: '1999-01-01T00:00:00Z', timeZone: 'Europe/Paris' };
    expect(ok(Trip, t)).toBe(true);
  });
});

describe('currency and money', () => {
  it.each(['yen', 'jpy', 'JP', 'JPYY', 'J1Y', '', ' JPY', '円'])('CurrencyCode rejects %j', (v) => {
    expect(ok(CurrencyCode, v)).toBe(false);
  });
  it.each(['JPY', 'EUR', 'USD'])('CurrencyCode accepts %s', (v) => {
    expect(ok(CurrencyCode, v)).toBe(true);
  });
  // Documented limit: only the shape is checked. Syntactically valid but unassigned codes are accepted
  // ('XXX' is ISO "no currency"; 'ZZZ' is unassigned). Rejecting them needs a code list in the contract.
  it('documents [FINDINGS C-1: 修正時は反転]: ISO-shaped but unassigned codes (XXX, ZZZ) are accepted today', () => {
    expect(ok(Money, { amountMinor: 1, currency: 'XXX' })).toBe(true);
    expect(ok(Money, { amountMinor: 1, currency: 'ZZZ' })).toBe(true);
  });
  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, '100', null, undefined])('Money rejects amountMinor %j', (v) => {
    expect(ok(Money, { amountMinor: v, currency: 'JPY' })).toBe(false);
  });
  it('Money requires both fields and is never 0 by default', () => {
    expect(ok(Money, { currency: 'JPY' })).toBe(false);
    expect(ok(Money, { amountMinor: 1 })).toBe(false);
    expect(ok(Money, null)).toBe(false);
  });
  it('NonNegativeMoney accepts 0 and rejects -1; plain Money keeps negative deltas', () => {
    expect(ok(NonNegativeMoney, { amountMinor: 0, currency: 'JPY' })).toBe(true);
    expect(ok(NonNegativeMoney, { amountMinor: -1, currency: 'JPY' })).toBe(false);
    expect(ok(Money, { amountMinor: -1, currency: 'JPY' })).toBe(true);
  });
  it('a negative activity cost or leg fare is rejected inside a Trip', () => {
    const t = clone(domesticTrip);
    (t.days[0]!.items[1] as Activity).cost = { amountMinor: -1, currency: 'JPY' };
    expect(ok(Trip, t)).toBe(false);
    const t2 = clone(domesticTrip);
    const legItem = t2.days[0]!.items[0]!;
    if (legItem.type !== 'leg') throw new Error('fixture changed');
    legItem.fare = { amountMinor: -200, currency: 'JPY' };
    expect(ok(Trip, t2)).toBe(false);
  });
  it('an unknown currency in the budget is reported on the budget path', () => {
    expect(paths(TripConstraints, { ...constraints, budget: { amountMinor: 1000, currency: 'yen' } })).toEqual(['budget.currency']);
  });
});

describe('missing data and ids', () => {
  const required = ['area', 'startDate', 'endDate', 'timeZone', 'transportMode'] as const;
  it.each(required)('TripConstraints without %s is rejected on that field (nothing is defaulted, R01)', (k) => {
    const c: Record<string, unknown> = { ...constraints };
    delete c[k];
    expect(paths(TripConstraints, c)).toContain(k);
  });
  it('TripConstraints rejects empty area, over-long area, unknown transport mode and too many mustVisit', () => {
    expect(ok(TripConstraints, { ...constraints, area: '' })).toBe(false);
    expect(ok(TripConstraints, { ...constraints, area: 'x'.repeat(201) })).toBe(false);
    expect(ok(TripConstraints, { ...constraints, transportMode: 'bike' })).toBe(false);
    expect(ok(TripConstraints, { ...constraints, mustVisit: Array.from({ length: 31 }, (_, i) => `p${i}`) })).toBe(false);
  });
  it.each([['', false], ['a', true], ['a-b_C9', true], ['a b', false], ['a/b', false], ['日本', false], ['x'.repeat(128), true], ['x'.repeat(129), false]])(
    'Id %j -> %s',
    (v, expected) => {
      expect(ok(Id, v)).toBe(expected);
    },
  );
  it('Trip rejects a missing required field for every top-level key', () => {
    for (const k of Object.keys(domesticTrip)) {
      const t: Record<string, unknown> = clone(domesticTrip) as unknown as Record<string, unknown>;
      delete t[k];
      expect(ok(Trip, t), `Trip without ${k}`).toBe(false);
    }
  });
  it('an Activity with a missing nullable key is rejected: unknown must be written as null, not omitted', () => {
    const a = clone(domesticTrip.days[0]!.items[1]) as Record<string, unknown>;
    for (const k of ['cost', 'costStatus', 'start', 'end', 'placeId', 'privateNotes']) {
      const b = { ...a };
      delete b[k];
      expect(ok(Activity, b), `Activity without ${k}`).toBe(false);
    }
  });
  it('JobStatus requires every key, including nullable batchId and error', () => {
    const base = { jobId: 'j', state: 'running', stage: 'generating', batchId: null, error: null, updatedAt: '2026-10-24T00:00:00Z' };
    expect(ok(JobStatus, base)).toBe(true);
    for (const k of Object.keys(base)) {
      const b: Record<string, unknown> = { ...base };
      delete b[k];
      expect(ok(JobStatus, b), `JobStatus without ${k}`).toBe(false);
    }
  });
  it('ApiError requires code, message, retryable and requestId; unknown codes are rejected', () => {
    const base = { code: 'NOT_FOUND', message: 'm', retryable: false, requestId: 'r' };
    expect(ok(ApiError, base)).toBe(true);
    for (const k of Object.keys(base)) {
      const b: Record<string, unknown> = { ...base };
      delete b[k];
      expect(ok(ApiError, b), `ApiError without ${k}`).toBe(false);
    }
    expect(ok(ApiError, { ...base, code: 'TEAPOT' })).toBe(false);
    expect(ok(ApiError, { ...base, code: 'not_found' })).toBe(false);
  });
});

describe('schema breakage (schemaVersion and unknown keys)', () => {
  const blueprint = () => clone(samplePlanBlueprint);
  it.each([2, 0, '1', null, 1.5])('schemaVersion %j is rejected by every carrier', (v) => {
    const trip = { ...clone(domesticTrip), schemaVersion: v };
    expect(ok(Trip, trip)).toBe(false);
    expect(ok(PlanBlueprint, { ...blueprint(), schemaVersion: v })).toBe(false);
    expect(ok(Health, { status: 'ok', service: 'shared', schemaVersion: v, time: '2026-10-24T00:00:00Z' })).toBe(false);
    expect(ok(Capabilities, { entry: 'shared', aiGeneration: { available: false, runner: 'none', reason: null }, storage: 'shared-server', dataMode: 'fixture', schemaVersion: v })).toBe(false);
    expect(ok(PostSnapshot, { schemaVersion: v, title: 't', constraints: { area: 'a', startDate: '2026-11-01', endDate: '2026-11-01', timeZone: 'Asia/Tokyo', transportMode: 'car' }, days: [], places: [], redactionVersion: 1 })).toBe(false);
  });
  it('schemaVersion missing is rejected (GenerationInput, PlanBatchCreate)', () => {
    const gi = { constraints, allowedPlaceIds: [], facts: [], fixedActivities: [], instructions: 'x' };
    expect(ok(GenerationInput, gi)).toBe(false);
    expect(ok(GenerationInput, { ...gi, schemaVersion: 1 })).toBe(true);
    expect(ok(PlanBatchCreate, { baseTripId: null, baseRevision: null, generationId: 'g', candidates: [], places: [] })).toBe(false);
  });
  it('PlanBatchCreate with schemaVersion 2 is rejected even when everything else is valid', () => {
    const cand = { candidateId: 'c1', title: 't', days: [], reasons: [], warnings: [], excludedPlaceIds: [], totalKnownCost: [], hasUnknownCost: false, validationState: 'needs_review' };
    const base = { schemaVersion: 1, baseTripId: null, baseRevision: null, generationId: 'g1', candidates: [cand], places: [], constraints };
    expect(ok(PlanBatchCreate, base)).toBe(true);
    expect(ok(PlanBatchCreate, { ...base, schemaVersion: 2 })).toBe(false);
  });
  const strictCases: [string, z.ZodType, Record<string, unknown>][] = [
    ['LoginRequest', LoginRequest, { loginId: 'a', password: 'b' }],
    ['GenerateRequest', GenerateRequest, { constraints }],
    ['PlanBatchCreate', PlanBatchCreate, { schemaVersion: 1, baseTripId: null, baseRevision: null, generationId: 'g', candidates: [{ candidateId: 'c', title: 't', days: [], reasons: [], warnings: [], excludedPlaceIds: [], totalKnownCost: [], hasUnknownCost: false, validationState: 'valid' }], places: [] }],
    ['ApplyCandidateRequest', ApplyCandidateRequest, { batchId: 'b', candidateId: 'c', tripId: null, expectedRevision: null }],
    ['TripPatchRequest', TripPatchRequest, { expectedRevision: 1, operations: [{ op: 'set_title', title: 't' }] }],
    ['PostPreviewRequest', PostPreviewRequest, { tripId: 't', sourceRevision: 1, visibility: 'public', story: 's' }],
    ['PostCreateRequest', PostCreateRequest, { previewToken: 'x'.repeat(16), confirmed: true }],
    ['PostPatchRequest', PostPatchRequest, { expectedPostRevision: 1, story: 's' }],
    ['CopyRequest', CopyRequest, { newStartDate: '2026-12-01', timeZone: 'Asia/Tokyo' }],
    ['GroupCreateRequest', GroupCreateRequest, { name: 'club' }],
    ['GroupInviteCreate', GroupInviteCreate, {}],
    ['GroupInviteAccept', GroupInviteAccept, { token: 'x'.repeat(16) }],
    ['ExportRequest', ExportRequest, { expectedRevision: 1, format: 'pdf' }],
  ];
  it.each(strictCases)('%s accepts its sample and rejects an unknown key (ownerId, extra)', (_n, schema, sample) => {
    expect(ok(schema, sample)).toBe(true);
    expect(ok(schema, { ...sample, ownerId: 'user_b' })).toBe(false);
    expect(ok(schema, { ...sample, extra: 1 })).toBe(false);
  });
  it('a server-controlled field cannot be smuggled into the K09 trip patch operations', () => {
    expect(ok(TripPatchRequest, { expectedRevision: 1, operations: [{ op: 'set_title', title: 't' }], ownerId: 'user_b' })).toBe(false);
    expect(ok(TripPatchRequest, { expectedRevision: 1, operations: [{ op: 'delete_trip' }] })).toBe(false);
    expect(ok(TripPatchRequest, { expectedRevision: 1, operations: [] })).toBe(false);
    expect(ok(TripPatchRequest, { expectedRevision: 1, operations: Array.from({ length: 51 }, () => ({ op: 'set_title', title: 't' })) })).toBe(false);
  });
  it('PostCreateRequest requires confirmed === true (not "true", not false)', () => {
    for (const v of [false, 'true', 1, undefined]) expect(ok(PostCreateRequest, { previewToken: 'x'.repeat(16), confirmed: v })).toBe(false);
    expect(ok(PostCreateRequest, { previewToken: 'short', confirmed: true })).toBe(false);
  });
  it('JobAccepted allows only the queued state with a positive integer pollAfterMs', () => {
    expect(ok(JobAccepted, { jobId: 'j', state: 'queued', pollAfterMs: 2000 })).toBe(true);
    expect(ok(JobAccepted, { jobId: 'j', state: 'running', pollAfterMs: 2000 })).toBe(false);
    expect(ok(JobAccepted, { jobId: 'j', state: 'queued', pollAfterMs: 0 })).toBe(false);
  });
  it('JobStatus invariants hold for every terminal state combination', () => {
    const now = '2026-10-24T00:00:00Z';
    const err = { code: 'CLI_TIMEOUT', message: 'm', retryable: true, requestId: 'r' };
    expect(ok(JobStatus, { jobId: 'j', state: 'succeeded', stage: 'done', batchId: 'b', error: null, updatedAt: now })).toBe(true);
    expect(ok(JobStatus, { jobId: 'j', state: 'failed', stage: 'generating', batchId: null, error: err, updatedAt: now })).toBe(true);
    expect(ok(JobStatus, { jobId: 'j', state: 'cancelled', stage: 'generating', batchId: null, error: null, updatedAt: now })).toBe(true);
    expect(ok(JobStatus, { jobId: 'j', state: 'failed', stage: 'generating', batchId: null, error: { ...err, code: 'NOPE' }, updatedAt: now })).toBe(false);
    expect(ok(JobStatus, { jobId: 'j', state: 'running', stage: 'uploading', batchId: null, error: null, updatedAt: now })).toBe(false);
  });
});

/** Reduces a JSON Schema to what the CLI contract depends on: object keys, required, additionalProperties, array bounds. */
function outline(node: unknown): unknown {
  const n = node as Record<string, unknown>;
  if (n.type === 'object' && n.properties) {
    const props = n.properties as Record<string, unknown>;
    return {
      type: 'object',
      required: [...((n.required as string[] | undefined) ?? [])].sort(),
      additionalProperties: n.additionalProperties ?? '(unset)',
      properties: Object.fromEntries(Object.keys(props).sort().map(k => [k, outline(props[k])])),
    };
  }
  if (n.type === 'array') {
    return { type: 'array', ...(n.minItems !== undefined ? { minItems: n.minItems } : {}), ...(n.maxItems !== undefined ? { maxItems: n.maxItems } : {}), items: outline(n.items) };
  }
  if (Array.isArray(n.oneOf) || Array.isArray(n.anyOf)) return { union: ((n.oneOf ?? n.anyOf) as unknown[]).map(outline) };
  if (n.enum) return { enum: n.enum };
  if (n.const !== undefined) return { const: n.const };
  return { type: n.type ?? '(none)' };
}

// Scope: these tests pin the behaviour of zod 4.6.7 `z.toJSONSchema` with its default (io: 'output'). The function the
// CLI path will use to build --json-schema does not exist yet (A04); when it is added, point these tests at it.
describe('AI input/output JSON Schema (K03, R28)', () => {
  const inputSchema = z.toJSONSchema(GenerationInput) as Record<string, unknown>;
  const outputSchema = z.toJSONSchema(PlanBlueprint) as Record<string, unknown>;

  it('both schemas can be generated and are draft 2020-12 objects (what --json-schema needs)', () => {
    for (const s of [inputSchema, outputSchema]) {
      expect(s.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(s.type).toBe('object');
      expect(JSON.parse(JSON.stringify(s))).toEqual(s); // plain JSON, no functions or undefined
    }
  });
  it('PlanBlueprint output schema: closed object, schemaVersion const 1, 1..3 candidates, activityOrder min 1', () => {
    const o = outline(outputSchema) as { required: string[]; additionalProperties: unknown; properties: Record<string, any> };
    expect(o.required).toEqual(['candidates', 'schemaVersion']);
    expect(o.additionalProperties).toBe(false);
    expect(o.properties.schemaVersion).toEqual({ const: 1 });
    expect(o.properties.candidates.minItems).toBe(1);
    expect(o.properties.candidates.maxItems).toBe(3);
    const c = o.properties.candidates.items;
    expect(c.required).toEqual(['activityOrder', 'candidateId', 'reasons', 'warnings']);
    expect(c.additionalProperties).toBe(false);
    expect(c.properties.activityOrder.minItems).toBe(1);
    expect(Object.keys(c.properties).sort()).toEqual(['activityOrder', 'candidateId', 'excludedPlaceIds', 'reasons', 'title', 'warnings']);
  });
  it('GenerationInput schema: closed object with every key required and no owner/command/path fields', () => {
    const o = outline(inputSchema) as { required: string[]; additionalProperties: unknown; properties: Record<string, unknown> };
    expect(o.required).toEqual(['allowedPlaceIds', 'constraints', 'facts', 'fixedActivities', 'instructions', 'schemaVersion']);
    expect(o.additionalProperties).toBe(false);
    expect(Object.keys(o.properties).sort()).toEqual(o.required);
    const text = JSON.stringify(inputSchema);
    for (const banned of ['ownerId', 'command', 'argv', 'token', 'password', 'cookie', 'path']) expect(text).not.toContain(`"${banned}"`);
  });
  it('the JSON Schema pins the constraints fields the CLI relies on', () => {
    const o = outline(inputSchema) as { properties: { constraints: { required: string[] } } };
    expect(o.properties.constraints.required).toEqual(['area', 'endDate', 'startDate', 'timeZone', 'transportMode']);
  });
  it('documents: JSON Schema cannot express the refinements (no duplicates in activityOrder, endDate >= startDate)', () => {
    // These stay enforced by the Zod schema and by BlueprintParser, so the CLI output must still be re-parsed.
    const text = JSON.stringify(outputSchema);
    expect(text).not.toContain('uniqueItems');
    expect(ok(PlanBlueprint, { schemaVersion: 1, candidates: [{ candidateId: 'c', activityOrder: ['a', 'a'], reasons: [], warnings: [] }] })).toBe(false);
  });
  it('the outline of both schemas is stable (a change here is a schema break: bump or review the contract)', () => {
    expect(outline(outputSchema)).toMatchInlineSnapshot(`
      {
        "additionalProperties": false,
        "properties": {
          "candidates": {
            "items": {
              "additionalProperties": false,
              "properties": {
                "activityOrder": {
                  "items": {
                    "type": "string",
                  },
                  "minItems": 1,
                  "type": "array",
                },
                "candidateId": {
                  "type": "string",
                },
                "excludedPlaceIds": {
                  "items": {
                    "type": "string",
                  },
                  "type": "array",
                },
                "reasons": {
                  "items": {
                    "type": "string",
                  },
                  "type": "array",
                },
                "title": {
                  "type": "string",
                },
                "warnings": {
                  "items": {
                    "type": "string",
                  },
                  "type": "array",
                },
              },
              "required": [
                "activityOrder",
                "candidateId",
                "reasons",
                "warnings",
              ],
              "type": "object",
            },
            "maxItems": 3,
            "minItems": 1,
            "type": "array",
          },
          "schemaVersion": {
            "const": 1,
          },
        },
        "required": [
          "candidates",
          "schemaVersion",
        ],
        "type": "object",
      }
    `);
    expect(Object.keys((outline(inputSchema) as { properties: object }).properties)).toMatchInlineSnapshot(`
      [
        "allowedPlaceIds",
        "constraints",
        "facts",
        "fixedActivities",
        "instructions",
        "schemaVersion",
      ]
    `);
  });
  it('the sample blueprint validates against its own JSON Schema constraints (round trip through JSON)', () => {
    expect(PlanBlueprint.parse(JSON.parse(JSON.stringify(samplePlanBlueprint)))).toEqual(samplePlanBlueprint);
  });
});

describe('PlanBlueprint output rejection (K03)', () => {
  const cand = (over: Record<string, unknown> = {}) => ({ candidateId: 'c1', title: 't', activityOrder: ['p1'], reasons: [], warnings: [], ...over });
  const bp = (candidates: unknown[], over: Record<string, unknown> = {}) => ({ schemaVersion: 1, candidates, ...over });
  it('accepts one to three candidates', () => {
    for (const n of [1, 2, 3]) expect(ok(PlanBlueprint, bp(Array.from({ length: n }, (_, i) => cand({ candidateId: `c${i}` }))))).toBe(true);
  });
  it('rejects zero and four candidates', () => {
    expect(ok(PlanBlueprint, bp([]))).toBe(false);
    expect(ok(PlanBlueprint, bp(Array.from({ length: 4 }, (_, i) => cand({ candidateId: `c${i}` }))))).toBe(false);
  });
  it('rejects an empty or duplicated activityOrder, and ids that are not valid Ids', () => {
    expect(ok(PlanBlueprint, bp([cand({ activityOrder: [] })]))).toBe(false);
    expect(ok(PlanBlueprint, bp([cand({ activityOrder: ['p1', 'p2', 'p1'] })]))).toBe(false);
    expect(ok(PlanBlueprint, bp([cand({ activityOrder: ['p 1'] })]))).toBe(false);
    expect(ok(PlanBlueprint, bp([cand({ activityOrder: [''] })]))).toBe(false);
    expect(ok(PlanBlueprint, bp([cand({ candidateId: '' })]))).toBe(false);
  });
  it('rejects missing reasons/warnings and non-string entries', () => {
    expect(ok(PlanBlueprint, bp([{ candidateId: 'c1', activityOrder: ['p1'], warnings: [] }]))).toBe(false);
    expect(ok(PlanBlueprint, bp([{ candidateId: 'c1', activityOrder: ['p1'], reasons: [] }]))).toBe(false);
    expect(ok(PlanBlueprint, bp([cand({ reasons: [1] })]))).toBe(false);
  });
  // Documented gaps, owned by BlueprintParser (packages/ai) and not by the schema:
  it('documents: unknown place ids and duplicate candidateIds are NOT schema errors (BlueprintParser checks them)', () => {
    expect(ok(PlanBlueprint, bp([cand({ activityOrder: ['not_in_allowed_ids'] })]))).toBe(true);
    expect(ok(PlanBlueprint, bp([cand(), cand()]))).toBe(true);
  });
  it('documents [FINDINGS C-6: 修正時は反転]: unknown keys on the blueprint are stripped (non-strict), the CLI JSON Schema closes the object instead', () => {
    const r = PlanBlueprint.parse(bp([cand({ extra: 1 })], { note: 'x' }));
    expect(r).not.toHaveProperty('note');
    expect(r.candidates[0]).not.toHaveProperty('extra');
  });
  it('rejects non-object output shapes', () => {
    for (const v of [null, [], 'text', 1, { schemaVersion: 1 }, { candidates: [cand()] }]) expect(ok(PlanBlueprint, v)).toBe(false);
  });
});

describe('every fixture trip survives a JSON round trip and loses a required field when broken', () => {
  it.each(fixtureTrips.map(t => [t.tripId, t] as const))('%s', (_id, trip) => {
    expect(Trip.parse(JSON.parse(JSON.stringify(trip)))).toEqual(trip);
    const broken = clone(trip) as unknown as { constraints: Record<string, unknown> };
    delete broken.constraints.timeZone;
    expect(ok(Trip, broken)).toBe(false);
  });
});
