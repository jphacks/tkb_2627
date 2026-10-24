/**
 * E01 / E02: PDF export client. POST /api/v1/trips/:id/exports -> 202 ExportStatus, then poll
 * GET /api/v1/exports/:id until application/pdf. JSON responses are validated with the shared schemas.
 */
import { ApiError, ExportRequest, ExportStatus, LoginResponse, type ExportWithheld } from '@tkb/contracts';

export const CSRF_HEADER = 'x-csrf-token';
export const MAX_TRIES = 20;
export const BASE_DELAY_MS = 500;
export const MAX_DELAY_MS = 4000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type PdfOutcome =
  | { state: 'ready'; blob: Blob; withheld: ExportWithheld[] }
  | { state: 'failed'; message: string; withheld: ExportWithheld[] }
  | { state: 'expired'; withheld: ExportWithheld[] }
  | { state: 'timeout'; withheld: ExportWithheld[] }
  | { state: 'conflict' }
  | { state: 'restricted' }
  | { state: 'error'; message: string };

/** Exponential backoff, capped. attempt is 0-based. */
export function backoffMs(attempt: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
}

export const PDF_MESSAGES = {
  conflict: '他の端末で更新されています。画面を再読み込みしてからやり直してください。',
  restricted: '出力できる項目がありません。',
  expired: 'PDFの保存期限が切れました。もう一度作成してください。',
  timeout: '作成に時間がかかっています。しばらくしてからやり直してください。',
} as const;

export interface PdfDeps {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  onProgress?: (attempt: number) => void;
}

async function errorOf(res: Response): Promise<string> {
  const body: unknown = await res.json().catch(() => null);
  const e = ApiError.safeParse(body);
  return e.success ? e.data.message : `HTTP ${res.status}`;
}

/** The CSRF token comes from GET /api/v1/auth/me and is kept only in memory. */
export async function fetchCsrf(doFetch: FetchLike): Promise<string | null> {
  const res = await doFetch('/api/v1/auth/me', { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
  if (!res.ok) return null;
  const p = LoginResponse.safeParse(await res.json().catch(() => null));
  return p.success ? p.data.csrfToken : null;
}

export async function createPdf(tripId: string, expectedRevision: number, deps: PdfDeps = {}): Promise<PdfOutcome> {
  const doFetch: FetchLike = deps.fetch ?? ((i, init) => fetch(i, init));
  const sleep = deps.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
  const signalInit = deps.signal ? { signal: deps.signal } : {};
  try {
    const csrf = await fetchCsrf(doFetch);
    if (csrf === null) return { state: 'error', message: 'ログインが必要です。' };
    const body = ExportRequest.safeParse({ expectedRevision, format: 'pdf' });
    if (!body.success) return { state: 'error', message: '入力内容が契約の形式に合いません。' };
    const post = await doFetch(`/api/v1/trips/${encodeURIComponent(tripId)}/exports`, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { accept: 'application/json', 'content-type': 'application/json', [CSRF_HEADER]: csrf },
      body: JSON.stringify(body.data), ...signalInit,
    });
    if (post.status === 409) return { state: 'conflict' };
    if (post.status === 422) {
      const e = ApiError.safeParse(await post.json().catch(() => null));
      if (e.success && e.data.code === 'RESTRICTED_ASSET') return { state: 'restricted' };
      return { state: 'error', message: e.success ? e.data.message : 'HTTP 422' };
    }
    if (!post.ok) return { state: 'error', message: await errorOf(post) };
    const accepted = ExportStatus.safeParse(await post.json().catch(() => null));
    if (!accepted.success) return { state: 'error', message: '応答が契約(K18 ExportStatus)と一致しません' };
    const withheld = accepted.data.withheld ?? [];
    const id = accepted.data.exportId;
    for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
      deps.onProgress?.(attempt);
      await sleep(backoffMs(attempt));
      const res = await doFetch(`/api/v1/exports/${encodeURIComponent(id)}`, {
        credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/pdf, application/json' }, ...signalInit,
      });
      if ((res.headers.get('content-type') ?? '').toLowerCase().startsWith('application/pdf')) {
        return { state: 'ready', blob: await res.blob(), withheld };
      }
      if (!res.ok) return { state: 'error', message: await errorOf(res) };
      const st = ExportStatus.safeParse(await res.json().catch(() => null));
      if (!st.success) return { state: 'error', message: '応答が契約(K18 ExportStatus)と一致しません' };
      if (st.data.status === 'failed') return { state: 'failed', message: st.data.error?.message ?? '作成に失敗しました。', withheld };
      if (st.data.status === 'expired') return { state: 'expired', withheld };
    }
    return { state: 'timeout', withheld };
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw e;
    return { state: 'error', message: 'サーバーに接続できません。' };
  }
}

/** Mock mode: a tiny fake PDF blob, no network. */
export function createMockPdf(): Promise<PdfOutcome> {
  const blob = new Blob(['%PDF-1.4\n% mock (E01)\n%%EOF\n'], { type: 'application/pdf' });
  return Promise.resolve({ state: 'ready', blob, withheld: [] });
}
