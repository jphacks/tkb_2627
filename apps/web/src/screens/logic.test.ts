import { describe, expect, it } from 'vitest';
import { GenerateRequest } from '@tkb/contracts';
import { createMockApi } from '../mocks/index.ts';
import { emptyForm, parseBudget, sampleForm, splitMustVisit, validateCondition } from './condition.ts';
import { flowReducer, initialFlow } from './flow.ts';
import { localDateIn, pickGuideTarget } from './guide.ts';

describe('condition form (R01)', () => {
  it('flags every required field when empty, but defaults the time zone and budget to explicit values', () => {
    const r = validateCondition(emptyForm);
    expect(r.request).toBeNull();
    expect(r.missing).toEqual(['area', 'startDate', 'endDate', 'transportMode']);
    expect(Object.keys(r.errors).sort()).toEqual(['area', 'endDate', 'startDate', 'transportMode']);
    expect(emptyForm.timeZone).toBe('Asia/Tokyo');
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

  it('rejects an end date before the start date and non-IANA zones', () => {
    expect(validateCondition({ ...sampleForm, endDate: '2026-10-31' }).errors.endDate).toBeTruthy();
    expect(validateCondition({ ...sampleForm, timeZone: '+09:00' }).errors.timeZone).toBeTruthy();
    expect(validateCondition({ ...sampleForm, timeZone: 'Europe/Paris' }).request?.constraints.timeZone).toBe('Europe/Paris');
  });

  it('sends place IDs as mustVisit and names as stated preferences, without inventing fields', () => {
    expect(splitMustVisit('兼六園\nplace_kenroku, 兼六園\n\n')).toEqual(['兼六園', 'place_kenroku']);
    const r = validateCondition({ ...sampleForm, mustVisit: '兼六園\nplace_kenroku' });
    expect(r.request?.constraints.mustVisit).toEqual(['place_kenroku']);
    expect(r.request?.constraints.preferences).toEqual(['必須地点（名称・地点ID未解決）: 兼六園']);
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
