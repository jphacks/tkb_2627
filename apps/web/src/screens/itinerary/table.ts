/**
 * U04 itinerary table (R1-R3, R5): pure view-model.
 * - one row per place (top-level stay), time column on the left, content on the right (R3);
 * - a travel leg is shown as a thin connector between two stay rows: the departure time sits on the origin row and the
 *   arrival time on the destination row, so every row carries a single time (not "A → B" in one card);
 * - nested activities (Activity.parentActivityId) are only inside their expanded parent (R2) and are not map points (R5);
 * - drag-and-drop planning (R1): a stay moves together with its children, expressed as K10 `move` operations.
 * Unknown values are shown as 未取得, never as 0.
 */
import type { Activity, PlaceInfo, TravelLeg, TripDay, TripOperation, ZonedTime } from '@tkb/contracts';
import { UNKNOWN, formatDuration, formatMoney } from '../../lib/format.ts';
import { isChildItem, itemKey, numberPlaces } from '../../lib/places.ts';
import { KIND_LABEL, LEG_MODE_LABEL, VALUE_UNKNOWN, transitDetail } from './model.ts';

/** Local date (YYYY-MM-DD) of an instant in its own zone. */
function localDate(t: ZonedTime): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: t.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t.utc));
}

/** "9:25" in the item's own zone; "11/2 9:25" when the local date differs from the day; null is 未取得. */
export function formatHm(t: ZonedTime | null, dayDate: string): string {
  if (t === null) return UNKNOWN;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: t.timeZone, hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t.utc));
  const hour = parts.find(p => p.type === 'hour')?.value ?? '0';
  const minute = parts.find(p => p.type === 'minute')?.value ?? '00';
  const date = localDate(t);
  const prefix = date === dayDate ? '' : `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))} `;
  return `${prefix}${Number(hour)}:${minute}`;
}

/** Stay time as a range: 「9:00〜10:00」. A missing end or start stays 未取得. */
export function stayRange(start: ZonedTime | null, end: ZonedTime | null, dayDate: string): string {
  return `${formatHm(start, dayDate)}〜${formatHm(end, dayDate)}`;
}

export const DATA_STATUS_LABEL: Record<string, string> = {
  verified: '取得済み', fixture: 'サンプル（fixture）', unknown: '未取得', unavailable: '取得できません', unsupported_region: '対象外の地域',
};

export interface ChildRow {
  key: string;
  item: Activity;
  range: string;
}

export interface StayRow {
  kind: 'stay';
  key: string;
  item: Activity;
  /** Map point number (top-level places only); null when the place is unknown or has no location. */
  number: number | null;
  place: PlaceInfo | null;
  range: string;
  children: ChildRow[];
}

export interface LegRow {
  kind: 'leg';
  key: string;
  leg: TravelLeg;
  /** 「徒歩・15分・運賃 未取得」 */
  summary: string;
  /** The leg is two thin rows: the start row shows only the departure time, the end row only the arrival time. */
  departure: string;
  arrival: string;
  fromName: string;
  toName: string;
  /** The neighbouring stays no longer match the leg's endpoints (after a reorder): the travel info needs recalculating. */
  stale: boolean;
}

export type TableRow = StayRow | LegRow;

export function legSummary(leg: TravelLeg): string {
  // An unknown fare is shown in the details only, not on every row (UI review on #33).
  return `${LEG_MODE_LABEL[leg.mode]}・${formatDuration(leg.durationSeconds)}${leg.fare === null ? '' : `・運賃 ${formatMoney(leg.fare)}`}`;
}

