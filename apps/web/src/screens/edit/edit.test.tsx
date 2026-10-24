import type { ReactElement } from 'react';
import { renderToString as renderRaw } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AlternativesRequest, AlternativesResult, TripPatchRequest, type ApiError, type Trip, type TripOperation } from '@tkb/contracts';
import { domesticTrip } from '@tkb/fixtures';
import { createMockApi } from '../../mocks/index.ts';
import { createLiveTripEditApi, createMockTripEditApi, describeEditError, mockDiff } from './api.ts';
import { DiffView, EditError } from './DiffView.tsx';
import { AlternativeCard, EditView } from './EditScreen.tsx';
import { applyOperations, describeDiff, itemIdOf, localToZoned, moveStepOp, newFreeActivity, signedMoney } from './ops.ts';
import { initialPending, MAX_PENDING, pendingReducer, type PendingState } from './pending.ts';
import { parseTripScreenHash, tripScreenHash } from './route.ts';

const render = (el: ReactElement): string => renderRaw(el).replace(/<!-- -->/g, '');
const SHOWN_AS_ZERO = /[¥￥€]\s?0(?![\d,.])|(?<![\d,.:])0(円|分)/;
const trip = (): Trip => structuredClone(domesticTrip);
const firstActivityId = (t: Trip): string => {
  for (const d of t.days) for (const i of d.items) if (i.type === 'activity') return i.activityId;
  throw new Error('no activity');
};

describe('routes', () => {
  it('parses edit/travel for server and mock', () => {
    expect(parseTripScreenHash('#/trips/abc/edit', 'edit')).toEqual({ mode: 'server', tripId: 'abc' });
    expect(parseTripScreenHash('#/mock/trips/abc/travel', 'travel')).toEqual({ mode: 'mock', tripId: 'abc' });
    expect(parseTripScreenHash('#/trips/abc/map', 'edit')).toBeNull();
    expect(tripScreenHash({ mode: 'mock', tripId: 'a b' }, 'edit')).toBe('#/mock/trips/a%20b/edit');
  });
});

describe('pending edit reducer', () => {
  const op = (id: string): TripOperation => ({ op: 'remove', itemId: id });
  it('pushes, undoes the last edit and clears', () => {
    let s: PendingState = initialPending;
    s = pendingReducer(s, { type: 'push', op: op('a') });
    s = pendingReducer(s, { type: 'push', op: op('b') });
    expect(s.ops).toEqual([op('a'), op('b')]);
    s = pendingReducer(s, { type: 'undo' });
    expect(s.ops).toEqual([op('a')]);
    s = pendingReducer(s, { type: 'undo' });
    expect(pendingReducer(s, { type: 'undo' })).toBe(s);
    s = pendingReducer(pendingReducer(s, { type: 'push', op: op('c') }), { type: 'clear' });
    expect(s.ops).toEqual([]);
  });
  it('never exceeds the K10 limit of 50 operations', () => {
    let s: PendingState = initialPending;
    for (let i = 0; i < MAX_PENDING + 5; i++) s = pendingReducer(s, { type: 'push', op: op(`x${i}`) });
    expect(s.ops).toHaveLength(MAX_PENDING);
  });
  it('undo restores the working trip exactly', () => {
    const base = trip();
    const id = firstActivityId(base);
    let s = pendingReducer(initialPending, { type: 'push', op: { op: 'remove', itemId: id } });
    const removed = applyOperations(base, s.ops);
    expect(removed.ok && removed.trip.days.flatMap(d => d.items).some(i => itemIdOf(i) === id)).toBe(false);
    s = pendingReducer(s, { type: 'undo' });
    const back = applyOperations(base, s.ops);
    expect(back.ok && back.trip).toEqual(base);
  });
});

