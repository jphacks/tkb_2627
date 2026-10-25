import { describe, expect, it } from 'vitest';
import type { GenerateRequest } from '@tkb/contracts';
import { kanazawaPlaces } from '@tkb/fixtures';
import { createMockApi } from '../../mocks/index.ts';
import { createLiveConditionsApi, createMockConditionsApi, describeError, mockPlacesFor } from './api.ts';

const request: GenerateRequest = {
  mode: 'generate',
  constraints: { area: '金沢', startDate: '2026-11-01', endDate: '2026-11-02', timeZone: 'Asia/Tokyo', transportMode: 'transit', budget: null },
};

interface Call { url: string; init: RequestInit }
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeFetch(routes: Record<string, (init: RequestInit) => Response>) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const h = routes[`${init.method ?? 'GET'} ${url}`];
    if (!h) throw new TypeError('network down');
    return h(init);
  }) as typeof fetch;
  return { fn, calls };
}

const header = (init: RequestInit, name: string) => new Headers(init.headers).get(name);

describe('U03 live client', () => {
  it('K01: fetches the local CSRF token, then posts the exact body with csrf + Idempotency-Key', async () => {
    const f = fakeFetch({
      'GET /local/v1/session': () => json(200, { csrfToken: 'local_csrf', userId: 'u1' }),
      'POST /local/v1/generations': () => json(202, { jobId: 'job_1', state: 'queued', pollAfterMs: 2000 }),
    });
    const r = await createLiveConditionsApi(f.fn).generate(request, 'u03_key_12345');
    expect(r).toEqual({ ok: true, source: 'live', data: { jobId: 'job_1', state: 'queued', pollAfterMs: 2000 } });
    const post = f.calls[1]!;
    expect(header(post.init, 'x-csrf-token')).toBe('local_csrf');
    expect(header(post.init, 'idempotency-key')).toBe('u03_key_12345');
    expect(post.init.credentials).toBe('same-origin');
    expect(JSON.parse(String(post.init.body))).toEqual(request);
  });

  it('K01: refuses a body that does not match the contract without calling the server', async () => {
    const f = fakeFetch({});
    const bad = { ...request, ownerId: 'x' } as unknown as GenerateRequest;
    const r = await createLiveConditionsApi(f.fn).generate(bad, 'u03_key_12345');
    expect(r.ok).toBe(false);
    expect(f.calls).toHaveLength(0);
  });

  it('K01: surfaces ApiError bodies (401 unpaired, 429 queue full)', async () => {
    const unpaired = fakeFetch({ 'GET /local/v1/session': () => json(401, { code: 'UNAUTHENTICATED', message: 'Pairing required.', retryable: false, requestId: 'r1' }) });
    const a = await createLiveConditionsApi(unpaired.fn).generate(request, 'u03_key_12345');
    expect(a.ok ? null : a.error.code).toBe('UNAUTHENTICATED');
    expect(unpaired.calls).toHaveLength(1);

    const full = fakeFetch({
      'GET /local/v1/session': () => json(200, { csrfToken: 't', userId: 'u1' }),
      'POST /local/v1/generations': () => json(429, { code: 'QUEUE_FULL', message: 'Queue is full.', retryable: true, requestId: 'r2' }),
    });
    const b = await createLiveConditionsApi(full.fn).generate(request, 'u03_key_12345');
    expect(b.ok ? null : b.error).toMatchObject({ code: 'QUEUE_FULL', retryable: true, requestId: 'r2' });
  });

  it('rejects a 2xx response that does not match the contract, and a non-contract error body', async () => {
    const f = fakeFetch({
      'GET /local/v1/session': () => json(200, { csrfToken: 't', userId: 'u1' }),
      'POST /local/v1/generations': () => json(202, { jobId: 'job_1', state: 'running', pollAfterMs: 2000 }),
    });
    const r = await createLiveConditionsApi(f.fn).generate(request, 'u03_key_12345');
    expect(r.ok ? null : r.error.code).toBe('INVALID_OUTPUT');

    const g = fakeFetch({ 'GET /local/v1/capabilities': () => new Response('<html>', { status: 502 }) });
    const c = await createLiveConditionsApi(g.fn).capabilities();
    expect(c.ok ? null : c.error).toMatchObject({ code: 'INTERNAL', retryable: true });
  });

  it('network failure becomes a retryable UNAVAILABLE', async () => {
    const r = await createLiveConditionsApi(fakeFetch({}).fn).capabilities();
    expect(r.ok ? null : r.error).toMatchObject({ code: 'UNAVAILABLE', retryable: true });
  });

  it('K05: uses the shared CSRF token from /auth/me and validates places', async () => {
    const f = fakeFetch({
      'GET /api/v1/auth/me': () => json(200, { userId: 'u1', displayName: 'A', csrfToken: 'shared_csrf' }),
      'POST /api/v1/planning-context': () => json(200, { places: kanazawaPlaces, legs: [], unknown: ['fare'], dataMode: 'fixture' }),
    });
    const r = await createLiveConditionsApi(f.fn).planningContext({ area: '金沢', transportMode: 'car', maxPlaces: 15, timeZone: 'Asia/Tokyo' });
    expect(r.ok && r.data.places.map(p => p.placeId)).toEqual(kanazawaPlaces.map(p => p.placeId));
    const post = f.calls[1]!;
    expect(header(post.init, 'x-csrf-token')).toBe('shared_csrf');
    expect(JSON.parse(String(post.init.body))).toEqual({ area: '金沢', transportMode: 'car', maxPlaces: 15, timeZone: 'Asia/Tokyo' });
  });

  it('K05: maps provider errors', async () => {
    const f = fakeFetch({
      'GET /api/v1/auth/me': () => json(200, { userId: 'u1', displayName: 'A', csrfToken: 's' }),
      'POST /api/v1/planning-context': () => json(422, { code: 'PROVIDER_UNSUPPORTED_REGION', message: 'x', retryable: false, requestId: 'r' }),
    });
    const r = await createLiveConditionsApi(f.fn).planningContext({ area: 'どこか', transportMode: 'transit' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(describeError(r.error)).toMatch(/対応していません/);
  });
});

describe('U03 mock client', () => {
  it('reports AI unavailable with a reason when asked', async () => {
    const api = createMockConditionsApi(createMockApi(), 'normal', { aiAvailable: false });
    const r = await api.capabilities();
    expect(r.ok && r.data.aiGeneration).toEqual({ available: false, runner: 'none', reason: 'CLAUDE_EXECUTION_DISABLED' });
  });

  it('searches fixture places by area and never invents places for unknown areas', async () => {
    const api = createMockConditionsApi(createMockApi(), 'normal');
    const r = await api.planningContext({ area: '金沢', transportMode: 'transit', maxPlaces: 3 });
    expect(r.ok && r.data.places).toHaveLength(3);
    expect(mockPlacesFor('Atlantis')).toEqual([]);
    const e = await createMockConditionsApi(createMockApi(), 'error').planningContext({ area: '金沢', transportMode: 'transit' });
    expect(e.ok ? null : e.error.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('generate returns the same job for the same Idempotency-Key and body', async () => {
    const api = createMockConditionsApi(createMockApi(), 'normal');
    const a = await api.generate(request, 'u03_key_12345');
    const b = await api.generate(request, 'u03_key_12345');
    expect(a.ok && b.ok && a.data.jobId === b.data.jobId).toBe(true);
    const c = await api.generate({ ...request, constraints: { ...request.constraints, area: 'パリ' } }, 'u03_key_12345');
    expect(c.ok ? null : c.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });
});

describe('capabilities when the personal entry is not reachable (review / LAN mode)', () => {
  it('falls back to the shared capabilities and its reason instead of a contract error', async () => {
    const { createLiveConditionsApi } = await import('./api.ts');
    const shared = { entry: 'shared', aiGeneration: { available: false, runner: 'none', reason: 'SHARED_ENTRY_NO_PERSONAL_CLAUDE' }, storage: 'shared-server', dataMode: 'fixture', schemaVersion: 1 };
    const fetchFn = (async (url: string) => url.startsWith('/local/')
      ? new Response('<!doctype html><div id="root"></div>', { status: 200, headers: { 'content-type': 'text/html' } })
      : new Response(JSON.stringify(shared), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const r = await createLiveConditionsApi(fetchFn).capabilities();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.aiGeneration.reason).toBe('SHARED_ENTRY_NO_PERSONAL_CLAUDE');
  });
});
