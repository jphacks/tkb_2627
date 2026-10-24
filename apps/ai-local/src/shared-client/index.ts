import { LoginRequest, LoginResponse, type ErrorCode } from '@tkb/contracts';

/** The only upstream paths this process may call. Clients never choose a URL or path. */
export const UPSTREAM_PATHS = { login: '/api/v1/auth/login' } as const;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type LoginOutcome =
  | { ok: true; userId: string; displayName: string; csrfToken: string; cookie: string }
  | { ok: false; code: ErrorCode; retryable: boolean };

export interface SharedClient {
  login(body: LoginRequest): Promise<LoginOutcome>;
}

export function createSharedClient(opts: { baseUrl: string; fetch?: FetchLike; timeoutMs?: number }): SharedClient {
  const doFetch: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i));
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