/** Rows of one day in display order. Children are attached to their parent; an orphaned child is shown as its own stay. */
export function tableRows(day: TripDay, places: readonly PlaceInfo[]): TableRow[] {
  const numbered = new Map(numberPlaces(day, [...places]).map(n => [n.place.placeId, n.number]));
  const byPlace = new Map(places.map(p => [p.placeId, p]));
  const activityIds = new Set(day.items.flatMap(i => (i.type === 'activity' ? [i.activityId] : [])));
  const children = new Map<string, ChildRow[]>();
  for (const it of day.items) {
    if (it.type !== 'activity' || !it.parentActivityId || !activityIds.has(it.parentActivityId)) continue;
    const list = children.get(it.parentActivityId) ?? [];
    list.push({ key: it.activityId, item: it, range: stayRange(it.start, it.end, day.date) });
    children.set(it.parentActivityId, list);
  }
  const rows: TableRow[] = [];
  for (const it of day.items) {
    if (it.type === 'leg') {
      rows.push({
        kind: 'leg', key: it.legId, leg: it, summary: legSummary(it), stale: false,
        departure: formatHm(it.departure, day.date), arrival: formatHm(it.arrival, day.date),
        fromName: byPlace.get(it.fromPlaceId)?.name ?? UNKNOWN, toName: byPlace.get(it.toPlaceId)?.name ?? UNKNOWN,
      });
      continue;
    }
    if (it.parentActivityId && activityIds.has(it.parentActivityId)) continue;
    const n = it.placeId ? numbered.get(it.placeId) : undefined;
    rows.push({
      kind: 'stay', key: it.activityId, item: it, number: n ?? null, place: it.placeId ? byPlace.get(it.placeId) ?? null : null,
      range: stayRange(it.start, it.end, day.date), children: children.get(it.activityId) ?? [],
    });
  }
  rows.forEach((row, i) => {
    if (row.kind !== 'leg') return;
    const prev = rows[i - 1];
    const next = rows[i + 1];
    const from = prev?.kind === 'stay' ? prev.item.placeId : null;
    const to = next?.kind === 'stay' ? next.item.placeId : null;
    row.stale = (from !== null && from !== row.leg.fromPlaceId) || (to !== null && to !== row.leg.toPlaceId);
  });
  return rows;
}

export interface DetailLine {
  label: string;
  value: string;
  unknown: boolean;
}

const line = (label: string, value: string | null, extra = ''): DetailLine =>
  value === null || value === '' || value === UNKNOWN ? { label, value: UNKNOWN, unknown: true } : { label, value: value + extra, unknown: false };

/** What the user sees when a place row is opened: time, cost, description and where each value came from. */
/**
 * Details of a stay: only what the row does not already show (UI review on #32: no time/kind again, no description
 * or source lines; the sources are in the attribution block under the map).
 */
export function stayDetails(row: StayRow): DetailLine[] {
  const a = row.item;
  const p = row.place;
  return [
    line('場所', p?.name ?? a.areaName ?? null),
    line('営業時間', p?.openingHours ?? null),
    line('費用', a.cost === null ? null : formatMoney(a.cost)),
  ];
}

/** Details of a nested activity (shown inside the opened parent). */
export function childDetails(child: ChildRow): DetailLine[] {
  const a = child.item;
  return [
    line('時間', child.range),
    line('種類', KIND_LABEL[a.kind]),
    line('費用', a.cost === null ? null : formatMoney(a.cost)),
  ];
}

const unk = (s: string): string => (s === VALUE_UNKNOWN ? UNKNOWN : s);

