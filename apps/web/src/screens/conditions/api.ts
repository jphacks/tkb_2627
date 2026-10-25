/**
 * U03 typed client: K22 capabilities (personal entry), K05 planning-context (shared) and K01 generations
 * (personal). Every response is validated against @tkb/contracts; error bodies against ApiError.
 * State-changing calls send the session's CSRF token in `x-csrf-token`:
 *   - /api   : token from GET /api/v1/auth/me (LoginResponse.csrfToken)
 *   - /local : token from GET /local/v1/session ({ csrfToken, userId })
 * Cookies stay HttpOnly and same-origin (vite proxy); nothing is stored in the browser.
 */
import { z } from 'zod';
import { ApiError, Capabilities, GenerateRequest, JobAccepted, LoginResponse, PlanningContext, PlanningContextRequest } from '@tkb/contracts';
import { kanazawaPlaces, parisPlaces } from '@tkb/fixtures';
import type { MockApi, MockScenario } from '../../mocks/index.ts';

export type DataSource = 'live' | 'mock';

export type ApiResult<T> =
  | { ok: true; data: T; source: DataSource }
  | { ok: false; error: ApiError; source: DataSource };

export interface ConditionsApi {
  readonly source: DataSource;
  /** K22 GET /local/v1/capabilities: whether the personal entry can generate now. */
  capabilities(): Promise<ApiResult<Capabilities>>;
  /** K05 POST /api/v1/planning-context: place search for must-visit selection. */
  planningContext(request: z.input<typeof PlanningContextRequest>, signal?: AbortSignal): Promise<ApiResult<PlanningContext>>;
  /** K01 POST /local/v1/generations with the Idempotency-Key header. */
  generate(request: GenerateRequest, idempotencyKey: string): Promise<ApiResult<JobAccepted>>;
}

const LocalSession = z.object({ csrfToken: z.string().min(1), userId: z.string().nullable() });

const clientError = (code: ApiError['code'], message: string, retryable = false): ApiError => ({
  code,
  message,
  retryable,
  requestId: 'client',
});

type FetchFn = typeof fetch;

/** Japanese explanation of an error code for the screen (the server message stays in English). */
export function describeError(error: ApiError): string {
  switch (error.code) {
    case 'UNAUTHENTICATED':
      return 'ログインが必要です（本人用アプリのペアリングと共有サーバーへのログインを確認してください）。';
    case 'FORBIDDEN':
      return '操作が拒否されました（セッションまたはCSRFトークンが無効です。再読み込みしてください）。';
    case 'VALIDATION_FAILED':
      return '入力が受け付けられませんでした。';
    case 'IDEMPOTENCY_CONFLICT':
      return '同じ送信キーが別の入力で使われました。もう一度送信してください。';
    case 'QUEUE_FULL':
      return '生成の待ち行列がいっぱいです。しばらくしてから再試行してください。';
    case 'RATE_LIMITED':
    case 'PROVIDER_RATE_LIMIT':
      return '利用回数の上限に達しました。しばらくしてから再試行してください。';
    case 'PROVIDER_UNSUPPORTED_REGION':
      return 'この地域の地点検索には対応していません。';
    case 'PROVIDER_UNAVAILABLE':
    case 'UNAVAILABLE':
      return '情報源に接続できません。';
    case 'AI_UNAVAILABLE':
      return 'AI生成は現在利用できません。';
    default:
      return error.message;
  }
}

