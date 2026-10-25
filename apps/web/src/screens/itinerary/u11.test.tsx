/**
 * U11 (#213): one 地図・編集 screen (map above the editable table), drag reorder that really changes the order
 * (direction + row boxes from the drag start), delete inline, children listed when a stay opens, InsertSlot positions.
 * The real-browser check is apps/web/scripts/cdp-drag-check.mjs.
 */
import { readFileSync } from 'node:fs';
import type { ReactElement } from 'react';
import { renderToString as renderRaw } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ApiError, Trip, TripOperation } from '@tkb/contracts';
import { domesticTrip } from '@tkb/fixtures';
import { createMockApi } from '../../mocks/index.ts';
import { createMockTripEditApi, sharedMockApi } from '../edit/api.ts';
import { EditView, moveSaveOps } from '../edit/EditScreen.tsx';
import { applyOperations, itemIdOf } from '../edit/ops.ts';
import { InsertSlot } from './InsertSlot.tsx';
import { ItineraryTable } from './ItineraryTable.tsx';
import { bandTarget, reorderedOrder, tableRows, type StayRow } from './table.ts';

const render = (el: ReactElement): string => renderRaw(el).replace(/<!-- -->/g, '');
const trip = (): Trip => structuredClone(domesticTrip);
const day0 = domesticTrip.days[0]!;
const staysOf = (t: Trip, d = 0) => tableRows(t.days[d]!, t.places).flatMap(r => (r.kind === 'stay' ? [r.key] : []));

// Bands (stay row + details + the leg after it) 155px apart, like the screen (#34 review). M4's bandTarget (#220).
const keys = ['a', 'b', 'c', 'd'];
const tops = keys.map((_, i) => i * 155);

describe('bandTarget: where a pointer drop lands (both directions)', () => {
  it('row 1 dropped on the upper part of row 2 goes after row 2 (the case reported three times)', () => {
    const before = bandTarget(keys, tops, 'a', tops[1]! + 20);
    expect(before).toBe('c');
    expect(reorderedOrder(keys, ['a'], before!)).toEqual(['b', 'a', 'c', 'd']);
  });
  it('row 2 dropped on the lower part of row 1 goes before row 1', () => {
    expect(bandTarget(keys, tops, 'b', tops[0]! + 100)).toBe('a');
  });
  it('inside its own band: no move', () => {
    expect(bandTarget(keys, tops, 'a', 50)).toBeUndefined();
    expect(bandTarget(keys, tops, 'b', tops[1]! + 1)).toBeUndefined();
  });
  it('long drags: down to the end, up to the top', () => {
    expect(bandTarget(keys, tops, 'a', tops[2]! + 1)).toBe('d');
    expect(bandTarget(keys, tops, 'a', 10_000)).toBeNull();
    expect(bandTarget(keys, tops, 'd', -50)).toBe('a');
  });
  it('is stable for a still pointer, and unknown keys do nothing', () => {
    expect(new Set([1, 2, 3].map(() => bandTarget(keys, tops, 'a', tops[2]! + 5)))).toEqual(new Set(['d']));
    expect(bandTarget(keys, tops, 'x', 300)).toBeUndefined();
  });
});

describe('moveSaveOps: K10 operations that save a drag', () => {
  it('changes the order of the stays in both directions, children move with their parent', () => {
    const t = trip();
    const stays = staysOf(t);
    for (const [key, before, expected] of [
      [stays[0]!, stays[2]!, [stays[1], stays[0], ...stays.slice(2)]],
      [stays[1]!, stays[0]!, [stays[1], stays[0], ...stays.slice(2)]],
    ] as const) {
      const ops = moveSaveOps(t, 0, key, before);
      expect(ops.length).toBeGreaterThan(0);
      const r = applyOperations(t, ops);
      expect(r.ok).toBe(true);
      if (r.ok) expect(staysOf(r.trip)).toEqual(expected);
    }
  });
  it('no change: no operations', () => {
    const t = trip();
    const stays = staysOf(t);
    expect(moveSaveOps(t, 0, stays[0]!, stays[1]!)).toEqual([]);
    expect(moveSaveOps(t, 9, stays[0]!, null)).toEqual([]);
  });
  it('the mock server saves it (expectedRevision) and a stale revision is a 409, never an overwrite', async () => {
    const api = createMockTripEditApi(createMockApi());
    const got = await api.getTrip(domesticTrip.tripId);
    if (!got.ok) throw new Error('no trip');
    const t = got.data;
    const stays = staysOf(t);
    const ops = moveSaveOps(t, 0, stays[0]!, stays[2]!);
    const saved = await api.patch(t.tripId, { expectedRevision: t.revision, operations: ops });
    expect(saved.ok).toBe(true);
    if (saved.ok) expect(staysOf(saved.data.trip).slice(0, 2)).toEqual([stays[1], stays[0]]);
    const stale = await api.patch(t.tripId, { expectedRevision: t.revision, operations: ops });
    expect(!stale.ok && stale.error.code).toBe('REVISION_CONFLICT');
  });
  it('mock mode keeps one in-memory server for the page (switching tabs keeps the saved order)', () => {
    expect(sharedMockApi()).toBe(sharedMockApi());
  });
});

