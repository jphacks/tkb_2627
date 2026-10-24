import type { ReactElement } from 'react';
import { renderToString as renderRaw } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReplanRequest, ReplanResult, type ReplanCandidate, type Trip } from '@tkb/contracts';
import { domesticTrip } from '@tkb/fixtures';
import { createMockApi } from '../../mocks/index.ts';
import { createLiveTripEditApi, createMockTripEditApi } from '../edit/api.ts';
import { CONFLICT_LABEL, CONSENT_TEXT, TravelView } from './TravelScreen.tsx';
import { SKIPPED, buildReplanRequest, requestLocation, type GeoLike } from './geo.ts';

const render = (el: ReactElement): string => renderRaw(el).replace(/<!-- -->/g, '');
const base: Trip = structuredClone(domesticTrip);
const actId = (): string => {
  for (const d of base.days) for (const i of d.items) if (i.type === 'activity') return i.activityId;
  throw new Error('no activity');
};
const none = new Set<string>();

afterEach(() => vi.unstubAllGlobals());

describe('geolocation choice', () => {
  it('denied / error / unsupported / skipped all become unavailable, with no coordinates', async () => {
    const mk = (code: number): GeoLike => ({ getCurrentPosition: (_ok, fail) => fail({ code }) });
    expect(await requestLocation(mk(1))).toEqual({ kind: 'unavailable', reason: 'denied' });
    expect(await requestLocation(mk(2))).toEqual({ kind: 'unavailable', reason: 'error' });
    expect(await requestLocation(null)).toEqual({ kind: 'unavailable', reason: 'error' });
    expect(await requestLocation({ getCurrentPosition: () => { throw new Error('boom'); } })).toEqual({ kind: 'unavailable', reason: 'error' });
    expect(SKIPPED).toEqual({ kind: 'unavailable', reason: 'skipped' });
    const req = buildReplanRequest({ expectedRevision: 3, location: await requestLocation(mk(1)), completed: none, pinned: none, missed: none });
    expect(JSON.stringify(req)).not.toMatch(/lat|lng/);
    expect(ReplanRequest.safeParse(req).success).toBe(true);
  });
  it('coordinates are sent only when the geolocation call succeeds', async () => {
    const geo: GeoLike = { getCurrentPosition: ok => ok({ coords: { latitude: 36.5, longitude: 136.6 } }) };
    const loc = await requestLocation(geo);
    expect(loc).toEqual({ kind: 'coords', point: { lat: 36.5, lng: 136.6 } });
    expect(buildReplanRequest({ expectedRevision: 1, location: loc, completed: new Set(['a']), pinned: new Set(['b']), missed: none })).toMatchObject({
      completedActivityIds: ['a'], fixedActivityIds: ['b'], missedActivityIds: [],
    });
  });
  it('never touches browser storage', async () => {
    const store = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() };
    vi.stubGlobal('localStorage', store);
    vi.stubGlobal('sessionStorage', store);
    await requestLocation({ getCurrentPosition: ok => ok({ coords: { latitude: 1, longitude: 2 } }) });
    buildReplanRequest({ expectedRevision: 1, location: { kind: 'coords', point: { lat: 1, lng: 2 } }, completed: none, pinned: none, missed: none });
    expect(store.setItem).not.toHaveBeenCalled();
    expect(store.getItem).not.toHaveBeenCalled();
  });
  it('the consent text says nothing is stored or shown', () => {
    expect(CONSENT_TEXT).toContain('保存せず');
    expect(CONSENT_TEXT).toContain('許可');
  });
});

