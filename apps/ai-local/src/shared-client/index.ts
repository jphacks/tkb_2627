import { ApiError, Capabilities, Id, LoginRequest, LoginResponse, PlanBatchCreated, PlanningContext, type DataMode, type ErrorCode, type PlanBatchCreate, type PlanningContextRequest } from '@tkb/contracts';
import type { UpstreamSession } from '../auth/session.ts';

/** The only upstream paths this process may call. Clients never choose a URL or path. */
export const UPSTREAM_PATHS = { login: '/api/v1/auth/login' } as const;

/** K07 path (fixed, allowlisted). Kept apart from the login client so the K11 login proxy surface stays login-only. */
export const UPSTREAM_PLAN_PATHS = { planBatches: '/api/v1/plan-batches' } as const;

/** K05 path (fixed, allowlisted). Its own client so the login proxy and the K07 client keep their small surfaces. */
export const UPSTREAM_CONTEXT_PATHS = { planningContext: '/api/v1/planning-context' } as const;

/** Public capabilities path of the shared server (fixed, allowlisted; no session needed). */
export const UPSTREAM_CAPABILITIES_PATHS = { capabilities: '/api/v1/capabilities' } as const;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type LoginOutcome =
  | { ok: true; userId: string; displayName: string; csrfToken: string; cookie: string }
  | { ok: false; code: ErrorCode; retryable: boolean };

/** Anything holding the owner's upstream session (a LocalSession). 401 clears `upstream`. */
export interface UpstreamHolder {
  upstream: UpstreamSession | null;
}

export type SaveOutcome = { ok: true; batchId: string } | { ok: false; code: ErrorCode; retryable: boolean };

export interface SharedClient {
  login(body: LoginRequest): Promise<LoginOutcome>;
}

export interface PlanBatchClient {
  /** K07 save. Idempotent on (owner, generationId) server-side. */
  savePlanBatch(session: UpstreamHolder, body: PlanBatchCreate): Promise<SaveOutcome>;
  /**
   * K07 lookup by generationId. Resolves batchId, or null when no such batch (404).
   * Throws on any other failure (incl. no upstream session / 401) so callers treat it as an unknown outcome.
   */
  findPlanBatchByGenerationId(session: UpstreamHolder, generationId: string): Promise<string | null>;
}

function codeOf(status: number, body: unknown): ErrorCode {
  const e = ApiError.safeParse(body);
  if (e.success && [409, 422, 403, 404, 410].includes(status)) return e.data.code;
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'IDEMPOTENCY_CONFLICT';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 400 || status === 422) return 'VALIDATION_FAILED';
  return 'UNAVAILABLE';
}

const defaultFetch: FetchLike = (u, i) => fetch(u, i);

export function createSharedClient(opts: { baseUrl: string; fetch?: FetchLike; timeoutMs?: number }): SharedClient {
  const doFetch: FetchLike = opts.fetch ?? defaultFetch;
  const base = opts.baseUrl.replace(/\/+$/, '');
  return {
    async login(body) {
      let res: Response;
      try {
        res = await doFetch(`${base}${UPSTREAM_PATHS.login}`, {
          method: 'POST',
          // Only content-type is sent: never client cookies or other headers.
          // No Origin either: S02 accepts Origin-less requests. If S02 starts requiring it, send the fixed shared origin.
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          redirect: 'manual',
          signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
        });
      } catch {
        return { ok: false, code: 'UNAVAILABLE', retryable: true };
      }
      if (res.status === 401) return { ok: false, code: 'UNAUTHENTICATED', retryable: false };
      if (res.status === 429) return { ok: false, code: 'RATE_LIMITED', retryable: true };
      if (res.status === 400 || res.status === 422) return { ok: false, code: 'VALIDATION_FAILED', retryable: false };
      if (res.status !== 200) return { ok: false, code: 'UNAVAILABLE', retryable: true };
      try {
        const parsed = LoginResponse.parse(await res.json());
        const cookie = res.headers.getSetCookie().map(c => c.split(';')[0]!.trim()).filter(Boolean).join('; ');
        if (!cookie) return { ok: false, code: 'UNAVAILABLE', retryable: true };
        return { ok: true, ...parsed, cookie };
      } catch {
        return { ok: false, code: 'UNAVAILABLE', retryable: true };
      }
    },
  };
}

export function createPlanBatchClient(opts: { baseUrl: string; fetch?: FetchLike; timeoutMs?: number }): PlanBatchClient {
  const doFetch: FetchLike = opts.fetch ?? defaultFetch;
  const base = opts.baseUrl.replace(/\/+$/, '');
  // Only the stored upstream cookie + upstream csrf are sent. No client cookie, no Origin (S02 accepts Origin-less requests).
  const upstreamHeaders = (u: UpstreamSession, json: boolean): Record<string, string> => ({
    ...(json ? { 'content-type': 'application/json' } : {}),
    cookie: u.cookie,
    'x-csrf-token': u.csrfToken,
  });
  const timeout = () => AbortSignal.timeout(opts.timeoutMs ?? 10_000);
  return {
    async savePlanBatch(session, body) {
      const u = session.upstream;
      if (!u) return { ok: false, code: 'UNAUTHENTICATED', retryable: false };
      let res: Response;
      try {
        res = await doFetch(`${base}${UPSTREAM_PLAN_PATHS.planBatches}`, {
          method: 'POST',
          headers: upstreamHeaders(u, true),
          body: JSON.stringify(body),
          redirect: 'manual',
          signal: timeout(),
        });
      } catch {
        return { ok: false, code: 'UNAVAILABLE', retryable: true };
      }
      if (res.status === 200 || res.status === 201) {
        try {
          return { ok: true, batchId: PlanBatchCreated.parse(await res.json()).batchId };
        } catch {
          return { ok: false, code: 'UNAVAILABLE', retryable: true };
        }
      }
      if (res.status === 401) {
        session.upstream = null;
        return { ok: false, code: 'UNAUTHENTICATED', retryable: false };
      }
      const json: unknown = await res.json().catch(() => null);
      const code = codeOf(res.status, json);
      return { ok: false, code, retryable: res.status === 429 || res.status >= 500 };
    },
    async findPlanBatchByGenerationId(session, generationId) {
      const u = session.upstream;
      if (!u) throw new Error('no upstream session');
      const gid = Id.parse(generationId);
      const res = await doFetch(`${base}${UPSTREAM_PLAN_PATHS.planBatches}?generationId=${encodeURIComponent(gid)}`, {
        method: 'GET',
        headers: upstreamHeaders(u, false),
        redirect: 'manual',
        signal: timeout(),
      });
      if (res.status === 404) return null;
      if (res.status === 401) {
        session.upstream = null;
        throw new Error('upstream session expired');
      }
      if (res.status !== 200) throw new Error(`lookup failed: ${res.status}`);
      return Id.parse(((await res.json()) as { batchId?: unknown }).batchId);
    },
  };
}

