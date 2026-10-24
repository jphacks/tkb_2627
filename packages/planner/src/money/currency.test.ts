import { describe, expect, it } from 'vitest';
import type { Money } from '@tkb/contracts';
import { makeActivity, makeDay, makeLeg } from '../time/fixtures.ts';
import { convert, knownCostDelta, minorUnitDigits, sumByCurrency, summarizeTripCosts, type ExchangeRate } from './currency.ts';

const jpy = (amountMinor: number): Money => ({ amountMinor, currency: 'JPY' });
const eur = (amountMinor: number): Money => ({ amountMinor, currency: 'EUR' });

const eurJpy: ExchangeRate = { from: 'EUR', to: 'JPY', rate: 160, asOf: '2026-07-01T00:00:00Z', source: 'fixture' };

describe('minorUnitDigits', () => {
  it('JPY has none, EUR has two', () => {
    expect(minorUnitDigits('JPY')).toBe(0);
    expect(minorUnitDigits('EUR')).toBe(2);
    expect(minorUnitDigits('USD')).toBe(2);
  });
});

describe('sumByCurrency', () => {
  it('keeps JPY and EUR separate and sorted by code', () => {
    expect(sumByCurrency([jpy(1000), eur(550), jpy(500), eur(50)])).toEqual({
      totals: [eur(600), jpy(1500)],
      unknownCount: 0,
    });
  });

  it('counts null as unknown, never as 0', () => {
    const r = sumByCurrency([jpy(1000), null, null]);
    expect(r.unknownCount).toBe(2);
    expect(r.totals).toEqual([jpy(1000)]);
  });

  it('with only unknowns there is no total at all (not a 0 JPY total)', () => {
    expect(sumByCurrency([null])).toEqual({ totals: [], unknownCount: 1 });
    expect(sumByCurrency([])).toEqual({ totals: [], unknownCount: 0 });
  });

  it('keeps a known free item as a real 0', () => {
    expect(sumByCurrency([jpy(0)]).totals).toEqual([jpy(0)]);
  });
});

describe('summarizeTripCosts', () => {
  it('sums activity costs and leg fares and lists unknown item ids in order', () => {
    const days = [
      makeDay([
        makeActivity('museum', { cost: eur(1500) }),
        makeLeg('tgv', { fare: eur(4500) }),
        makeActivity('walk'),
      ]),
      makeDay([makeActivity('ramen', { cost: jpy(1200) }), makeLeg('metro')], 'Asia/Tokyo', '2026-07-02'),
    ];
    expect(summarizeTripCosts(days)).toEqual({
      totals: [eur(6000), jpy(1200)],
      unknownItemIds: ['walk', 'metro'],
    });
  });
});

describe('knownCostDelta', () => {
  it('is after minus before per currency, sorted, without merging currencies', () => {
    expect(knownCostDelta([jpy(1000), eur(500)], [jpy(1800), eur(300)])).toEqual([eur(-200), jpy(800)]);
  });

  it('treats a currency present on one side only as 0 on the other', () => {
    expect(knownCostDelta([jpy(1000)], [jpy(1000), eur(250)])).toEqual([eur(250)]);
    expect(knownCostDelta([eur(250)], [])).toEqual([eur(-250)]);
  });

  it('omits currencies whose delta is zero', () => {
    expect(knownCostDelta([jpy(1000)], [jpy(1000)])).toEqual([]);
  });
});

describe('convert', () => {
  it('converts EUR cents to JPY yen using the explicit rate (minor-unit difference)', () => {
    // 12.34 EUR * 160 = 1974.4 JPY -> 1974
    expect(convert(eur(1234), 'JPY', [eurJpy])).toEqual(jpy(1974));
    expect(convert(eur(100), 'JPY', [eurJpy])).toEqual(jpy(160));
  });

  it('converts JPY yen to EUR cents', () => {
    const rate: ExchangeRate = { from: 'JPY', to: 'EUR', rate: 0.00625, asOf: '2026-07-01T00:00:00Z', source: 'fixture' };
    expect(convert(jpy(1000), 'EUR', [rate])).toEqual(eur(625));
  });

  it('returns null when no rate is configured (never assumes 1.0)', () => {
    expect(convert(eur(1234), 'JPY', [])).toBeNull();
  });

  it('does not invert or chain rates', () => {
    const jpyEur: ExchangeRate = { from: 'JPY', to: 'EUR', rate: 0.00625, asOf: '2026-07-01T00:00:00Z', source: 'fixture' };
    expect(convert(eur(100), 'JPY', [jpyEur])).toBeNull();
    const eurUsd: ExchangeRate = { from: 'EUR', to: 'USD', rate: 1.1, asOf: '2026-07-01T00:00:00Z', source: 'fixture' };
    const usdJpy: ExchangeRate = { from: 'USD', to: 'JPY', rate: 150, asOf: '2026-07-01T00:00:00Z', source: 'fixture' };
    expect(convert(eur(100), 'JPY', [eurUsd, usdJpy])).toBeNull();
  });

  it('returns the same amount for the same currency without needing a rate', () => {
    expect(convert(jpy(500), 'JPY', [])).toEqual(jpy(500));
  });

  it('ignores invalid rates', () => {
    for (const rate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(convert(eur(100), 'JPY', [{ ...eurJpy, rate }])).toBeNull();
    }
  });

  it('uses the latest asOf when several rates match', () => {
    const older = { ...eurJpy, rate: 100, asOf: '2026-06-01T00:00:00Z' };
    const newer = { ...eurJpy, rate: 200, asOf: '2026-08-01T00:00:00Z' };
    expect(convert(eur(100), 'JPY', [newer, older])).toEqual(jpy(200));
    expect(convert(eur(100), 'JPY', [older, newer])).toEqual(jpy(200));
  });

  it('rounds half away from zero, including negatives (deltas)', () => {
    const one = { ...eurJpy, rate: 1 }; // EUR cents / 100 = yen
    expect(convert(eur(300), 'JPY', [one])).toEqual(jpy(3));
    expect(convert(eur(250), 'JPY', [one])).toEqual(jpy(3)); // 2.5 -> 3
    expect(convert(eur(-250), 'JPY', [one])).toEqual(jpy(-3)); // -2.5 -> -3
    expect(convert(eur(249), 'JPY', [one])).toEqual(jpy(2)); // 2.49 -> 2
  });

  it('does not lose a .5 to binary float noise', () => {
    // 1005 JPY * 0.01 EUR/JPY = 10.05 EUR = 1005 cents.
    const rate: ExchangeRate = { from: 'JPY', to: 'EUR', rate: 0.01, asOf: '2026-07-01T00:00:00Z', source: 'fixture' };
    expect(convert(jpy(1005), 'EUR', [rate])).toEqual(eur(1005));
    // 5 JPY * 0.001 * 100 = 0.5 cents -> rounds away from zero to 1.
    expect(convert(jpy(5), 'EUR', [{ ...rate, rate: 0.001 }])).toEqual(eur(1));
  });
});
