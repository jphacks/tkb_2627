import type { Money, TripDay, TripDiff } from '@tkb/contracts';
import { tripElapsedSeconds } from '../time/trip.ts';
import { knownCostDelta } from './currency.ts';

/** Costs of each item id (activityId / legId) in plan order; an id listed twice keeps every cost. */
function costsById(days: readonly TripDay[]): Map<string, (Money | null)[]> {
  const byId = new Map<string, (Money | null)[]>();
  for (const day of days) {
    for (const item of day.items) {
      const id = item.type === 'activity' ? item.activityId : item.legId;
      const cost = item.type === 'activity' ? item.cost : item.fare;
      const list = byId.get(id);
      if (list) list.push(cost);
      else byId.set(id, [cost]);
    }
  }
  return byId;
}

const isKnown = (costs: readonly (Money | null)[]): costs is Money[] => costs.every(c => c !== null);

/**
 * R11: before/after difference, matching items by activityId / legId.
 * - Duration delta is null when either side's elapsed time is unknown.
 * - An item whose cost is unknown on either side (changed to/from unknown, or added/removed while unknown) is left out
 *   of `knownCostDelta` entirely and listed in `unknownCostItems` (after's plan order, then items only in before).
 *   An unknown cost is therefore never counted as 0, neither as a saving nor as a new expense.
 * - `knownCostDelta` omits currencies whose delta is 0, so an empty array means "no known change", not "free".
 */
export function tripDiff(before: readonly TripDay[], after: readonly TripDay[]): TripDiff {
  const b = tripElapsedSeconds(before);
  const a = tripElapsedSeconds(after);
  const costsBefore = costsById(before);
  const costsAfter = costsById(after);

  const knownBefore: Money[] = [];
  const knownAfter: Money[] = [];
  const unknownCostItems: string[] = [];
  for (const [id, afterCosts] of costsAfter) {
    const beforeCosts = costsBefore.get(id) ?? [];
    if (!isKnown(afterCosts) || !isKnown(beforeCosts)) {
      unknownCostItems.push(id);
      continue;
    }
    knownAfter.push(...afterCosts);
    knownBefore.push(...beforeCosts);
  }
  for (const [id, beforeCosts] of costsBefore) {
    if (costsAfter.has(id)) continue;
    if (isKnown(beforeCosts)) knownBefore.push(...beforeCosts);
    else unknownCostItems.push(id);
  }

  return {
    durationDeltaSeconds: a === null || b === null ? null : a - b,
    knownCostDelta: knownCostDelta(knownBefore, knownAfter),
    unknownCostItems,
  };
}
