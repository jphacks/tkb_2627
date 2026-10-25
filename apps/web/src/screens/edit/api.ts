/**
 * U06 typed client for K09 GET, K10 PATCH and the K10 extensions alternatives (A05) / replan (A06).
 * Every request body is parsed with the shared strict schema before it is sent; every response is validated.
 * Writes send the session CSRF token (`x-csrf-token`, from GET /api/v1/auth/me). Nothing is stored in the browser.
 * The mock variant keeps the same interface on top of the in-memory U01 mock API.
 */
import type { z } from 'zod';
import {
  AlternativesRequest, AlternativesResult, ApiError, LoginResponse, ReplanRequest, ReplanResult, Trip, TripPatchRequest, TripPatchResult,
  type ItineraryItem, type Money, type TripDiff,
} from '@tkb/contracts';
import { createMockApi, type MockApi } from '../../mocks/index.ts';
import { applyOperations, itemIdOf } from './ops.ts';

export type DataSource = 'live' | 'mock';
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export interface TripEditApi {
  readonly source: DataSource;
  getTrip(tripId: string): Promise<ApiResult<Trip>>;
  /** K10 extension: preview only, nothing saved. */
  alternatives(tripId: string, request: z.input<typeof AlternativesRequest>): Promise<ApiResult<AlternativesResult>>;
  /** K10 PATCH. A stale expectedRevision is a 409 REVISION_CONFLICT; callers never retry it blindly. */
  patch(tripId: string, request: z.input<typeof TripPatchRequest>): Promise<ApiResult<TripPatchResult>>;
  /** K10 extension: preview only, nothing saved. */
  replan(tripId: string, request: z.input<typeof ReplanRequest>): Promise<ApiResult<ReplanResult>>;
}

export const clientError = (code: ApiError['code'], message: string, retryable = false): ApiError => ({ code, message, retryable, requestId: 'client' });

export const isRevisionConflict = (e: ApiError): boolean => e.code === 'REVISION_CONFLICT';
export const CONFLICT_MESSAGE = '他の端末で更新されています';

/** Japanese text for the screen. The server message stays English, so known codes are mapped. */
export function describeEditError(e: ApiError): string {
  switch (e.code) {
    case 'REVISION_CONFLICT': return `${CONFLICT_MESSAGE}。再読み込みして最新の旅程を確認してください（この編集は保存されていません）。`;
    case 'UNAUTHENTICATED': return 'ログインが必要です。';
    case 'FORBIDDEN': return '操作が拒否されました（セッションまたはCSRFトークンが無効です）。再読み込みしてください。';
    case 'NOT_FOUND': return '旅程が見つかりません（削除されたか、権限がありません）。';
    case 'VALIDATION_FAILED': return '入力が受け付けられませんでした。';
    case 'CONSTRAINT_UNSATISFIED': return 'この操作は条件を満たせないため適用できません。';
    case 'RATE_LIMITED': return '利用回数の上限に達しました。しばらくしてから再試行してください。';
    default: return e.message;
  }
}

type FetchFn = typeof fetch;