/** Real client over the vite proxy (/api -> shared server, /local -> personal app server). */
export function createLiveConditionsApi(fetchFn: FetchFn = (...a) => fetch(...a)): ConditionsApi {
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
      return {
        ok: false,
        error: err.success ? err.data : clientError('INTERNAL', `HTTP ${res.status}（エラー応答が契約と一致しません）`, res.status >= 500),
        source,
      };
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) return { ok: false, error: clientError('INVALID_OUTPUT', '応答が契約(schema v1)と一致しません。'), source };
    return { ok: true, data: parsed.data, source };
  }

  async function csrf(path: '/api/v1/auth/me' | '/local/v1/session'): Promise<ApiResult<string>> {
    const r = path === '/api/v1/auth/me' ? await call(path, LoginResponse) : await call(path, LocalSession);
    return r.ok ? { ok: true, data: r.data.csrfToken, source } : r;
  }

  return {
    source,
    // When the personal entry (4311) is not reachable from this page (review/LAN mode, or not running), fall back to the
    // shared capabilities, which explain why AI generation is unavailable (e.g. SHARED_ENTRY_NO_PERSONAL_CLAUDE) instead of
    // showing a raw contract error. Generation itself still only ever goes to the personal entry.
    capabilities: async () => {
      const personal = await call('/local/v1/capabilities', Capabilities);
      if (personal.ok) return personal;
      const shared = await call('/api/v1/capabilities', Capabilities);
      return shared.ok ? shared : personal;
    },
    async planningContext(request, signal) {
      const body = PlanningContextRequest.safeParse(request);
      if (!body.success) return { ok: false, error: clientError('VALIDATION_FAILED', '検索条件が契約(K05)に適合しません。'), source };
      const token = await csrf('/api/v1/auth/me');
      if (!token.ok) return token;
      return call('/api/v1/planning-context', PlanningContext, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': token.data },
        body: JSON.stringify(body.data),
        ...(signal ? { signal } : {}),
      });
    },
    async generate(request, idempotencyKey) {
      const body = GenerateRequest.safeParse(request);
      if (!body.success) return { ok: false, error: clientError('VALIDATION_FAILED', '入力が契約(K01)に適合しません。'), source };
      const token = await csrf('/local/v1/session');
      if (!token.ok) return token;
      return call('/local/v1/generations', JobAccepted, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': token.data, 'idempotency-key': idempotencyKey },
        body: JSON.stringify(body.data),
      });
    },
  };
}

/** Fixture places for the mock search, by area keyword. Unknown areas return no places (never invented). */
export function mockPlacesFor(area: string) {
  const a = area.trim();
  if (/金沢|kanazawa/i.test(a)) return kanazawaPlaces;
  if (/パリ|paris/i.test(a)) return parisPlaces;
  return [];
}

/** Mock client on top of the U01 in-memory mock API. Nothing is sent over the network. */
export function createMockConditionsApi(api: MockApi, scenario: MockScenario, options: { aiAvailable?: boolean } = {}): ConditionsApi {
  const source = 'mock' as const;
  const aiAvailable = options.aiAvailable ?? true;
  return {
    source,
    async capabilities() {
      return {
        ok: true,
        source,
        data: Capabilities.parse({
          entry: 'personal',
          aiGeneration: aiAvailable
            ? { available: true, runner: 'fake', reason: null }
            : { available: false, runner: 'none', reason: 'CLAUDE_EXECUTION_DISABLED' },
          storage: 'shared-server',
          dataMode: 'fixture',
          schemaVersion: 1,
        }),
      };
    },
    async planningContext(request) {
      const body = PlanningContextRequest.safeParse(request);
      if (!body.success) return { ok: false, error: clientError('VALIDATION_FAILED', 'Invalid request.'), source };
      if (scenario === 'error') {
        return { ok: false, error: { code: 'PROVIDER_UNAVAILABLE', message: 'The data source is not available.', retryable: true, requestId: 'mock_req' }, source };
      }
      const places = scenario === 'empty' ? [] : mockPlacesFor(body.data.area).slice(0, body.data.maxPlaces);
      return { ok: true, source, data: PlanningContext.parse({ places, legs: [], unknown: [], dataMode: 'fixture' }) };
    },
    async generate(request, idempotencyKey) {
      const r = await api.generate(request, { idempotencyKey });
      return r.ok ? { ok: true, data: r.data, source } : { ok: false, error: r.error, source };
    },
  };
}
