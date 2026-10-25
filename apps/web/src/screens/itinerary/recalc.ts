/**
 * Undo and re-timing after a reorder (UI review on #33). Nothing here calls a route provider: a leg is reused only
 * when the trip already has one for the same pair of places, otherwise the leg is unknown and every time after it is
 * left unknown (never guessed). The result is still unvalidated (needs_revalidation).
 */
import type { Activity, ItineraryItem, TravelLeg, Trip, TripDay, TripOperation, ZonedTime } from '@tkb/contracts';
import { itemKey } from '../../lib/places.ts';
import { dayTransportMode } from './model.ts';

const WALK_BELOW_M = 1000;
const msToZ = (ms: number, timeZone: string): ZonedTime => ({ utc: new Date(ms).toISOString().replace(/\.000Z$/, 'Z'), timeZone });
const ms = (t: ZonedTime | null) => (t ? Date.parse(t.utc) : null);

function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Known duration of a stored leg (from its own duration or its times); null when unknown. */
function knownSeconds(leg: TravelLeg): number | null {
  if (leg.durationSeconds !== null) return leg.durationSeconds;
  const d = ms(leg.departure), a = ms(leg.arrival);
  return d !== null && a !== null && a >= d ? Math.round((a - d) / 1000) : null;
}

export interface RecalcResult {
  trip: Trip;
  /** Legs whose duration was found in the trip (same pair of places). */
  reused: number;
  /** New pairs with no known leg: their duration and every time after them are unknown. */
  unknown: number;
}

/**
 * Rebuilds the legs between the stays of one day in their current order and re-times the day from its first start.
 * A pair that was not moved keeps its own leg and the gap it had; fixed activities keep their own times; children
 * move with their parent.
 */