describe('operations', () => {
  it('add, move and remove behave like the server', () => {
    const base = trip();
    const day = base.days[0]!;
    const act = newFreeActivity({ title: '休憩', date: day.date, timeZone: day.timeZone, startText: '', endText: '', id: 'act_new' });
    if ('error' in act) throw new Error(act.error);
    expect(act.cost).toBeNull();
    expect(act.start).toBeNull();
    const r = applyOperations(base, [{ op: 'add', dayIndex: 0, position: day.items.length, item: act }]);
    expect(r.ok && r.trip.days[0]!.items.at(-1)).toMatchObject({ activityId: 'act_new' });
    expect(applyOperations(base, [{ op: 'remove', itemId: 'nope' }]).ok).toBe(false);
    const dup = applyOperations(base, [{ op: 'add', dayIndex: 0, position: 0, item: { ...act, activityId: firstActivityId(base) } }]);
    expect(dup.ok).toBe(false);
  });
  it('moveStepOp skips legs and stops at the edges', () => {
    const base = trip();
    const acts = base.days[0]!.items.filter(i => i.type === 'activity');
    const first = itemIdOf(acts[0]!);
    expect(moveStepOp(base, first, 0, -1)).toBeNull();
    const down = moveStepOp(base, first, 0, 1);
    expect(down).toMatchObject({ op: 'move', itemId: first });
    const r = applyOperations(base, [down!]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const order = r.trip.days[0]!.items.filter(i => i.type === 'activity').map(itemIdOf);
      expect(order.indexOf(first)).toBe(1);
    }
  });
  it('validates new activity input', () => {
    const d = { date: '2026-11-01', timeZone: 'Asia/Tokyo' };
    expect(newFreeActivity({ ...d, title: ' ', startText: '', endText: '' })).toHaveProperty('error');
    expect(newFreeActivity({ ...d, title: 'a', startText: '25:00', endText: '' })).toHaveProperty('error');
    expect(newFreeActivity({ ...d, title: 'a', startText: '12:00', endText: '11:00' })).toHaveProperty('error');
    const ok = newFreeActivity({ ...d, title: 'a', startText: '10:00', endText: '11:00' });
    expect(ok).toMatchObject({ start: { utc: '2026-11-01T01:00:00Z', timeZone: 'Asia/Tokyo' } });
  });
  it('converts local time across zones', () => {
    expect(localToZoned('2026-07-01', '12:00', 'Europe/Paris')?.utc).toBe('2026-07-01T10:00:00Z');
  });
});

describe('diff display never turns unknown into zero', () => {
  it('unknown duration is 不明 and unknown cost items are 費用不明', () => {
    const diff = { durationDeltaSeconds: null, knownCostDelta: [], unknownCostItems: ['a1'] };
    const d = describeDiff(diff, id => `T-${id}`);
    expect(d.duration).toBe('不明');
    expect(d.unknownCostTitles).toEqual(['T-a1']);
    const html = render(<DiffView diff={diff} titleOf={id => `T-${id}`} />);
    expect(html).toContain('T-a1（費用不明）');
    expect(html).not.toMatch(SHOWN_AS_ZERO);
  });
  it('shows known deltas per currency with a sign', () => {
    expect(signedMoney({ amountMinor: 1200, currency: 'JPY' })).toMatch(/^\+/);
    expect(signedMoney({ amountMinor: -500, currency: 'EUR' })).toMatch(/^-/);
  });
  it('mockDiff keeps a removed no-cost activity unknown, not 0', () => {
    const base = trip();
    const act = base.days.flatMap(d => d.items).find(i => i.type === 'activity' && i.cost === null);
    if (!act) return;
    const r = applyOperations(base, [{ op: 'remove', itemId: itemIdOf(act) }]);
    if (!r.ok) throw new Error(r.reason);
    expect(mockDiff(base, r.trip).unknownCostItems).toContain(itemIdOf(act));
  });
});

describe('mock API: alternatives and patch', () => {
  it('previews without saving, applies with expectedRevision, then a stale revision is a 409', async () => {
    const mock = createMockApi();
    const api = createMockTripEditApi(mock);
    const list = await mock.listTrips();
    if (!list.ok) throw new Error('list');
    const id = list.data.items[0]!.tripId;
    const t = await api.getTrip(id);
    if (!t.ok) throw new Error('get');
    const ops: TripOperation[] = [{ op: 'remove', itemId: firstActivityId(t.data) }];
    const alt = await api.alternatives(id, { expectedRevision: t.data.revision, operations: ops });
    expect(alt.ok).toBe(true);
    if (!alt.ok) return;
    expect(AlternativesResult.safeParse(alt.data).success).toBe(true);
    const again = await api.getTrip(id);
    expect(again.ok && again.data.revision).toBe(t.data.revision);
    const cand = alt.data.candidates.find(c => c.operations !== null)!;
    const saved = await api.patch(id, { expectedRevision: alt.data.baseRevision, operations: cand.operations! });
    expect(saved.ok && saved.data.revision).toBe(t.data.revision + 1);
    const stale = await api.patch(id, { expectedRevision: alt.data.baseRevision, operations: cand.operations! });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe('REVISION_CONFLICT');
      expect(describeEditError(stale.error)).toContain('他の端末で更新されています');
    }
  });
});

