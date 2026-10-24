import type { Money } from '@tkb/contracts';
import { formatMoney } from '../lib/format.ts';
import { UNKNOWN_LABEL } from './labels.ts';

/** Money in minor units. null is shown as 不明, never as 0 (R11). */
export function MoneyText({ money }: { money: Money | null }) {
  if (money === null) return <span className="u1-unknown">{UNKNOWN_LABEL}</span>;
  return <span>{formatMoney(money)}</span>;
}

/** A signed difference (knownCostDelta entries are plain Money and may be negative). */
export function MoneyDeltaText({ money }: { money: Money }) {
  const sign = money.amountMinor > 0 ? '+' : '';
  return <span>{sign}{formatMoney(money)}</span>;
}

/** Known total per currency; an empty list means nothing is known, which is 不明 (not 0). */
export function MoneyTotals({ totals }: { totals: Money[] }) {
  if (totals.length === 0) return <span className="u1-unknown">{UNKNOWN_LABEL}</span>;
  return (
    <span>
      {totals.map((m, i) => (
        <span key={m.currency}>
          {i > 0 ? ' / ' : ''}
          <MoneyText money={m} />
        </span>
      ))}
    </span>
  );
}