export function recalcDay(trip: Trip, dayIndex: number): RecalcResult {
  const day = trip.days[dayIndex];
  if (!day) return { trip, reused: 0, unknown: 0 };
  const places = new Map(trip.places.map(p => [p.placeId, p]));
  const book = new Map<string, TravelLeg>();
  for (const d of trip.days) for (const it of d.items) if (it.type === 'leg' && knownSeconds(it) !== null && !book.has(`${it.fromPlaceId}|${it.toPlaceId}`)) book.set(`${it.fromPlaceId}|${it.toPlaceId}`, it);
  const usedIds = new Set(trip.days.flatMap(d => d.items.map(itemKey)));
  const dayLegIds = new Set(day.items.flatMap(i => (i.type === 'leg' ? [i.legId] : [])));
  const newId = (base: string) => {
    let n = 1;
    while (usedIds.has(`${base}_${n}`)) n++;
    usedIds.add(`${base}_${n}`);
    return `${base}_${n}`;
  };

  const ids = new Set(day.items.flatMap(i => (i.type === 'activity' ? [i.activityId] : [])));
  const isChild = (a: Activity) => a.parentActivityId != null && ids.has(a.parentActivityId);
  const stays = day.items.filter((i): i is Activity => i.type === 'activity' && !isChild(i));
  const kids = (p: Activity) => day.items.filter((i): i is Activity => i.type === 'activity' && i.parentActivityId === p.activityId);
  const mode = dayTransportMode(trip, day.date);

  const items: ItineraryItem[] = [];
  let cursor = ms(stays[0]?.start ?? null);
  let reused = 0, unknown = 0;
  let prev: Activity | null = null;
  const taken = new Set<string>();
  for (const stay of stays) {
    let gap: number | null = null; // ms from the previous end to this start when the pair is untouched
    if (prev && prev.placeId && stay.placeId && prev.placeId !== stay.placeId) {
      // Untouched pair: its own leg still sits between the two stays, so its times keep their gap (a buffer included).
      const between = day.items.slice(day.items.indexOf(prev) + 1, day.items.indexOf(stay));
      const own = between.find((i): i is TravelLeg => i.type === 'leg' && i.fromPlaceId === prev!.placeId && i.toPlaceId === stay.placeId);
      const pe = ms(prev.end), ss = ms(stay.start);
      if (own && pe !== null && ss !== null && ss >= pe) {
        gap = ss - pe;
        const shift = cursor !== null ? cursor - pe : null;
        const dep = ms(own.departure), arr = ms(own.arrival);
        items.push({ ...own, departure: shift !== null && dep !== null ? msToZ(dep + shift, own.departure!.timeZone) : null, arrival: shift !== null && arr !== null ? msToZ(arr + shift, own.arrival!.timeZone) : null });
        taken.add(own.legId);
        cursor = cursor !== null ? cursor + gap : null;
      } else {
        const known = book.get(`${prev.placeId}|${stay.placeId}`);
        const from = places.get(prev.placeId), to = places.get(stay.placeId);
        const legMode = from?.location && to?.location && distanceM(from.location, to.location) < WALK_BELOW_M ? 'walk' : mode;
        const base: TravelLeg = known
          ? { ...structuredClone(known), legId: dayLegIds.has(known.legId) && !taken.has(known.legId) ? known.legId : newId(known.legId), durationSeconds: knownSeconds(known) }
          : { type: 'leg', legId: newId(`leg_rc${dayIndex}`), mode: legMode, fromPlaceId: prev.placeId, toPlaceId: stay.placeId, departure: null, arrival: null,
              durationSeconds: null, lineName: null, platform: null, transfers: null, fare: null, dataStatus: 'unknown', provenance: null, transit: null };
        if (known) reused++; else unknown++;
        taken.add(base.legId);
        const dep = cursor;
        const arr = dep !== null && base.durationSeconds !== null ? dep + base.durationSeconds * 1000 : null;
        items.push({ ...base, departure: dep === null ? null : msToZ(dep, day.timeZone), arrival: arr === null ? null : msToZ(arr, day.timeZone) });
        cursor = arr;
      }
    }
    const s0 = ms(stay.start), e0 = ms(stay.end);
    let start: number | null, end: number | null;
    if (stay.fixed) { start = s0; end = e0; } else {
      start = cursor;
      end = start !== null && s0 !== null && e0 !== null ? start + (e0 - s0) : null;
    }
    const shift = start !== null && s0 !== null ? start - s0 : null;
    items.push({ ...stay, start: start === null ? null : msToZ(start, stay.start?.timeZone ?? day.timeZone), end: end === null ? null : msToZ(end, stay.end?.timeZone ?? day.timeZone) });
    for (const c of kids(stay)) {
      const cs = ms(c.start), ce = ms(c.end);
      items.push(stay.fixed || c.fixed ? c : {
        ...c,
        start: shift !== null && cs !== null ? msToZ(cs + shift, c.start!.timeZone) : null,
        end: shift !== null && ce !== null ? msToZ(ce + shift, c.end!.timeZone) : null,
      });
    }
    cursor = end;
    prev = stay;
  }
  // Orphaned children (parent elsewhere) keep their place at the end, unchanged.
  for (const it of day.items) if (it.type === 'activity' && !items.includes(it) && !items.some(x => itemKey(x) === it.activityId)) items.push(it);

  const days = trip.days.map((d, i) => (i === dayIndex ? { ...d, items } : d));
  return { trip: { ...trip, days, validationState: 'needs_revalidation' }, reused, unknown };
}

/**
 * K10 operations that turn `from` into `to` for one day (used to save undo and re-timing): removes, adds, moves into
 * the target order, then updates of changed items. Applied in order with the server's semantics.
 */
export function opsToDay(from: TripDay, to: TripDay, dayIndex: number): TripOperation[] {
  const ops: TripOperation[] = [];
  const target = to.items.map(itemKey);
  const keep = new Set(target);
  let cur = from.items.map(itemKey).filter(id => {
    if (keep.has(id)) return true;
    ops.push({ op: 'remove', itemId: id });
    return false;
  });
  to.items.forEach((it, i) => {
    const id = itemKey(it);
    if (cur.includes(id)) return;
    const at = Math.min(i, cur.length);
    ops.push({ op: 'add', dayIndex, position: at, item: structuredClone(it) });
    cur = [...cur.slice(0, at), id, ...cur.slice(at)];
  });
  target.forEach((id, i) => {
    if (cur[i] === id) return;
    ops.push({ op: 'move', itemId: id, toDayIndex: dayIndex, toPosition: i });
    cur = cur.filter(x => x !== id);
    cur.splice(i, 0, id);
  });
  const before = new Map(from.items.map(it => [itemKey(it), JSON.stringify(it)]));
  for (const it of to.items) {
    const old = before.get(itemKey(it));
    if (old !== undefined && old !== JSON.stringify(it)) ops.push({ op: 'update', itemId: itemKey(it), item: structuredClone(it) });
  }
  return ops;
}