describe('live client: strict bodies and CSRF', () => {
  const me = { userId: 'u1', displayName: 'x', csrfToken: 'tok-123' };
  function fakeFetch(handler: (url: string) => { status: number; body: unknown }) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fn = async (input: string, init: RequestInit = {}) => {
      calls.push({ url: input, init });
      const r = input === '/api/v1/auth/me' ? { status: 200, body: me } : handler(input);
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
    };
    return { fn: fn as unknown as typeof fetch, calls };
  }
  const header = (c: { init: RequestInit }, name: string) => (c.init.headers as Record<string, string>)[name];

  it('sends x-csrf-token on PATCH and a body that satisfies TripPatchRequest', async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 409, body: { code: 'REVISION_CONFLICT', message: 'c', retryable: false, requestId: 'r' } }));
    const r = await createLiveTripEditApi(fn).patch('t1', { expectedRevision: 3, operations: [{ op: 'set_title', title: 'x' }] });
    const write = calls.find(c => c.url === '/api/v1/trips/t1')!;
    expect(write.init.method).toBe('PATCH');
    expect(header(write, 'x-csrf-token')).toBe('tok-123');
    expect(TripPatchRequest.safeParse(JSON.parse(write.init.body as string)).success).toBe(true);
    expect(!r.ok && r.error.code).toBe('REVISION_CONFLICT');
  });
  it('sends CSRF on alternatives and a strict body', async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 500, body: {} }));
    await createLiveTripEditApi(fn).alternatives('t1', { expectedRevision: 2, operations: [{ op: 'remove', itemId: 'a' }], maxAlternatives: 3 });
    const w = calls.find(c => c.url === '/api/v1/trips/t1/alternatives')!;
    expect(header(w, 'x-csrf-token')).toBe('tok-123');
    expect(AlternativesRequest.safeParse(JSON.parse(w.init.body as string)).success).toBe(true);
  });
  it('rejects a malformed request before any network call', async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 200, body: {} }));
    const r = await createLiveTripEditApi(fn).patch('t1', { expectedRevision: 1, operations: [] });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it('rejects extra keys (strict body) and bad responses', async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 200, body: { nope: true } }));
    const bad = await createLiveTripEditApi(fn).patch('t1', { expectedRevision: 1, operations: [{ op: 'set_title', title: 'x' }], extra: 1 } as never);
    expect(bad.ok).toBe(false);
    expect(calls).toHaveLength(0);
    const r = await createLiveTripEditApi(fn).patch('t1', { expectedRevision: 1, operations: [{ op: 'set_title', title: 'x' }] });
    expect(!r.ok && r.error.code).toBe('INVALID_OUTPUT');
  });
});

describe('views', () => {
  const base = trip();
  const props = {
    trip: base, working: base, pending: [] as TripOperation[], dayIndex: 0, onDay() {}, onAdd() {}, onRemove() {}, onMove() {}, onUndo() {}, onClear() {}, onPreview() {},
    alt: { state: 'idle' } as const, onApply() {}, saved: null, error: null as ApiError | null, onReload() {}, onDismissError() {}, busy: false,
    route: { mode: 'mock', tripId: base.tripId } as const,
  };
  it('renders move/remove buttons, keyboard shortcuts, undo disabled when nothing is pending', () => {
    const html = render(<EditView {...props} />);
    expect(html).toContain('を上へ');
    expect(html).toContain('を削除');
    expect(html).toContain('aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>直前の編集を取り消す/);
    expect(html).toContain(`#/mock/trips/${base.tripId}/map`);
  });
  it('shows the 409 message with a reload button and no retry', () => {
    const err: ApiError = { code: 'REVISION_CONFLICT', message: 'x', retryable: false, requestId: 'r' };
    const html = render(<EditView {...props} error={err} />);
    expect(html).toContain('他の端末で更新されています');
    expect(html).toContain('最新の旅程を再読み込み');
    expect(render(<EditError error={err} onReload={() => {}} />)).not.toContain('再試行');
  });
  it('disables a candidate without operations and says why', () => {
    const id = firstActivityId(base);
    const c = {
      candidateId: 'c1', kind: 'swap' as const, summary: '代替', trip: base, diff: { durationDeltaSeconds: null, knownCostDelta: [], unknownCostItems: [id] },
      affectedSegments: [{ dayIndex: 0, fromItemId: id, toItemId: id, travel: 'unknown' as const }],
      validationState: 'needs_revalidation' as const, warnings: [], unknown: [], operations: null,
    };
    const html = render(<AlternativeCard c={c} titleOf={x => x} onApply={() => {}} busy={false} />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>この案を保存する/);
    expect(html).toContain('適用できません');
    expect(html).toContain('移動時間は不明');
    expect(html).toContain('費用不明');
    expect(html).not.toMatch(SHOWN_AS_ZERO);
  });
});
