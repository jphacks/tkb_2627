/**
 * Pure helpers for the U06 edit screen: apply K10 operations to a Trip locally (a preview of the pending,
 * unsaved list; the server stays the authority), build new activities and describe a diff without ever
 * turning an unknown value into 0.
 */
import type { Activity, ItineraryItem, Money, Trip, TripDiff, TripOperation, ZonedTime } from '@tkb/contracts';

export function itemIdOf(item: ItineraryItem): string {
  return item.type === 'activity' ? item.activityId : item.legId;
}

export type ApplyResult = { ok: true; trip: Trip } | { ok: false; reason: string };

/** Same all-or-nothing semantics as the server: move = remove then insert at toPosition. */
export function applyOperations(trip: Trip, ops: readonly TripOperation[]): ApplyResult {
  const after = structuredClone(trip);
  const locate = (id: string) => {
    for (const [d, day] of after.days.entries()) {
      const index = day.items.findIndex(i => itemIdOf(i) === id);
      if (index >= 0) return { d, index };
    }
    return null;
  };
  for (const op of ops) {
    switch (op.op) {
      case 'set_title': after.title = op.title; break;
      case 'add': {
        const day = after.days[op.dayIndex];
        if (!day || op.position > day.items.length) return { ok: false, reason: '追加位置が範囲外です' };
        if (locate(itemIdOf(op.item))) return { ok: false, reason: 'IDが重複しています' };
        day.items.splice(op.position, 0, structuredClone(op.item));
        break;
      }
      case 'remove': {
        const at = locate(op.itemId);
        if (!at) return { ok: false, reason: '削除対象が見つかりません' };
        after.days[at.d]?.items.splice(at.index, 1);
        break;
      }
      case 'move': {
        const at = locate(op.itemId);
        const target = after.days[op.toDayIndex];
        if (!at || !target) return { ok: false, reason: '移動対象が見つかりません' };
        const [item] = after.days[at.d]?.items.splice(at.index, 1) ?? [];
        if (!item || op.toPosition > target.items.length) return { ok: false, reason: '移動先が範囲外です' };
        target.items.splice(op.toPosition, 0, item);
        break;
      }
      case 'update': {
        const at = locate(op.itemId);
        if (!at || itemIdOf(op.item) !== op.itemId) return { ok: false, reason: '更新対象が見つかりません' };
        const items = after.days[at.d]?.items;
        if (items) items[at.index] = structuredClone(op.item);
        break;
      }
    }
  }
  return { ok: true, trip: after };
}

/** One move step of an activity to the previous (-1) or next (+1) activity of the same day. null at the edge. */
export function moveStepOp(trip: Trip, itemId: string, dayIndex: number, dir: -1 | 1): TripOperation | null {
  const items = trip.days[dayIndex]?.items;
  if (!items) return null;
  const from = items.findIndex(i => itemIdOf(i) === itemId);
  if (from < 0) return null;
  for (let j = from + dir; j >= 0 && j < items.length; j += dir) {
    if (items[j]?.type === 'activity') return { op: 'move', itemId, toDayIndex: dayIndex, toPosition: j };
  }
  return null;
}

/** Local date + "HH:MM" in an IANA zone to a ZonedTime. null when the text is not a valid time. */
export function localToZoned(date: string, hhmm: string, timeZone: string): ZonedTime | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m || !d) return null;
  const wall = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(m[1]), Number(m[2]));
  const offsetAt = (ms: number): number => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(ms));
    const g = (t: string) => Number(p.find(x => x.type === t)?.value);
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - ms;
  };
  let utc = wall - offsetAt(wall);
  utc = wall - offsetAt(utc);
  return { utc: new Date(utc).toISOString().replace(/\.\d{3}Z$/, 'Z'), timeZone };
}

let counter = 0;
export function newActivityId(): string {
  counter += 1;
  return `act_u06_${Date.now().toString(36)}_${counter}`;
}

/** A free (custom) activity; cost stays unknown (null) because the user did not give one. */
export function newFreeActivity(input: { title: string; date: string; timeZone: string; startText: string; endText: string; id?: string }): Activity | { error: string } {
  const title = input.title.trim();
  if (!title) return { error: 'タイトルを入力してください。' };
  const start = input.startText ? localToZoned(input.date, input.startText, input.timeZone) : null;
  const end = input.endText ? localToZoned(input.date, input.endText, input.timeZone) : null;
  if (input.startText && !start) return { error: '開始時刻は HH:MM で入力してください。' };
  if (input.endText && !end) return { error: '終了時刻は HH:MM で入力してください。' };
  if (start && end && end.utc < start.utc) return { error: '終了時刻は開始時刻より後にしてください。' };
  return {
    type: 'activity', activityId: input.id ?? newActivityId(), kind: 'custom', title, placeId: null, areaName: null,
    start, end, fixed: false, status: 'planned', cost: null, costStatus: 'unknown', privateNotes: null,
  };
}

/** Signed amount in the currency's own unit, e.g. +¥1,200 / -€5.00. */
export function signedMoney(m: Money): string {
  const fmt = new Intl.NumberFormat('ja-JP', { style: 'currency', currency: m.currency });
  const digits = fmt.resolvedOptions().maximumFractionDigits ?? 0;
  const text = fmt.format(Math.abs(m.amountMinor) / 10 ** digits);
  return m.amountMinor > 0 ? `+${text}` : m.amountMinor < 0 ? `-${text}` : text;
}

export function signedMinutes(seconds: number): string {
  const min = Math.round(seconds / 60);
  return min > 0 ? `+${min}分` : min < 0 ? `${min}分` : '変わりません';
}

export interface DiffText { duration: string; costs: string[]; unknownCostTitles: string[] }

/** R11: unknown duration stays 不明; unknown cost items are listed as 費用不明, never summed as 0. */
export function describeDiff(diff: TripDiff, titleOf: (id: string) => string): DiffText {
  return {
    duration: diff.durationDeltaSeconds === null ? '不明' : signedMinutes(diff.durationDeltaSeconds),
    costs: diff.knownCostDelta.map(signedMoney),
    unknownCostTitles: diff.unknownCostItems.map(titleOf),
  };
}

export function titleLookup(trip: Trip): (id: string) => string {
  const m = new Map<string, string>();
  for (const day of trip.days) for (const i of day.items) if (i.type === 'activity') m.set(i.activityId, i.title);
  return id => m.get(id) ?? id;
}