/** Details of a travel connector: times, duration, fare and (for public transport) line / stops / platform. */
export function legDetails(row: LegRow, dayDate: string): DetailLine[] {
  const l = row.leg;
  const lines: DetailLine[] = [
    line('出発', l.departure === null ? null : formatHm(l.departure, dayDate)),
    line('到着', l.arrival === null ? null : formatHm(l.arrival, dayDate)),
    line('所要時間', l.durationSeconds === null ? null : formatDuration(l.durationSeconds)),
    line('運賃', l.fare === null ? null : formatMoney(l.fare)),
  ];
  const t = transitDetail(l);
  if (t) {
    lines.push(
      line('路線', unk(t.line)), line('乗車', unk(t.boarding)), line('降車', unk(t.alighting)),
      line('乗換', unk(t.transferCount), t.transfers.length > 0 ? `（${t.transfers.join('、')}）` : ''), line('ホーム', unk(t.platform)),
    );
  }
  if (row.stale) lines.push({ label: '注意', value: '並べ替えのため前後の地点と合いません。移動の再計算が必要です。', unknown: false });
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------
// Reordering (R1)
// ---------------------------------------------------------------------------------------------------------------

/** Ids of a stay and its children, in the day's item order. */
export function blockOf(day: TripDay, stayKey: string): string[] {
  const kids = day.items.flatMap(i => (i.type === 'activity' && i.parentActivityId === stayKey ? [itemKey(i)] : []));
  return [stayKey, ...kids.filter(k => k !== stayKey)];
}

function simulate(order: readonly string[], id: string, toPosition: number): string[] {
  const next = order.filter(x => x !== id);
  next.splice(toPosition, 0, id);
  return next;
}

/** Final item order when `block` is inserted before `beforeKey` (null: at the end of the day). */
export function reorderedOrder(order: readonly string[], block: readonly string[], beforeKey: string | null): string[] {
  const rest = order.filter(id => !block.includes(id));
  const at = beforeKey === null ? rest.length : rest.indexOf(beforeKey);
  if (at < 0) return [...order];
  return [...rest.slice(0, at), ...block, ...rest.slice(at)];
}

/**
 * K10 `move` operations that turn `order` into the order with `block` (a stay and its children) inserted before
 * `beforeKey`. Same semantics as the server: each move removes the item, then inserts it at `toPosition`.
 */
export function planMoves(order: readonly string[], block: readonly string[], beforeKey: string | null, dayIndex: number): TripOperation[] {
  const target = reorderedOrder(order, block, beforeKey);
  if (target.every((id, i) => id === order[i])) return [];
  const attempt = (ids: readonly string[]): TripOperation[] | null => {
    let cur = [...order];
    const ops: TripOperation[] = [];
    for (const id of ids) {
      const to = target.indexOf(id);
      cur = simulate(cur, id, to);
      ops.push({ op: 'move', itemId: id, toDayIndex: dayIndex, toPosition: to });
    }
    return cur.every((x, i) => x === target[i]) ? ops : null;
  };
  const forward = attempt(block);
  if (forward) return forward;
  const reverse = attempt([...block].reverse());
  if (reverse) return reverse;
  // Fallback: place every item that is out of position, front to back.
  let cur = [...order];
  const ops: TripOperation[] = [];
  target.forEach((id, i) => {
    if (cur[i] === id) return;
    cur = simulate(cur, id, i);
    ops.push({ op: 'move', itemId: id, toDayIndex: dayIndex, toPosition: i });
  });
  return ops;
}

/**
 * Where a drop lands: the stay keys in display order, the row under the pointer and whether the pointer is in its
 * lower half. Returns the stay to insert before (null = after the last stay), or `undefined` when nothing changes.
 */
export function insertBeforeKey(stayKeys: readonly string[], dragged: string, overKey: string, after: boolean): string | null | undefined {
  const i = stayKeys.indexOf(overKey);
  if (i < 0 || !stayKeys.includes(dragged)) return undefined;
  const nextKey = after ? stayKeys[i + 1] ?? null : overKey;
  if (nextKey === dragged) return undefined;
  const di = stayKeys.indexOf(dragged);
  if (nextKey === (stayKeys[di + 1] ?? null)) return undefined;
  return nextKey;
}

/**
 * The stay to insert before when the pointer is over `overKey` in the order on screen (`shown`, which already has the
 * dragged stay moved). undefined: the drop would give the original order.
 */
export function hoverTarget(stayKeys: readonly string[], shown: readonly string[], dragged: string, overKey: string, after: boolean): string | null | undefined {
  const rest = shown.filter(k => k !== dragged);
  const i = rest.indexOf(overKey);
  if (i < 0 || !stayKeys.includes(dragged)) return undefined;
  const before = after ? rest[i + 1] ?? null : overKey;
  const result = reorderedOrder(stayKeys, [dragged], before);
  return result.every((k, j) => k === stayKeys[j]) ? undefined : before;
}

/** Rows in a new stay order: each stay keeps the legs that follow it (legs before the first stay stay first). */
export function previewRows(rows: readonly TableRow[], order: readonly string[]): TableRow[] {
  const lead: TableRow[] = [];
  const units = new Map<string, TableRow[]>();
  let cur: TableRow[] | null = null;
  for (const r of rows) {
    if (r.kind === 'stay') { cur = [r]; units.set(r.key, cur); } else (cur ?? lead).push(r);
  }
  return [...lead, ...order.flatMap(k => units.get(k) ?? [])];
}

/** Keyboard alternative: the stay to insert before when moving `dragged` one stay up (-1) or down (+1); undefined at the edge. */
export function keyboardTarget(stayKeys: readonly string[], dragged: string, dir: -1 | 1): string | null | undefined {
  const i = stayKeys.indexOf(dragged);
  if (i < 0) return undefined;
  if (dir === -1) return i === 0 ? undefined : stayKeys[i - 1];
  if (i === stayKeys.length - 1) return undefined;
  return stayKeys[i + 2] ?? null;
}

/** True when the item is a nested activity (not a table row of its own). */
export const isChild = isChildItem;