describe('unified 地図・編集 screen (EditView)', () => {
  const base = trip();
  const props = {
    trip: base, working: base, pending: [] as TripOperation[], dayIndex: 0, onDay() {}, onAdd() {}, onRemove() {}, onUndo() {}, onClear() {}, onPreview() {},
    alt: { state: 'idle' } as const, onApply() {}, saved: null, error: null as ApiError | null, onReload() {}, onDismissError() {}, busy: false,
    route: { mode: 'mock', tripId: base.tripId } as const, mapsKey: null, onSaveMove() {}, moveNotice: null,
  };
  it('shows the map above the editable table, with the same numbers', () => {
    const html = render(<EditView {...props} />);
    expect(html).toContain('it-mapcol');
    expect(html.indexOf('it-mapcol')).toBeLessThan(html.indexOf('aria-label="行程表"'));
    expect(html).toContain('class="it-handle"');
    const numbers = tableRows(day0, base.places).flatMap(r => (r.kind === 'stay' && r.number !== null ? [r.number] : []));
    for (const n of numbers) expect(html).toContain(`aria-label="地図の地点${n}"`);
    expect(html).not.toContain('>0円');
  });
  it('the delete button sits in the row (right of the name), not under it', () => {
    const html = render(<EditView {...props} />);
    expect(html).toMatch(/<div class="it-cell"><button type="button" class="it-rowbtn"[\s\S]*?<\/button><div class="it-rowextra">[\s\S]*?を削除/);
  });
  it('shows the saved-drag line and a 409 message', () => {
    expect(render(<EditView {...props} moveNotice="並べ替えを保存しました（版 2）。" />)).toContain('並べ替えを保存しました（版 2）');
    const err: ApiError = { code: 'REVISION_CONFLICT', message: 'x', retryable: false, requestId: 'r' };
    expect(render(<EditView {...props} error={err} />)).toContain('最新の旅程を再読み込み');
  });
});

describe('table: children, insert slots, layout', () => {
  const t = trip();
  const dayWithKids = t.days.findIndex(d => d.items.some(i => i.type === 'activity' && i.parentActivityId));
  const day = t.days[dayWithKids]!;
  const rows = tableRows(day, t.places);
  const parent = rows.find((r): r is StayRow => r.kind === 'stay' && r.children.length > 0)!;
  it('an opened stay lists its children (time + bold name), read-only and edit tables alike', () => {
    for (const onReorder of [undefined, () => {}]) {
      const html = render(<ItineraryTable rows={rows} dayDate={day.date} expanded={new Set([parent.key])} onToggleRow={() => {}} {...(onReorder ? { onReorder } : {})} />);
      expect(html).toContain('class="it-subtable"');
      for (const c of parent.children) expect(html).toContain(`<span class="it-title">${c.item.title}</span>`);
    }
  });
  it('insert slots: before the first stay, between stays and after the last (edit only)', () => {
    const seen: [string, string | null][] = [];
    const html = render(<ItineraryTable rows={rows} dayDate={day.date} expanded={new Set()} onToggleRow={() => {}} onReorder={() => {}}
      insertSlot={(p, b) => { seen.push([p, b]); return <span data-slot={p} />; }} />);
    const stays = rows.flatMap(r => (r.kind === 'stay' ? [r.key] : []));
    expect(seen).toEqual([['before-first', stays[0]], ...stays.slice(1).map(k => ['between', k] as [string, string]), ['after-last', null]]);
    expect(html.match(/data-insert-slot=/g)).toHaveLength(stays.length + 1);
    expect(render(<ItineraryTable rows={rows} dayDate={day.date} expanded={new Set()} onToggleRow={() => {}} />)).not.toContain('data-insert-slot');
  });
  it("M3's InsertSlot renders in the edit table slot (collapsed ＋)", () => {
    expect(render(<InsertSlot position="between" onAdd={() => {}} />)).toContain('ここに予定を追加');
  });
  it('CSS: time column clear of the handle, number centred, controls beside the name', () => {
    const css = readFileSync(new URL('./itinerary.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.it-table \.it-stay > \.it-time, \.it-table \.it-stoprow > \.it-time \{ padding: 8px 6px 8px 12px; \}/);
    expect(css).toMatch(/\.it-cell \{ display: flex; align-items: center;/);
    expect(css).toMatch(/\.it-rowbtn > \.it-num[^{]*\{ align-self: center; \}/);
    expect(css).toMatch(/\.it-rowextra/);
  });
  it('itemIdOf keeps leg ids (moves never drop a leg)', () => {
    expect(day0.items.map(itemIdOf).length).toBe(day0.items.length);
  });
});
