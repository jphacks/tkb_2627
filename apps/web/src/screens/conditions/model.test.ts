import { describe, expect, it } from 'vitest';
import { GenerateRequest } from '@tkb/contracts';
import { kanazawaPlaces, parisPlaces } from '@tkb/fixtures';
import { sampleForm } from '../condition.ts';
import {
  FREE_WALK_PREFERENCE,
  MAX_MUST_VISIT,
  MEAL_PREFERENCE,
  addMustVisit,
  buildConditionsRequest,
  effectiveModeByDate,
  emptyConditions,
  formatBudgetPreview,
  formatLocalDate,
  newIdempotencyKey,
  removeMustVisit,
  sampleConditions,
  setModeForDate,
  todayIn,
  tripDates,
  type ConditionsForm,
} from './model.ts';

const NOW = new Date('2026-10-25T03:00:00Z');
const withBase = (patch: Partial<ConditionsForm['base']>, rest: Partial<ConditionsForm> = {}): ConditionsForm => ({
  ...sampleConditions,
  ...rest,
  base: { ...sampleForm, ...patch },
});
const kenrokuen = kanazawaPlaces.find(p => p.placeId === 'fx_kenrokuen')!;
const sushi = kanazawaPlaces.find(p => p.placeId === 'fx_sushi')!;

describe('U03 validation', () => {
  it('lists every missing required field and builds no request', () => {
    const r = buildConditionsRequest(emptyConditions, NOW);
    expect(r.request).toBeNull();
    expect(r.missing).toEqual(['area', 'startDate', 'endDate', 'timeZone', 'transportMode']);
    expect(Object.keys(r.errors)).toEqual(expect.arrayContaining(['area', 'startDate', 'endDate', 'timeZone', 'transportMode']));
  });

  it('rejects an end date before the start date', () => {
    const r = buildConditionsRequest(withBase({ startDate: '2026-11-03', endDate: '2026-11-01' }), NOW);
    expect(r.request).toBeNull();
    expect(r.errors.endDate).toMatch(/開始日以降/);
  });

  it('rejects a fixed offset or unknown zone', () => {
    for (const tz of ['+09:00', 'Mars/Base', 'JST']) {
      const r = buildConditionsRequest(withBase({ timeZone: tz }), NOW);
      expect(r.request, tz).toBeNull();
      expect(r.errors.timeZone, tz).toBeDefined();
    }
  });

  it('rejects impossible calendar dates', () => {
    expect(buildConditionsRequest(withBase({ startDate: '2026-02-30', endDate: '2026-03-01' }), NOW).errors.startDate).toBeDefined();
  });

  it('builds the minimal K01 body for the sample', () => {
    const r = buildConditionsRequest(sampleConditions, NOW);
    expect(r.errors).toEqual({});
    expect(r.request).toEqual({
      mode: 'generate',
      constraints: { area: '金沢', startDate: '2026-11-01', endDate: '2026-11-02', timeZone: 'Asia/Tokyo', transportMode: 'transit', budget: null },
    });
  });
});

