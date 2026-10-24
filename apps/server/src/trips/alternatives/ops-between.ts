import type { ItineraryItem, Trip, TripOperation } from '@tkb/contracts';
import { applyOperations } from '../operations.ts';

export const itemIdOf = (it: ItineraryItem): string => (it.type === 'activity' ? it.activityId : it.legId);

/**
 * K10 operations that turn `base` into `target` (same trip, same days), or null when that cannot be written within
 * the K10 limits. The result is checked by applying it with the real applyOperations, so a client that sends it
 * to PATCH gets exactly `target` (validationState aside). [] means no change.
 */
export function operationsBetween(base: Trip, target: Trip): TripOperation[] | null {
  const ops: TripOperation[] = [];
  if (base.title !== target.title) ops.push({ op: 'set_title', title: target.title });
  const targetIds = new Set(target.days.flatMap(d => d.items.map(itemIdOf)));
  const baseItems = new Map(base.days.flatMap(d => d.items).map(i => [itemIdOf(i), i]));
  for (const id of baseItems.keys()) if (!targetIds.has(id)) ops.push({ op: 'remove', itemId: id });
  const work = base.days.map(d => d.items.map(itemIdOf).filter(id => targetIds.has(id)));
  const updates: TripOperation[] = [];
  for (const [di, day] of target.days.entries()) {
    for (const [i, item] of day.items.entries()) {
      const id = itemIdOf(item);
      if (work[di]![i] !== id) {
        let from: { d: number; p: number } | null = null;
        for (let d = 0; d < work.length && !from; d++) {
          const p = work[d]!.indexOf(id);
          if (p >= 0) from = { d, p };
        }
        if (from) {
          work[from.d]!.splice(from.p, 1);
          work[di]!.splice(i, 0, id);
          ops.push({ op: 'move', itemId: id, toDayIndex: di, toPosition: i });
        } else {
          work[di]!.splice(i, 0, id);
          ops.push({ op: 'add', dayIndex: di, position: i, item });
          continue;
        }
      }
      const was = baseItems.get(id);
      if (was && JSON.stringify(was) !== JSON.stringify(item)) updates.push({ op: 'update', itemId: id, item });
    }
  }
  ops.push(...updates);
  if (ops.length > 50) return null;
  if (ops.length === 0) return [];
  const applied = applyOperations(base, ops);
  if (!applied.ok) return null;
  return JSON.stringify(applied.trip.days) === JSON.stringify(target.days) && applied.trip.title === target.title ? ops : null;
}
