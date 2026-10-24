import type { Money, TripDay, UtcInstant } from '@tkb/contracts';
import { parseUtc } from '../time/zone.ts';

/** Exchange rate: 1 major unit of `from` equals `rate` major units of `to`. Never inverted or chained implicitly. */
export interface ExchangeRate {
  from: string;
  to: string;
  rate: number;
  asOf: UtcInstant;
  source: string;
}

/** Known totals per currency plus how many values were unknown (null). */
export interface CurrencyTotals {
  totals: Money[];
  unknownCount: number;
}

/** Number of minor-unit digits of a currency (JPY 0, EUR 2), taken from Intl. */
export function minorUnitDigits(currency: string): number {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

function toSortedTotals(byCurrency: Map<string, number>): Money[] {
  return [...byCurrency.entries()]
    .map(([currency, amountMinor]) => ({ currency, amountMinor }))
    .sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0));
}

/** Sums per currency (sorted by code, never merged); null values are counted as unknown, not 0. */
export function sumByCurrency(values: readonly (Money | null)[]): CurrencyTotals {
  const byCurrency = new Map<string, number>();
  let unknownCount = 0;
  for (const money of values) {
    if (money === null) {
      unknownCount += 1;
      continue;
    }
    byCurrency.set(money.currency, (byCurrency.get(money.currency) ?? 0) + money.amountMinor);
  }
  return { totals: toSortedTotals(byCurrency), unknownCount };
}

/** Sums activity costs and leg fares per currency; ids (activityId / legId) of items with null cost are listed in order. */
export function summarizeTripCosts(days: readonly TripDay[]): { totals: Money[]; unknownItemIds: string[] } {
  const known: Money[] = [];
  const unknownItemIds: string[] = [];
  for (const day of days) {
    for (const item of day.items) {
      const money = item.type === 'activity' ? item.cost : item.fare;
      if (money === null) unknownItemIds.push(item.type === 'activity' ? item.activityId : item.legId);
      else known.push(money);
    }
  }
  return { totals: sumByCurrency(known).totals, unknownItemIds };
}

/**
 * Per-currency `after - before`, sorted by currency code. A currency missing on one side counts as 0 on that side
 * (a known total of nothing, not an unknown cost). Currencies whose delta is exactly 0 are omitted.
 */
export function knownCostDelta(before: readonly Money[], after: readonly Money[]): Money[] {
  const delta = new Map<string, number>();
  for (const m of before) delta.set(m.currency, (delta.get(m.currency) ?? 0) - m.amountMinor);
  for (const m of after) delta.set(m.currency, (delta.get(m.currency) ?? 0) + m.amountMinor);
  return toSortedTotals(delta).filter(m => m.amountMinor !== 0);
}

/**
 * Rounds half away from zero, tolerating binary float noise just below .5 (e.g. 2.4999999999999996 -> 3).
 * Exact integers keep every digit, and zero is always +0.
 */
function roundHalfAwayFromZero(value: number): number {
  const abs = Math.abs(value);
  const floor = Math.floor(abs);
  // Tolerance relative to the magnitude: only representation noise, not genuinely smaller values, rounds up.
  const rounded = abs - floor >= 0.5 - abs * Number.EPSILON * 8 ? floor + 1 : floor;
  return rounded === 0 ? 0 : Math.sign(value) * rounded;
}

/** A converted amount together with the rate used, so callers can show the rate and its time (docs/01_SPEC.md). */
export interface Conversion {
  money: Money;
  /** null when no conversion was needed (same currency). */
  rate: ExchangeRate | null;
}

/**
 * Converts with an explicit `from -> to` rate only and returns the rate used; null when none matches (never assumes
 * 1.0, never inverts or chains through a third currency) or when the result is not a safe integer. Same currency
 * returns the amount unchanged. With several matching rates the latest `asOf` wins (first listed on ties). Rates that
 * are not finite and positive are ignored; a matching rate with a malformed `asOf` throws RangeError.
 * Handles minor-unit differences, e.g. EUR cents to JPY yen, and rounds half away from zero.
 */
export function convertWithRate(money: Money, target: string, rates: readonly ExchangeRate[]): Conversion | null {
  if (money.currency === target) return { money: { amountMinor: money.amountMinor || 0, currency: target }, rate: null };
  let best: ExchangeRate | null = null;
  for (const r of rates) {
    if (r.from !== money.currency || r.to !== target) continue;
    if (!Number.isFinite(r.rate) || r.rate <= 0) continue;
    const asOf = parseUtc(r.asOf);
    if (best === null || asOf > parseUtc(best.asOf)) best = r;
  }
  if (best === null) return null;
  const scale = 10 ** (minorUnitDigits(target) - minorUnitDigits(money.currency));
  const amountMinor = roundHalfAwayFromZero(money.amountMinor * best.rate * scale);
  if (!Number.isSafeInteger(amountMinor)) return null;
  return { money: { amountMinor, currency: target }, rate: { ...best } };
}

/** `convertWithRate` without the rate. Prefer `convertWithRate` when the converted amount is shown to people. */
export function convert(money: Money, target: string, rates: readonly ExchangeRate[]): Money | null {
  return convertWithRate(money, target, rates)?.money ?? null;
}
