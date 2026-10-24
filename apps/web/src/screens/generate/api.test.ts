import { describe, expect, it } from 'vitest';
import type { GenerateRequest } from '@tkb/contracts';
import { createMockApi } from '../../mocks/index.ts';
import { createLiveGenerateApi, createMockGenerateApi } from './api.ts';

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
const request: GenerateRequest = {
  mode: 'generate',
  constraints: { area: '金沢', startDate: '2026-11-01', endDate: '2026-11-02', timeZone: 'Asia/Tokyo', transportMode: 'transit', budget: null },
};

describe('U05 live client', () => {
  it('K02: validates JobStatus; contract violations become INVALID_OUTPUT', async () => {
    const ok = fakeFetch({ 'GET /local/v1/jobs/job_1': () => json(200, { jobId: 'job_1', state: 'running', stage: 'generating', batchId: null, error: null, updatedAt: '2026-11-01T00:00:00Z' }) });
    expect((await createLiveGenerateApi(ok.fn).getJob('job_1')).ok).toBe(true);
    const bad = fakeFetch({ 'GET /local/v1/jobs/job_1': () => json(200, { jobId: 'job_1', state: 'succeeded', stage: 'done', batchId: null, error: null, updatedAt: '2026-11-01T00:00:00Z' }) });
    const r = await createLiveGenerateApi(bad.fn).getJob('job_1');
    expect(r.ok ? null : r.error.code).toBe('INVALID_OUTPUT');
  });

  it('K21: cancel sends the local CSRF token', async () => {
    const f = fakeFetch({
      'GET /local/v1/session': () => json(200, { csrfToken: 'local_csrf', userId: 'u1' }),
      'POST /local/v1/jobs/job_1/cancel': () => json(202, { jobId: 'job_1', state: 'cancelled', batchId: null }),
    });
    const r = await createLiveGenerateApi(f.fn).cancel('job_1');
    expect(r.ok).toBe(true);
    expect(header(f.calls[1]!.init, 'x-csrf-token')).toBe('local_csrf');
  });

  it('K01 retry: new Idempotency-Key and CSRF header are sent', async () => {
    const f = fakeFetch({
      'GET /local/v1/session': () => json(200, { csrfToken: 'local_csrf', userId: 'u1' }),
      'POST /local/v1/generations': () => json(202, { jobId: 'job_2', state: 'queued', pollAfterMs: 1000 }),
    });
    await createLiveGenerateApi(f.fn).generate(request, 'u05_new_key_1');
    expect(header(f.calls[1]!.init, 'idempotency-key')).toBe('u05_new_key_1');
    expect(header(f.calls[1]!.init, 'x-csrf-token')).toBe('local_csrf');
  });

  it('K08: apply posts the strict body with the /api CSRF token; 410 is passed through', async () => {
    const f = fakeFetch({
      'GET /api/v1/auth/me': () => json(200, { userId: 'u1', displayName: 'a', csrfToken: 'api_csrf' }),
      'POST /api/v1/trips/apply-candidate': () => json(410, { code: 'EXPIRED', message: 'expired', retryable: false, requestId: 'r1' }),
    });
    const body = { batchId: 'b1', candidateId: 'c1', tripId: null, expectedRevision: null };
    const r = await createLiveGenerateApi(f.fn).apply(body);
    const post = f.calls.find(c => c.url === '/api/v1/trips/apply-candidate')!;
    expect(header(post.init, 'x-csrf-token')).toBe('api_csrf');
    expect(JSON.parse(String(post.init.body))).toEqual(body);
    expect(r.ok ? null : r.error.code).toBe('EXPIRED');
  });

  it('K08: a body with extra fields never reaches the network', async () => {
    const f = fakeFetch({});
    const r = await createLiveGenerateApi(f.fn).apply({ batchId: 'b1', candidateId: 'c1', tripId: null, expectedRevision: null, ownerId: 'x' } as never);
    expect(r.ok).toBe(false);
    expect(f.calls).toHaveLength(0);
  });

  it('a failing network becomes a retryable UNAVAILABLE', async () => {
    const r = await createLiveGenerateApi(fakeFetch({}).fn).getJob('job_1');
    expect(r.ok ? null : r.error).toMatchObject({ code: 'UNAVAILABLE', retryable: true });
  });
});

describe('U05 mock client: generate -> poll -> batch -> apply -> cancel', () => {
  it('runs the whole happy path on the shared mock', async () => {
    const api = createMockGenerateApi(createMockApi());
    const acc = await api.generate(request, 'u05_key_1234');
    if (!acc.ok) throw new Error('generate');
    let batchId: string | null = null;
    for (let i = 0; i < 20 && !batchId; i++) {
      const j = await api.getJob(acc.data.jobId);
      if (j.ok) batchId = j.data.batchId;
    }
    expect(batchId).not.toBeNull();
    const batch = await api.getBatch(batchId!);
    if (!batch.ok) throw new Error('batch');
    const applied = await api.apply({ batchId: batchId!, candidateId: batch.data.candidates[0]!.candidateId, tripId: null, expectedRevision: null });
    expect(applied.ok && applied.data.tripId).toBeTruthy();
  });

  it('cancel moves a queued job to cancelled and polling then reports cancelled', async () => {
    const api = createMockGenerateApi(createMockApi());
    const acc = await api.generate(request, 'u05_key_5678');
    if (!acc.ok) throw new Error('generate');
    const c = await api.cancel(acc.data.jobId);
    expect(c.ok && c.data.state).toBe('cancelled');
    const j = await api.getJob(acc.data.jobId);
    expect(j.ok && j.data.state).toBe('cancelled');
  });
});
