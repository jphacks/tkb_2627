import type { ItineraryItem, Trip, TripDay, TripDiff, TripOperation } from '@tkb/contracts';
import { tripDiff } from '@tkb/planner';

export type OpResult =
  | { ok: true; trip: Trip }
  | { ok: false; index: number; reason: string };

const itemId = (it: ItineraryItem): string => (it.type === 'activity' ? it.activityId : it.legId);

function locate(days: TripDay[], id: string): { d: number; p: number } | null {
  for (let d = 0; d < days.length; d++) {
    const p = days[d]!.items.findIndex((it) => itemId(it) === id);
    if (p >= 0) return { d, p };
  }
  return null;
}

/**
 * Pure, allow-listed application of K10 operations, in order, all-or-nothing. The input trip is never
 * mutated. Structural edits mark the trip `needs_revalidation` (travel legs and times are no longer
 * confirmed); a title-only edit keeps the validation state. revision/updatedAt are left to the repo.
 */
function missingPlace(trip: Trip, it: ItineraryItem): boolean {
  const known = new Set(trip.places.map((p) => p.placeId));
  const refs = it.type === 'activity' ? [it.placeId] : [it.fromPlaceId, it.toPlaceId];
  return refs.some((r) => r !== null && !known.has(r));
}

export function applyOperations(trip: Trip, ops: TripOperation[]): OpResult {
  const days: TripDay[] = trip.days.map((d) => ({ ...d, items: [...d.items] }));
  let title = trip.title;
  let structural = false;
  for (const [index, op] of ops.entries()) {
    const bad = (reason: string): OpResult => ({ ok: false, index, reason });
    switch (op.op) {
      case 'set_title':
        title = op.title;
        break;
      case 'add': {
        const day = days[op.dayIndex];
        if (!day) return bad('dayIndex out of range');
        if (op.position > day.items.length) return bad('position out of range');
        if (locate(days, itemId(op.item))) return bad('item id already exists');
        if (missingPlace(trip, op.item)) return bad('unknown placeId');
        day.items.splice(op.position, 0, op.item);
        structural = true;
        break;
      }
      case 'remove': {
        const at = locate(days, op.itemId);
        if (!at) return bad('unknown itemId');
        days[at.d]!.items.splice(at.p, 1);
        structural = true;
        break;
      }
      case 'move': {
        const at = locate(days, op.itemId);
        if (!at) return bad('unknown itemId');
        const to = days[op.toDayIndex];
        if (!to) return bad('toDayIndex out of range');
        const [it] = days[at.d]!.items.splice(at.p, 1);
        if (op.toPosition > to.items.length) return bad('toPosition out of range');
        to.items.splice(op.toPosition, 0, it!);
        structural = true;
        break;
      }
      case 'update': {
        const at = locate(days, op.itemId);
        if (!at) return bad('unknown itemId');
        if (itemId(op.item) !== op.itemId) return bad('item id must not change');
        const cur = days[at.d]!.items[at.p]!;
        if (cur.type !== op.item.type) return bad('item type must not change');
        if (missingPlace(trip, op.item)) return bad('unknown placeId');
        days[at.d]!.items[at.p] = op.item;
        structural = true;
        break;
      }
    }
  }
  const validationState = structural ? 'needs_revalidation' : trip.validationState;
  return { ok: true, trip: { ...trip, title, days, validationState } };
}

/** Walking legs have no fare by nature, so they are not cost items (neither known nor unknown). */
function withoutWalkingLegs(days: Trip['days']): Trip['days'] {
  return days.map((d) => ({ ...d, items: d.items.filter((it) => it.type === 'activity' || it.mode !== 'walk') }));
}

/**
 * K10 diff, defined once in @tkb/planner (R11): an item whose cost is unknown on either side is never counted as 0
 * (not as a saving, not as a new expense) and is listed in unknownCostItems; duration is null when any item is untimed.
 */
export function computeDiff(before: Trip, after: Trip): TripDiff {
  const duration = tripDiff(before.days, after.days).durationDeltaSeconds;
  const costs = tripDiff(withoutWalkingLegs(before.days), withoutWalkingLegs(after.days));
  return { durationDeltaSeconds: duration, knownCostDelta: costs.knownCostDelta, unknownCostItems: costs.unknownCostItems };
}