export type ContextOutcome = { ok: true; context: PlanningContext } | { ok: false; code: ErrorCode; retryable: boolean };

export interface ContextClient {
  /** K05 for the owner's own upstream session. `signal` is the job's: cancelling the job cancels the call. */
  getPlanningContext(session: UpstreamHolder, body: PlanningContextRequest, signal?: AbortSignal): Promise<ContextOutcome>;
}

export function createContextClient(opts: { baseUrl: string; fetch?: FetchLike; timeoutMs?: number }): ContextClient {
  const doFetch: FetchLike = opts.fetch ?? defaultFetch;
  const base = opts.baseUrl.replace(/\/+$/, '');
  return {
    async getPlanningContext(session, body, signal) {
      const u = session.upstream;
      if (!u) return { ok: false, code: 'UNAUTHENTICATED', retryable: false };
      const timeout = AbortSignal.timeout(opts.timeoutMs ?? 60_000);
      let res: Response;
      try {
        res = await doFetch(`${base}${UPSTREAM_CONTEXT_PATHS.planningContext}`, {
          method: 'POST',
          // Only the stored upstream cookie + upstream csrf; nothing from the local client is forwarded.
          headers: { 'content-type': 'application/json', cookie: u.cookie, 'x-csrf-token': u.csrfToken },
          body: JSON.stringify(body),
          redirect: 'manual',
          signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
        });
      } catch {
        return signal?.aborted ? { ok: false, code: 'CANCELLED', retryable: false } : { ok: false, code: 'PROVIDER_UNAVAILABLE', retryable: true };
      }
      if (res.status === 200) {
        try {
          return { ok: true, context: PlanningContext.parse(await res.json()) };
        } catch {
          return { ok: false, code: 'PROVIDER_UNAVAILABLE', retryable: true };
        }
      }
      if (res.status === 401) {
        session.upstream = null;
        return { ok: false, code: 'UNAUTHENTICATED', retryable: false };
      }
      const err = ApiError.safeParse(await res.json().catch(() => null));
      const code = err.success ? err.data.code : null;
      if (res.status === 422) return { ok: false, code: code === 'PROVIDER_UNSUPPORTED_REGION' ? code : 'VALIDATION_FAILED', retryable: false };
      if (res.status === 429) {
        return code === 'PROVIDER_RATE_LIMIT' ? { ok: false, code, retryable: false } : { ok: false, code: 'RATE_LIMITED', retryable: true };
      }
      return { ok: false, code: 'PROVIDER_UNAVAILABLE', retryable: true };
    },
  };
}

export interface SharedCapabilitiesClient {
  /** The shared server's real dataMode (cached), or null when it cannot be read (the caller says what it falls back to). */
  getDataMode(): Promise<DataMode | null>;
}

/** GET of one fixed public path with manual redirects. Successful answers are cached for `ttlMs` (default 60 s), failures for 10 s; the body is capped at 64 KB. */
export function createCapabilitiesClient(opts: { baseUrl: string; fetch?: FetchLike; timeoutMs?: number; ttlMs?: number; failureTtlMs?: number; now?: () => number }): SharedCapabilitiesClient {
  const doFetch: FetchLike = opts.fetch ?? defaultFetch;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? 60_000;
  const failureTtl = opts.failureTtlMs ?? 10_000;
  let cached: { mode: DataMode; at: number } | null = null;
  let failedAt: number | null = null;
  const MAX_BODY = 64 * 1024;
  return {
    async getDataMode() {
      if (cached && now() - cached.at < ttl) return cached.mode;
      // A failure is remembered briefly so an unreachable server is not asked on every capabilities call.
      if (failedAt !== null && now() - failedAt < failureTtl) return null;
      failedAt = now();
      try {
        const res = await doFetch(`${base}${UPSTREAM_CAPABILITIES_PATHS.capabilities}`, {
          method: 'GET',
          headers: {},
          redirect: 'manual',
          signal: AbortSignal.timeout(opts.timeoutMs ?? 3_000),
        });
        if (res.status !== 200) return null;
        if (Number(res.headers.get('content-length') ?? 0) > MAX_BODY) return null;
        const text = await res.text();
        if (text.length > MAX_BODY) return null;
        const mode = Capabilities.parse(JSON.parse(text)).dataMode;
        cached = { mode, at: now() };
        failedAt = null;
        return mode;
      } catch {
        return null;
      }
    },
  };
}
