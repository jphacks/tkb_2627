import type { TripDay, TripDiff } from '@tkb/contracts';
import { tripElapsedSeconds } from '../time/trip.ts';
import { knownCostDelta, summarizeTripCosts } from './currency.ts';

/**
 * R11: before/after difference. Duration delta is null when either side is unknown. Cost delta covers known costs only;
 * `unknownCostItems` lists items of `after` with no cost (never treated as 0). An item that had a cost before and is
 * unknown after therefore shows as a lower known total plus an unknown item, not as a saving.
 */
export function tripDiff(before: readonly TripDay[], after: readonly TripDay[]): TripDiff {
  const b = tripElapsedSeconds(before);
  const a = tripElapsedSeconds(after);
  const costsBefore = summarizeTripCosts(before);
  const costsAfter = summarizeTripCosts(after);
  return {
    durationDeltaSeconds: a === null || b === null ? null : a - b,
    knownCostDelta: knownCostDelta(costsBefore.totals, costsAfter.totals),
    unknownCostItems: costsAfter.unknownItemIds,
  };
}