describe('replan through the live client', () => {
  it('sends CSRF and a strictly valid body with unavailable location', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fn = (async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const me = url === '/api/v1/auth/me';
      const body = me ? { userId: 'u', displayName: 'x', csrfToken: 'csrf-1' } : { code: 'REVISION_CONFLICT', message: 'c', retryable: false, requestId: 'r' };
      return new Response(JSON.stringify(body), { status: me ? 200 : 409, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const req = buildReplanRequest({ expectedRevision: 2, location: { kind: 'unavailable', reason: 'denied' }, completed: none, pinned: none, missed: none });
    const r = await createLiveTripEditApi(fn).replan('t1', req);
    const w = calls.find(c => c.url === '/api/v1/trips/t1/replan')!;
    expect((w.init.headers as Record<string, string>)['x-csrf-token']).toBe('csrf-1');
    const sent = JSON.parse(w.init.body as string);
    expect(sent.location).toEqual({ kind: 'unavailable', reason: 'denied' });
    expect(ReplanRequest.safeParse(sent).success).toBe(true);
    expect(!r.ok && r.error.code).toBe('REVISION_CONFLICT');
  });
});

describe('mock replan then apply', () => {
  it('previews, applies via PATCH operations, and a stale revision gives 409', async () => {
    const mock = createMockApi();
    const api = createMockTripEditApi(mock);
    const list = await mock.listTrips();
    if (!list.ok) throw new Error('list');
    const id = list.data.items[0]!.tripId;
    const t = await api.getTrip(id);
    if (!t.ok) throw new Error('get');
    const req = buildReplanRequest({ expectedRevision: t.data.revision, location: SKIPPED, completed: none, pinned: none, missed: none });
    const r = await api.replan(id, req);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(ReplanResult.safeParse(r.data).success).toBe(true);
    const ops = r.data.candidates[0]!.operations;
    expect(ops).not.toBeNull();
    const saved = await api.patch(id, { expectedRevision: r.data.baseRevision, operations: ops! });
    expect(saved.ok && saved.data.revision).toBe(t.data.revision + 1);
    const stale = await api.patch(id, { expectedRevision: r.data.baseRevision, operations: ops! });
    expect(!stale.ok && stale.error.code).toBe('REVISION_CONFLICT');
  });
});

describe('TravelView', () => {
  type ReplanProp = Parameters<typeof TravelView>[0]['replan'];
  const candidate = (over: Partial<ReplanCandidate> = {}): ReplanCandidate => ({
    candidateId: 'rc1', kind: 'keep_order', summary: '順番そのまま', trip: base, diff: { durationDeltaSeconds: null, knownCostDelta: [], unknownCostItems: [actId()] },
    validationState: 'needs_revalidation', warnings: [], unknown: [], operations: null, kept: { completed: [], fixed: [] }, retimed: [],
    untimed: [{ activityId: actId(), reason: '時刻不明' }],
    reservationConflicts: (['missed', 'unreachable', 'travel_unknown', 'time_unknown'] as const).map(reason => ({ activityId: actId(), reason })),
    ...over,
  });
  const props = {
    trip: base, route: { mode: 'server', tripId: base.tripId } as const, dayIndex: 0, onDay() {}, completed: none, pinned: none, missed: none, onToggle() {}, onReplan() {},
    replan: { state: 'idle' } as ReplanProp, onApply() {}, saved: null, error: null, onReload() {}, onDismissError() {}, busy: false,
  };

  it('renders location choices with consent text and no coordinate display', () => {
    const html = render(<TravelView {...props} />);
    expect(html).toContain('現在地を使って再計画');
    expect(html).toContain('現在地を使わずに再計画');
    expect(html).toContain('座標は保存せず');
    expect(html).toContain('完了にする');
    expect(html).toContain(`#/trips/${base.tripId}/map`);
  });
  it('shows conflicts, untimed items, unknown costs, and a disabled apply when operations are null', () => {
    const result = { tripId: base.tripId, baseRevision: base.revision, now: '2026-11-01T01:00:00Z', dayIndex: 0, start: { kind: 'none' as const, placeId: null }, startLeg: null, candidates: [candidate()] };
    const html = render(<TravelView {...props} replan={{ state: 'ok', result }} />);
    for (const label of Object.values(CONFLICT_LABEL)) expect(html).toContain(label);
    expect(html).toContain('時刻未定のまま');
    expect(html).toContain('費用不明');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>この再計画を保存する/);
    expect(html).toContain('現在地から次の予定までの移動: 不明');
  });
  it('shows the 409 message and reload', () => {
    const html = render(<TravelView {...props} error={{ code: 'REVISION_CONFLICT', message: 'm', retryable: false, requestId: 'r' }} />);
    expect(html).toContain('他の端末で更新されています');
    expect(html).toContain('最新の旅程を再読み込み');
  });
});