describe('U03 local dates (trip time zone)', () => {
  it('enumerates local dates across a month end and DST change without device-zone shifts', () => {
    expect(tripDates('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
    expect(tripDates('2026-10-24', '2026-10-26')).toEqual(['2026-10-24', '2026-10-25', '2026-10-26']);
    expect(tripDates('2026-11-02', '2026-11-01')).toEqual([]);
    expect(tripDates('2026-01-01', '2026-12-31')).toEqual([]);
  });

  it('formats the weekday of a calendar date', () => {
    expect(formatLocalDate('2026-11-01')).toBe('11/1(日)');
  });

  it('computes today in the trip zone, not the device zone', () => {
    const instant = new Date('2026-10-25T20:00:00Z');
    expect(todayIn('Asia/Tokyo', instant)).toBe('2026-10-26');
    expect(todayIn('America/Los_Angeles', instant)).toBe('2026-10-25');
    expect(todayIn('Not/AZone', instant)).toBeNull();
  });

  it('warns (without blocking) when the start date is before the local today', () => {
    const r = buildConditionsRequest(withBase({ startDate: '2026-10-24', endDate: '2026-10-26' }), NOW);
    expect(r.request).not.toBeNull();
    expect(r.warnings.join()).toMatch(/現地（Asia\/Tokyo）の今日 2026-10-25/);
  });
});

describe('U03 budget currency', () => {
  it('sends one Money in the chosen currency with its own minor unit', () => {
    const usd = buildConditionsRequest(withBase({ budgetMode: 'amount', budgetAmount: '120.50', budgetCurrency: 'USD' }), NOW);
    expect(usd.request?.constraints.budget).toEqual({ amountMinor: 12050, currency: 'USD' });
    const jpy = buildConditionsRequest(withBase({ budgetMode: 'amount', budgetAmount: '30000', budgetCurrency: 'JPY' }), NOW);
    expect(jpy.request?.constraints.budget).toEqual({ amountMinor: 30000, currency: 'JPY' });
    const krw = buildConditionsRequest(withBase({ budgetMode: 'amount', budgetAmount: '50000', budgetCurrency: 'KRW' }), NOW);
    expect(krw.request?.constraints.budget).toEqual({ amountMinor: 50000, currency: 'KRW' });
  });

  it('rejects decimals beyond the currency minor unit (JPY has none)', () => {
    const r = buildConditionsRequest(withBase({ budgetMode: 'amount', budgetAmount: '100.5', budgetCurrency: 'JPY' }), NOW);
    expect(r.request).toBeNull();
    expect(r.errors.budget).toBeDefined();
  });

  it('keeps unknown budget as null, never 0, and requires an amount when chosen', () => {
    expect(buildConditionsRequest(sampleConditions, NOW).request?.constraints.budget).toBeNull();
    expect(buildConditionsRequest(withBase({ budgetMode: 'amount', budgetAmount: '' }), NOW).errors.budget).toBeDefined();
  });

  it('previews the amount in its own currency only', () => {
    expect(formatBudgetPreview('120.5', 'EUR')).toMatch(/120[.,]50/);
    expect(formatBudgetPreview('120.5', 'EUR')).toMatch(/€/);
    expect(formatBudgetPreview('abc', 'EUR')).toBeNull();
  });
});

describe('U03 transport per day', () => {
  const threeDays = withBase({ startDate: '2026-11-01', endDate: '2026-11-03', transportMode: 'transit' });

  it('sends only overrides inside the trip that differ from the default', () => {
    let f = setModeForDate(threeDays, '2026-11-02', 'car');
    f = { ...f, modeByDate: { ...f.modeByDate, '2026-12-01': 'car' } };
    expect(effectiveModeByDate(f)).toEqual({ '2026-11-02': 'car' });
    const r = buildConditionsRequest(f, NOW);
    expect(r.request?.constraints.transportModeByDate).toEqual({ '2026-11-02': 'car' });
    expect(r.request?.constraints.transportMode).toBe('transit');
    expect(r.warnings.join()).toMatch(/2026-12-01/);
  });

  it('removes the override when set back to the default', () => {
    const f = setModeForDate(setModeForDate(threeDays, '2026-11-02', 'car'), '2026-11-02', 'default');
    expect(f.modeByDate).toEqual({});
    expect(buildConditionsRequest(f, NOW).request?.constraints).not.toHaveProperty('transportModeByDate');
  });

  it('drops an override that equals a later-changed default', () => {
    const f = setModeForDate(threeDays, '2026-11-02', 'car');
    const switched = { ...f, base: { ...f.base, transportMode: 'car' as const } };
    expect(buildConditionsRequest(switched, NOW).request?.constraints).not.toHaveProperty('transportModeByDate');
  });

  it('requires a default mode before per-day overrides', () => {
    const f = { ...threeDays, base: { ...threeDays.base, transportMode: '' as const }, modeByDate: { '2026-11-02': 'car' as const } };
    expect(buildConditionsRequest(f, NOW).errors.modeByDate).toBeDefined();
  });
});

describe('U03 must-visit selection', () => {
  it('adds without duplicates and removes by place id', () => {
    let f = addMustVisit(sampleConditions, kenrokuen);
    f = addMustVisit(f, kenrokuen);
    f = addMustVisit(f, sushi);
    expect(f.selected.map(p => p.placeId)).toEqual(['fx_kenrokuen', 'fx_sushi']);
    expect(buildConditionsRequest(f, NOW).request?.constraints.mustVisit).toEqual(['fx_kenrokuen', 'fx_sushi']);
    f = removeMustVisit(f, 'fx_kenrokuen');
    expect(f.selected.map(p => p.placeId)).toEqual(['fx_sushi']);
    expect(removeMustVisit(f, 'nope')).toBe(f);
    f = removeMustVisit(f, 'fx_sushi');
    expect(buildConditionsRequest(f, NOW).request?.constraints).not.toHaveProperty('mustVisit');
  });

  it(`caps the selection at ${MAX_MUST_VISIT}`, () => {
    let f = sampleConditions;
    for (let i = 0; i < MAX_MUST_VISIT + 3; i++) f = addMustVisit(f, { ...kenrokuen, placeId: `p_${i}` });
    expect(f.selected).toHaveLength(MAX_MUST_VISIT);
  });

  it('warns when a selected place is in another time zone', () => {
    const r = buildConditionsRequest(addMustVisit(sampleConditions, parisPlaces[0]!), NOW);
    expect(r.warnings.join()).toMatch(/Europe\/Paris/);
  });

  it('keeps unresolved typed places as preferences and adds R13 wishes', () => {
    const f = withBase({ mustVisit: '主計町' }, { meal: true, freeWalk: true });
    expect(buildConditionsRequest(f, NOW).request?.constraints.preferences).toEqual([
      '必須地点（名称・地点ID未解決）: 主計町',
      MEAL_PREFERENCE,
      FREE_WALK_PREFERENCE,
    ]);
  });

  it('rejects more than 20 preferences in total', () => {
    const many = Array.from({ length: 19 }, (_, i) => `地点${i}`).join('\n');
    const r = buildConditionsRequest(withBase({ mustVisit: many }, { meal: true, freeWalk: true }), NOW);
    expect(r.request).toBeNull();
    expect(r.errors.preferences).toMatch(/20件/);
  });
});

describe('U03 request body is exactly K01', () => {
  it('parses strictly and round-trips unchanged with every optional field', () => {
    let f = withBase(
      { startDate: '2026-11-01', endDate: '2026-11-02', budgetMode: 'amount', budgetAmount: '200', budgetCurrency: 'EUR', mustVisit: 'X' },
      { meal: true, departureLabel: '金沢駅 9時', returnLabel: '金沢駅 18時' },
    );
    f = addMustVisit(setModeForDate(f, '2026-11-02', 'car'), kenrokuen);
    const r = buildConditionsRequest(f, NOW);
    expect(r.request).not.toBeNull();
    const strict = GenerateRequest.parse(r.request);
    expect(strict).toEqual(r.request);
    expect(Object.keys(r.request!).sort()).toEqual(['constraints', 'mode']);
    expect(Object.keys(r.request!.constraints).sort()).toEqual(
      ['area', 'budget', 'departure', 'endDate', 'mustVisit', 'preferences', 'return', 'startDate', 'timeZone', 'transportMode', 'transportModeByDate'].sort(),
    );
    expect(r.request!.constraints.departure).toEqual({ placeId: null, label: '金沢駅 9時', time: null });
    // ownerId or any unknown key is refused by the contract.
    expect(GenerateRequest.safeParse({ ...r.request, ownerId: 'u' }).success).toBe(false);
  });

  it('rejects over-long departure labels', () => {
    expect(buildConditionsRequest({ ...sampleConditions, departureLabel: 'あ'.repeat(201) }, NOW).errors.departure).toBeDefined();
  });

  it('makes valid Idempotency-Keys', () => {
    expect(newIdempotencyKey(() => '1234-abcd-!!')).toBe('u03_1234-abcd-');
    expect(newIdempotencyKey()).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  });
});
