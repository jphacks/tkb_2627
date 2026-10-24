// R11: 未知費用は0にしない。通貨は混ぜない。換算は明示レートのみ。金額・レートはすべて架空。
import { convert, convertWithRate, knownCostDelta, sumByCurrency, summarizeTripCosts, tripDiff, type ExchangeRate } from '@tkb/planner';
import { describe, expect, it } from 'vitest';
import { act, day, leg } from './helpers.ts';

const JPY = (n: number) => ({ amountMinor: n, currency: 'JPY' });
const EUR = (n: number) => ({ amountMinor: n, currency: 'EUR' });
const rate = (over: Partial<ExchangeRate> = {}): ExchangeRate => ({ from: 'EUR', to: 'JPY', rate: 150, asOf: '2026-07-01T00:00:00Z', ...over }) as ExchangeRate;

describe('totals (架空フィクスチャ)', () => {
  it('sums per currency, keeps currencies separate, and counts unknowns instead of adding 0', () => {
    const r = sumByCurrency([JPY(500), EUR(1200), null, JPY(300)]);
    expect(r.totals).toEqual([EUR(1200), JPY(800)]);
    expect(r.unknownCount).toBe(1);
  });

  it('all-unknown gives no totals, not a 0 total', () => {
    const r = sumByCurrency([null, null]);
    expect(r.totals).toEqual([]);
    expect(r.unknownCount).toBe(2);
  });

  it('summarizeTripCosts lists unknown item ids across days, legs included', () => {
    const days = [day([act('a', { cost: EUR(1000) }), leg('l1', { fare: JPY(200) })]), day([act('b'), leg('l2')], '2026-07-02')];
    expect(summarizeTripCosts(days)).toEqual({ totals: [EUR(1000), JPY(200)], unknownItemIds: ['b', 'l2'] });
  });
});

describe('tripDiff / knownCostDelta (架空フィクスチャ)', () => {
  const t = (cost: ReturnType<typeof JPY> | null) => [day([act('x', { start: '2026-07-01T01:00:00Z', end: '2026-07-01T02:00:00Z', cost })])];

  it('unknown to known is not a new expense, known to unknown is not a saving', () => {
    for (const d of [tripDiff(t(null), t(JPY(900))), tripDiff(t(JPY(900)), t(null))]) {
      expect(d.knownCostDelta).toEqual([]);
      expect(d.unknownCostItems).toEqual(['x']);
    }
  });

  it('per-currency delta is never merged across currencies', () => {
    expect(knownCostDelta([JPY(1000), EUR(500)], [JPY(1500), EUR(500), EUR(100)])).toEqual([EUR(100), JPY(500)]);
  });

  it('a zero delta is omitted (no known change), while the unknown item stays listed', () => {
    const before = [day([act('x', { cost: JPY(100) }), act('y')])];
    const d = tripDiff(before, before);
    expect(d.knownCostDelta).toEqual([]);
    expect(d.unknownCostItems).toEqual(['y']);
  });

  it('duration delta is null when either side has an unknown time', () => {
    expect(tripDiff(t(null), [day([act('x')])]).durationDeltaSeconds).toBeNull();
  });

  it('an item moved to another day keeps matching by id', () => {
    const before = [day([act('x', { cost: JPY(100), start: '2026-07-01T01:00:00Z', end: '2026-07-01T02:00:00Z' })])];
    const after = [day([], '2026-07-01'), day([act('x', { cost: JPY(100), start: '2026-07-02T01:00:00Z', end: '2026-07-02T02:00:00Z' })], '2026-07-02')];
    expect(tripDiff(before, after).knownCostDelta).toEqual([]);
  });
});

describe('conversion needs an explicit rate (架空レート)', () => {
  it('returns null with no rate, never assuming 1.0', () => {
    expect(convert(EUR(1000), 'JPY', [])).toBeNull();
  });

  it('does not invert or chain rates', () => {
    expect(convert(JPY(15000), 'EUR', [rate()])).toBeNull();
    expect(convert(EUR(100), 'USD', [rate(), rate({ from: 'JPY', to: 'USD', rate: 0.007 })])).toBeNull();
  });

  it('converts with minor-unit difference (EUR cents to JPY yen) and reports the rate used', () => {
    const c = convertWithRate(EUR(1000), 'JPY', [rate()]);
    expect(c?.money).toEqual(JPY(1500));
    expect(c?.rate).toMatchObject({ rate: 150 });
  });

  it('latest asOf wins and invalid rates are ignored', () => {
    const rates = [rate({ rate: 140, asOf: '2026-06-01T00:00:00Z' }), rate({ rate: 160 }), rate({ rate: 0, asOf: '2026-08-01T00:00:00Z' }), rate({ rate: Number.NaN, asOf: '2026-08-01T00:00:00Z' })];
    expect(convert(EUR(100), 'JPY', rates)).toEqual(JPY(160));
  });

  it('same currency passes through without a rate', () => {
    expect(convertWithRate(JPY(300), 'JPY', [])).toEqual({ money: JPY(300), rate: null });
  });
});
