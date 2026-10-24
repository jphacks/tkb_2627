import { describe, expect, it } from 'vitest';
import { convert, convertWithRate, type ExchangeRate } from './currency.ts';

const rate = (from: string, to: string, r: number, asOf = '2026-07-01T00:00:00Z'): ExchangeRate => ({ from, to, rate: r, asOf, source: 'fixture' });

describe('convertWithRate', () => {
  it('returns the rate that was used so the caller can show it with its time', () => {
    const older = rate('EUR', 'JPY', 150, '2026-06-01T00:00:00Z');
    const newer = rate('EUR', 'JPY', 160, '2026-07-01T00:00:00Z');
    expect(convertWithRate({ amountMinor: 1000, currency: 'EUR' }, 'JPY', [older, newer])).toEqual({
      money: { amountMinor: 1600, currency: 'JPY' },
      rate: newer,
    });
  });

  it('has a null rate for the same currency and null overall without a rate', () => {
    expect(convertWithRate({ amountMinor: 5, currency: 'JPY' }, 'JPY', [])).toEqual({ money: { amountMinor: 5, currency: 'JPY' }, rate: null });
    expect(convertWithRate({ amountMinor: 5, currency: 'JPY' }, 'EUR', [])).toBeNull();
  });

  it('returns null instead of an unsafe integer', () => {
    expect(convert({ amountMinor: Number.MAX_SAFE_INTEGER, currency: 'JPY' }, 'USD', [rate('JPY', 'USD', 1)])).toBeNull();
  });

  it('does not round up a genuinely smaller value near .5', () => {
    // 1 JPY at 0.004999999995 USD = 0.4999999995 cents: rounds to 0, not 1.
    expect(convert({ amountMinor: 1, currency: 'JPY' }, 'USD', [rate('JPY', 'USD', 0.004999999995)])).toEqual({ amountMinor: 0, currency: 'USD' });
    // Representation noise of an exact half still rounds away from zero: 1 EUR cent at 150 JPY = 1.5 yen -> 2.
    expect(convert({ amountMinor: 1, currency: 'EUR' }, 'JPY', [rate('EUR', 'JPY', 150)])).toEqual({ amountMinor: 2, currency: 'JPY' });
  });
});
