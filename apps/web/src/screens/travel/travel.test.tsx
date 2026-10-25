import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReplanRequest, ReplanResult } from '@tkb/contracts';
import { createMockApi } from '../../mocks/index.ts';
import { createLiveTripEditApi, createMockTripEditApi } from '../edit/api.ts';
import { SKIPPED, buildReplanRequest, requestLocation, type GeoLike } from './geo.ts';

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