export function createLiveTripEditApi(fetchFn: FetchFn = (...a) => fetch(...a)): TripEditApi {
  async function call<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<ApiResult<T>> {
    let res: Response;
    try {
      res = await fetchFn(path, { credentials: 'same-origin', cache: 'no-store', ...init });
    } catch (e) {
      return { ok: false, error: clientError('UNAVAILABLE', `接続できません: ${e instanceof Error ? e.message : 'fetch failed'}`, true) };
    }
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const err = ApiError.safeParse(body);
      return { ok: false, error: err.success ? err.data : clientError('INTERNAL', `HTTP ${res.status}`, res.status >= 500) };
    }
    const parsed = schema.safeParse(body);
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, error: clientError('INVALID_OUTPUT', '応答が契約(schema v1)と一致しません。') };
  }

  async function write<T>(method: 'PATCH' | 'POST', path: string, bodyValue: unknown, schema: z.ZodType<T>): Promise<ApiResult<T>> {
    const me = await call('/api/v1/auth/me', LoginResponse);
    if (!me.ok) return me;
    return call(path, schema, {
      method,
      headers: { 'content-type': 'application/json', 'x-csrf-token': me.data.csrfToken },
      body: JSON.stringify(bodyValue),
    });
  }

  const base = (id: string) => `/api/v1/trips/${encodeURIComponent(id)}`;
  const invalid = (what: string): ApiResult<never> => ({ ok: false, error: clientError('VALIDATION_FAILED', `${what}が契約(K10)に適合しません。`) });

  return {
    source: 'live',
    getTrip: id => call(base(id), Trip, { headers: { accept: 'application/json' } }),
    async alternatives(id, request) {
      const body = AlternativesRequest.safeParse(request);
      return body.success ? write('POST', `${base(id)}/alternatives`, body.data, AlternativesResult) : invalid('代替案の要求');
    },
    async patch(id, request) {
      const body = TripPatchRequest.safeParse(request);
      return body.success ? write('PATCH', base(id), body.data, TripPatchResult) : invalid('保存の要求');
    },
    async replan(id, request) {
      const body = ReplanRequest.safeParse(request);
      return body.success ? write('POST', `${base(id)}/replan`, body.data, ReplanResult) : invalid('再計画の要求');
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Mock: the U01 mock API has getTrip/patchTrip only; alternatives and replan are small previews built here.
// ---------------------------------------------------------------------------------------------------------------

function moneyOf(item: ItineraryItem): Money | null {
  return item.type === 'activity' ? item.cost : item.fare;
}

/** Mock diff, same rule as the real one: unknown durations/costs stay unknown (null / listed), never 0. */
export function mockDiff(before: Trip, after: Trip): TripDiff {
  const flat = (t: Trip) => t.days.flatMap(d => d.items);
  const elapsed = (t: Trip): number | null => {
    const times: number[] = [];
    for (const i of flat(t)) {
      const s = i.type === 'activity' ? i.start : i.departure;
      const e = i.type === 'activity' ? i.end : i.arrival;
      if (!s || !e) return null;
      times.push(Date.parse(s.utc), Date.parse(e.utc));
    }
    return times.length === 0 ? null : Math.round((Math.max(...times) - Math.min(...times)) / 1000);
  };
  const b = elapsed(before);
  const a = elapsed(after);
  const beforeIds = new Set(flat(before).map(itemIdOf));
  const afterIds = new Set(flat(after).map(itemIdOf));
  const sums = new Map<string, number>();
  const unknown: string[] = [];
  const touch = (i: ItineraryItem, sign: 1 | -1) => {
    const m = moneyOf(i);
    if (m) sums.set(m.currency, (sums.get(m.currency) ?? 0) + sign * m.amountMinor);
    else if (i.type === 'activity' && !unknown.includes(i.activityId)) unknown.push(i.activityId);
  };
  for (const i of flat(after)) if (!beforeIds.has(itemIdOf(i))) touch(i, 1);
  for (const i of flat(before)) if (!afterIds.has(itemIdOf(i))) touch(i, -1);
  return {
    durationDeltaSeconds: a === null || b === null ? null : a - b,
    knownCostDelta: [...sums].filter(([, v]) => v !== 0).map(([currency, amountMinor]) => ({ currency, amountMinor })),
    unknownCostItems: unknown,
  };
}

let sharedMock: MockApi | null = null;
/**
 * One in-memory mock for the page (U11): what the 地図・編集 tab saved is still there after switching tabs and back.
 * A page reload starts from the fixtures again (mock mode only; the server mode reads K09).
 */
export function sharedMockApi(): MockApi {
  sharedMock ??= createMockApi();
  return sharedMock;
}

export function createMockTripEditApi(mock: MockApi = createMockApi()): TripEditApi {
  const fromMock = <T>(r: { ok: true; data: T } | { ok: false; error: ApiError }): ApiResult<T> => (r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error });

  return {
    source: 'mock',
    async getTrip(id) { return fromMock(await mock.getTrip(id)); },
    async patch(id, request) {
      const body = TripPatchRequest.safeParse(request);
      if (!body.success) return { ok: false, error: clientError('VALIDATION_FAILED', '保存の要求が契約(K10)に適合しません。') };
      return fromMock(await mock.patchTrip(id, body.data));
    },
    async alternatives(id, request) {
      const body = AlternativesRequest.safeParse(request);
      if (!body.success) return { ok: false, error: clientError('VALIDATION_FAILED', '代替案の要求が契約(K10)に適合しません。') };
      const t = await mock.getTrip(id);
      if (!t.ok) return { ok: false, error: t.error };
      if (t.data.revision !== body.data.expectedRevision) {
        return { ok: false, error: { code: 'REVISION_CONFLICT', message: 'revision conflict', retryable: false, requestId: 'mock' } };
      }
      const applied = applyOperations(t.data, body.data.operations);
      if (!applied.ok) return { ok: false, error: clientError('CONSTRAINT_UNSATISFIED', applied.reason) };
      const diff = mockDiff(t.data, applied.trip);
      const result = {
        tripId: id,
        baseRevision: t.data.revision,
        candidates: [
          {
            candidateId: 'mock_alt_requested', kind: 'requested' as const, summary: '指定どおりに変更（モックの試算）', trip: applied.trip, diff,
            affectedSegments: [], validationState: 'needs_revalidation' as const, warnings: ['モック: 区間の所要時間は再計算していません。'], unknown: [],
            operations: body.data.operations,
          },
          {
            candidateId: 'mock_alt_swap', kind: 'swap' as const, summary: '近くの代替地点に差し替え（モックの表示専用案）', trip: applied.trip, diff,
            affectedSegments: [], validationState: 'needs_revalidation' as const, warnings: [], unknown: ['代替地点の所要時間'],
            operations: null,
          },
        ],
      };
      const parsed = AlternativesResult.safeParse(result);
      return parsed.success ? { ok: true, data: parsed.data } : { ok: false, error: clientError('INVALID_OUTPUT', 'モックの応答が契約と一致しません。') };
    },
    async replan(id, request) {
      const body = ReplanRequest.safeParse(request);
      if (!body.success) return { ok: false, error: clientError('VALIDATION_FAILED', '再計画の要求が契約(K10)に適合しません。') };
      const t = await mock.getTrip(id);
      if (!t.ok) return { ok: false, error: t.error };
      if (t.data.revision !== body.data.expectedRevision) {
        return { ok: false, error: { code: 'REVISION_CONFLICT', message: 'revision conflict', retryable: false, requestId: 'mock' } };
      }
      const req = body.data;
      const done = new Set(req.completedActivityIds);
      const pinned = new Set(req.fixedActivityIds);
      const dayIndex = 0;
      const day = t.data.days[dayIndex];
      const ops: import('@tkb/contracts').TripOperation[] = [];
      const retimed: string[] = [];
      const untimed: { activityId: string; reason: string }[] = [];
      const conflicts: { activityId: string; reason: 'missed' | 'time_unknown' }[] = [];
      const kept = { completed: [] as string[], fixed: [] as string[] };
      // Mock rule: pending, unpinned, timed activities slide 15 minutes later; nothing else is invented.
      for (const item of day?.items ?? []) {
        if (item.type !== 'activity') continue;
        if (done.has(item.activityId)) { kept.completed.push(item.activityId); continue; }
        if (item.fixed || pinned.has(item.activityId)) {
          kept.fixed.push(item.activityId);
          if (req.missedActivityIds.includes(item.activityId)) conflicts.push({ activityId: item.activityId, reason: 'missed' });
          continue;
        }
        if (!item.start || !item.end) { untimed.push({ activityId: item.activityId, reason: '開始・終了時刻が未定のため動かしていません' }); continue; }
        const shift = (z: { utc: string; timeZone: string }) => ({ utc: new Date(Date.parse(z.utc) + 15 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'), timeZone: z.timeZone });
        ops.push({ op: 'update', itemId: item.activityId, item: { ...item, start: shift(item.start), end: shift(item.end) } });
        retimed.push(item.activityId);
      }
      const applied = applyOperations(t.data, ops);
      if (!applied.ok) return { ok: false, error: clientError('CONSTRAINT_UNSATISFIED', applied.reason) };
      const result = {
        tripId: id, baseRevision: t.data.revision, now: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), dayIndex,
        start: { kind: req.location.kind === 'place' ? ('place' as const) : req.location.kind === 'coords' ? ('coords' as const) : ('none' as const), placeId: req.location.kind === 'place' ? req.location.placeId : null },
        startLeg: null,
        candidates: [{
          candidateId: 'mock_replan_1', kind: 'keep_order' as const, summary: '順番はそのまま、残りの予定を15分後ろにずらす（モックの試算）',
          trip: applied.trip, diff: mockDiff(t.data, applied.trip), validationState: 'needs_revalidation' as const, warnings: [], unknown: [],
          operations: ops.length > 0 ? ops : null, kept, retimed, untimed, reservationConflicts: conflicts,
        }],
      };
      const parsed = ReplanResult.safeParse(result);
      return parsed.success ? { ok: true, data: parsed.data } : { ok: false, error: clientError('INVALID_OUTPUT', 'モックの応答が契約と一致しません。') };
    },
  };
}
