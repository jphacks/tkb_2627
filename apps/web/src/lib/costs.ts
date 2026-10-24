import type { Money, Trip } from '@tkb/contracts';

export interface CostSummary {
  /** Known costs summed per currency (minor units). Currencies are never merged (R11). */
  totals: Money[];
  /** Number of items whose cost/fare is null (not obtained). Never counted as 0. */
  unknownCount: number;
}

/** Sums activity costs and leg fares per currency; counts items with null cost/fare as unknown. */
export function summarizeCosts(days: Trip['days']): CostSummary {
  const byCurrency = new Map<string, number>();
  let unknownCount = 0;
  for (const day of days) {
    for (const item of day.items) {
      const money = item.type === 'activity' ? item.cost : item.fare;
      if (money === null) {
        unknownCount += 1;
        continue;
      }
      byCurrency.set(money.currency, (byCurrency.get(money.currency) ?? 0) + money.amountMinor);
    }
  }
  const totals = [...byCurrency.entries()]
    .map(([currency, amountMinor]) => ({ currency, amountMinor }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
  return { totals, unknownCount };
}
