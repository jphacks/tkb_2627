import type { ItineraryItem, Money, Trip, TripDay, TripDiff, TripOperation } from '@tkb/contracts';

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
        days[at.d]!.items[at.p] = op.item;
        structural = true;
        break;
      }
    }
  }
  const validationState = structural ? 'needs_revalidation' : trip.validationState;
  return { ok: true, trip: { ...trip, title, days, validationState } };
}

/** Sum of per-day spans between the earliest and latest known timestamp; null when nothing is timed. */
function timedSeconds(trip: Trip): number | null {
  let total = 0;
  let any = false;
  for (const day of trip.days) {
    const ts: number[] = [];
    for (const it of day.items) {
      const pts = it.type === 'activity' ? [it.start, it.end] : [it.departure, it.arrival];
      for (const p of pts) if (p) ts.push(Date.parse(p.utc));
    }
    if (ts.length >= 2) {
      any = true;
      total += Math.round((Math.max(...ts) - Math.min(...ts)) / 1000);
    }
  }
  return any ? total : null;
}

function knownCosts(trip: Trip): Map<string, number> {
  const m = new Map<string, number>();
  for (const day of trip.days) {
    for (const it of day.items) {
      const money = it.type === 'activity' ? it.cost : it.fare;
      if (money) m.set(money.currency, (m.get(money.currency) ?? 0) + money.amountMinor);
    }
  }
  return m;
}

/** R11: unknown cost is never counted as 0; it is listed in unknownCostItems instead. */
export function computeDiff(before: Trip, after: Trip): TripDiff {
  const b = timedSeconds(before);
  const a = timedSeconds(after);
  const cb = knownCosts(before);
  const ca = knownCosts(after);
  const knownCostDelta: Money[] = [];
  for (const cur of [...new Set([...cb.keys(), ...ca.keys()])].sort()) {
    const delta = (ca.get(cur) ?? 0) - (cb.get(cur) ?? 0);
    if (delta !== 0) knownCostDelta.push({ amountMinor: delta, currency: cur });
  }
  const unknownCostItems: string[] = [];
  for (const day of after.days) {
    for (const it of day.items) {
      if (it.type === 'activity' ? it.cost === null : it.mode === 'transit' && it.fare === null) {
        unknownCostItems.push(itemId(it));
      }
    }
  }
  return {
    durationDeltaSeconds: a === null && b === null ? null : (a ?? 0) - (b ?? 0),
    knownCostDelta,
    unknownCostItems,
  };
}
