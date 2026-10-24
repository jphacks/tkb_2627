/**
 * U05 typed client: K02 job status, K21 cancel, K01 resubmit (retry), K07 batch read, K08 apply.
 * Every response is validated against @tkb/contracts. Writes send the CSRF token in `x-csrf-token`
 * (/local: GET /local/v1/session, /api: GET /api/v1/auth/me). Nothing is stored in the browser.
 */
import { z } from 'zod';
import {
  ApiError, ApplyCandidateRequest, CancelResult, GenerateRequest, JobAccepted, JobStatus, LoginResponse, PlanBatch, TripWriteResult,
} from '@tkb/contracts';
import type { MockApi } from '../../mocks/index.ts';
import type { ApiResult, DataSource } from '../conditions/api.ts';

export interface GenerateFlowApi {
  readonly source: DataSource;
  getJob(jobId: string, signal?: AbortSignal): Promise<ApiResult<JobStatus>>;
  cancel(jobId: string): Promise<ApiResult<CancelResult>>;
  /** K01 again with a NEW idempotency key (retry button only). */
  generate(request: GenerateRequest, idempotencyKey: string): Promise<ApiResult<JobAccepted>>;
  getBatch(batchId: string, signal?: AbortSignal): Promise<ApiResult<PlanBatch>>;
  apply(request: ApplyCandidateRequest): Promise<ApiResult<TripWriteResult>>;
}

const LocalSession = z.object({ csrfToken: z.string().min(1), userId: z.string().nullable() });
const clientError = (code: ApiError['code'], message: string, retryable = false): ApiError => ({ code, message, retryable, requestId: 'client' });

type FetchFn = typeof fetch;

export function createLiveGenerateApi(fetchFn: FetchFn = (...a) => fetch(...a)): GenerateFlowApi {
  const source = 'live' as const;

  async function call<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<ApiResult<T>> {
    let res: Response;
    try {
      res = await fetchFn(path, { credentials: 'same-origin', ...init });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return { ok: false, error: clientError('CANCELLED', '中止しました。'), source };
      return { ok: false, error: clientError('UNAVAILABLE', `接続できません: ${e instanceof Error ? e.message : 'fetch failed'}`, true), source };
    }
    let body: unknown = null;
    try {
      body = res.status === 204 ? null : await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      const err = ApiError.safeParse(body);
      return { ok: false, error: err.success ? err.data : clientError('INTERNAL', `HTTP ${res.status}（エラー応答が契約と一致しません）`, res.status >= 500), source };
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) return { ok: false, error: clientError('INVALID_OUTPUT', '応答が契約(schema v1)と一致しません。'), source };
    return { ok: true, data: parsed.data, source };
  }

  async function csrf(scope: 'local' | 'api'): Promise<ApiResult<string>> {
    const r = scope === 'api' ? await call('/api/v1/auth/me', LoginResponse) : await call('/local/v1/session', LocalSession);
    return r.ok ? { ok: true, data: r.data.csrfToken, source } : r;
  }

  const post = (token: string, extra: Record<string, string> = {}) => ({ 'content-type': 'application/json', 'x-csrf-token': token, ...extra });
  const sig = (signal?: AbortSignal): RequestInit => (signal ? { signal } : {});
  const seg = encodeURIComponent;

  return {
    source,
    getJob: (jobId, signal) => call(`/local/v1/jobs/${seg(jobId)}`, JobStatus, sig(signal)),
    async cancel(jobId) {
      const token = await csrf('local');
      if (!token.ok) return token;
      return call(`/local/v1/jobs/${seg(jobId)}/cancel`, CancelResult, { method: 'POST', headers: post(token.data) });
    },
    async generate(request, idempotencyKey) {
      const body = GenerateRequest.safeParse(request);
      if (!body.success) return { ok: false, error: clientError('VALIDATION_FAILED', '入力が契約(K01)に適合しません。'), source };
      const token = await csrf('local');
      if (!token.ok) return token;
      return call('/local/v1/generations', JobAccepted, { method: 'POST', headers: post(token.data, { 'idempotency-key': idempotencyKey }), body: JSON.stringify(body.data) });
    },
    getBatch: (batchId, signal) => call(`/api/v1/plan-batches/${seg(batchId)}`, PlanBatch, sig(signal)),
    async apply(request) {
      const body = ApplyCandidateRequest.safeParse(request);
      if (!body.success) return { ok: false, error: clientError('VALIDATION_FAILED', '採用リクエストが契約(K08)に適合しません。'), source };
      const token = await csrf('api');
      if (!token.ok) return token;
      return call('/api/v1/trips/apply-candidate', TripWriteResult, { method: 'POST', headers: post(token.data), body: JSON.stringify(body.data) });
    },
  };
}

/** Mock client on top of the shared U01 in-memory mock (the same instance that accepted the job). */
export function createMockGenerateApi(api: MockApi): GenerateFlowApi {
  const source = 'mock' as const;
  const lift = <T>(r: { ok: true; data: T } | { ok: false; error: ApiError }): ApiResult<T> =>
    r.ok ? { ok: true, data: r.data, source } : { ok: false, error: r.error, source };
  return {
    source,
    getJob: async jobId => lift(await api.getJob(jobId)),
    cancel: async jobId => lift(await api.cancelJob(jobId)),
    generate: async (request, key) => lift(await api.generate(request, { idempotencyKey: key })),
    getBatch: async batchId => lift(await api.getPlanBatch(batchId)),
    apply: async request => lift(await api.applyCandidate(request)),
  };
}
