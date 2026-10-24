import { describe, expect, it } from 'vitest';
import { GenerateRequest } from '@tkb/contracts';
import { createMockApi } from '../mocks/index.ts';
import { emptyForm, isRealDate, parseBudget, sampleForm, splitMustVisit, validateCondition } from './condition.ts';
import { flowReducer, initialFlow } from './flow.ts';
import { localDateIn, pickGuideTarget } from './guide.ts';

describe('condition form (R01)', () => {
  it('flags every required field when empty, including the time zone (nothing is confirmed silently)', () => {
    const r = validateCondition(emptyForm);
    expect(r.request).toBeNull();
    expect(r.missing).toEqual(['area', 'startDate', 'endDate', 'timeZone', 'transportMode']);
    expect(Object.keys(r.errors).sort()).toEqual(['area', 'endDate', 'startDate', 'timeZone', 'transportMode']);
    expect(emptyForm.timeZone).toBe('');
    // Only the budget has a visible default, and it is the explicit "unknown".
    expect(emptyForm.budgetMode).toBe('unknown');
  });

  it('builds a GenerateRequest that passes the contract; budget unknown is null, never 0', () => {
    const r = validateCondition(sampleForm);
    expect(r.errors).toEqual({});
    expect(r.request).not.toBeNull();
    expect(GenerateRequest.safeParse(r.request).success).toBe(true);
    expect(r.request?.mode).toBe('generate');
    expect(r.request?.constraints.budget).toBeNull();
    expect(Object.keys(r.request?.constraints ?? {}).sort()).toEqual(['area', 'budget', 'endDate', 'startDate', 'timeZone', 'transportMode']);
  });

  it('converts a typed budget to minor units per currency', () => {
    expect(parseBudget('30000', 'JPY')).toEqual({ amountMinor: 30000, currency: 'JPY' });
    expect(parseBudget('12.5', 'EUR')).toEqual({ amountMinor: 1250, currency: 'EUR' });
    expect(parseBudget('12.5', 'JPY')).toBeNull();
    expect(parseBudget('-1', 'JPY')).toBeNull();
    expect(parseBudget('', 'JPY')).toBeNull();
    const r = validateCondition({ ...sampleForm, budgetMode: 'amount', budgetAmount: '30000' });
    expect(r.request?.constraints.budget).toEqual({ amountMinor: 30000, currency: 'JPY' });
  });

  it('requires an amount when a budget amount is chosen', () => {
    const r = validateCondition({ ...sampleForm, budgetMode: 'amount', budgetAmount: '' });
    expect(r.request).toBeNull();
    expect(r.errors.budget).toBeTruthy();
  });

  it('puts impossible calendar dates on the date fields, not on 地域', () => {
    const start = validateCondition({ ...sampleForm, startDate: '2026-02-30', endDate: '2026-03-02' });
    expect(start.request).toBeNull();
    expect(start.errors.startDate).toBeTruthy();
    expect(start.errors.area).toBeUndefined();
    const end = validateCondition({ ...sampleForm, endDate: '2026-13-01' });
    expect(end.request).toBeNull();
    expect(end.errors.endDate).toBeTruthy();
    expect(end.errors.area).toBeUndefined();
    expect(isRealDate('2028-02-29')).toBe(true);
    expect(isRealDate('2026-02-29')).toBe(false);
    expect(isRealDate('2026-2-3')).toBe(false);
    expect(isRealDate('')).toBe(false);
  });

  it('rejects an end date before the start date and non-IANA zones', () => {
    expect(validateCondition({ ...sampleForm, endDate: '2026-10-31' }).errors.endDate).toBeTruthy();
    expect(validateCondition({ ...sampleForm, timeZone: '+09:00' }).errors.timeZone).toBeTruthy();
    expect(validateCondition({ ...sampleForm, timeZone: 'Europe/Paris' }).request?.constraints.timeZone).toBe('Europe/Paris');
  });

  it('sends every typed 必須地点 as a stated preference and never as mustVisit', () => {
    expect(splitMustVisit('兼六園\nplace_kenroku, 兼六園\n\n')).toEqual(['兼六園', 'place_kenroku']);
    // Id-looking text ("Louvre", "Tokyo-Tower") is not a verified placeId either.
    const r = validateCondition({ ...sampleForm, mustVisit: '兼六園\nLouvre\nTokyo-Tower' });
    expect(r.request?.constraints.mustVisit).toBeUndefined();
    expect(r.request?.constraints.preferences).toEqual([
      '必須地点（名称・地点ID未解決）: 兼六園',
      '必須地点（名称・地点ID未解決）: Louvre',
      '必須地点（名称・地点ID未解決）: Tokyo-Tower',
    ]);
    expect(validateCondition(sampleForm).request?.constraints.preferences).toBeUndefined();
  });

  it('reports an error instead of truncating when preferences exceed the contract limits', () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => `地点${i}`).join('\n');
    const many = validateCondition({ ...sampleForm, mustVisit: tooMany });
    expect(many.request).toBeNull();
    expect(many.errors.mustVisit).toContain('20件まで');
    const exactly20 = validateCondition({ ...sampleForm, mustVisit: tooMany.split('\n').slice(0, 20).join('\n') });
    expect(exactly20.request?.constraints.preferences).toHaveLength(20);

    const long = validateCondition({ ...sampleForm, mustVisit: 'あ'.repeat(200) });
    expect(long.request).toBeNull();
    expect(long.errors.mustVisit).toContain('長すぎます');
    const fits = validateCondition({ ...sampleForm, mustVisit: 'あ'.repeat(182) });
    expect(fits.request?.constraints.preferences?.[0]?.length).toBe(200);
  });

  it('the mock accepts the built request (K01 202) and the flow moves to progress', async () => {
    const api = createMockApi();
    const { request } = validateCondition(sampleForm);
    if (!request) throw new Error('sample form must be valid');
    const r = await api.generate(request);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe(202);
    expect(r.source).toBe('mock');
    const s = [
      { type: 'selectTab', tab: 'new' },
      { type: 'generationStarted', jobId: r.data.jobId, pollAfterMs: r.data.pollAfterMs },
    ] as const;
    expect(s.reduce(flowReducer, initialFlow).screen.name).toBe('progress');
  });
});

describe('guide target', () => {
  it('picks today, else the next day, else the last day', async () => {
    const api = createMockApi();
    const list = await api.listTrips();
    if (!list.ok) throw new Error('list');
    const id = list.data.items.find(t => t.startDate === '2026-11-01')?.tripId;
    if (!id) throw new Error('fixture trip');
    const t = await api.getTrip(id);
    if (!t.ok) throw new Error('trip');
    const trip = t.data;

    const day1 = pickGuideTarget(trip, new Date('2026-11-01T01:00:00Z'));
    expect(day1.reason).toBe('today');
    expect(day1.day?.date).toBe('2026-11-01');
    expect(day1.next?.status).toBe('planned');

    expect(pickGuideTarget(trip, new Date('2026-10-01T00:00:00Z')).reason).toBe('upcoming');
    expect(pickGuideTarget(trip, new Date('2027-01-01T00:00:00Z')).reason).toBe('past');
    expect(pickGuideTarget({ ...trip, days: [] }, new Date()).reason).toBe('none');
  });

  it('computes the local date in the given zone', () => {
    expect(localDateIn(new Date('2026-11-01T16:00:00Z'), 'Asia/Tokyo')).toBe('2026-11-02');
    expect(localDateIn(new Date('2026-11-01T16:00:00Z'), 'UTC')).toBe('2026-11-01');
  });
});
