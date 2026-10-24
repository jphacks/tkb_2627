/**
 * E03 client: GET /api/v1/trips/:id/ics (blob download) and GET /api/v1/trips/:id/maps-links (per-day Google Maps
 * links). Both are read-only GETs with the session cookie; responses are validated with a local schema.
 */
import { z } from 'zod';
import { ApiError, ExportWithheld } from '@tkb/contracts';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export interface CalendarMapsDeps { fetch?: FetchLike; signal?: AbortSignal }

export const MapsLinksResponse = z.object({
  links: z.array(z.object({ dayIndex: z.number().int().min(0), url: z.string() })),
  withheld: z.array(ExportWithheld),
});

export type IcsOutcome =
  | { state: 'ready'; blob: Blob }
  | { state: 'restricted' | 'unauthenticated' | 'notFound' }
  | { state: 'error'; message: string };
export type MapsOutcome =
  | { state: 'ready'; byDay: DayLinks[]; withheld: ExportWithheld[] }
  | { state: 'restricted'; withheld: ExportWithheld[] }
  | { state: 'unauthenticated' | 'notFound' }
  | { state: 'error'; message: string };
export interface DayLinks { dayIndex: number; urls: string[] }

export const CAL_MESSAGES = {
  restricted: '出力できる項目がありません。',
  unauthenticated: 'ログインが必要です。',
  notFound: '旅程が見つかりません。',
} as const;

const GOOGLE_MAPS = /^https:\/\/www\.google\.com\/maps\//;

/** Groups links by day and keeps only official Google Maps URLs. */
export function groupByDay(links: { dayIndex: number; url: string }[]): DayLinks[] {
  const days = new Map<number, string[]>();
  for (const l of links) {
    if (!GOOGLE_MAPS.test(l.url)) continue;
    days.set(l.dayIndex, [...(days.get(l.dayIndex) ?? []), l.url]);
  }
  return [...days.entries()].sort((a, b) => a[0] - b[0]).map(([dayIndex, urls]) => ({ dayIndex, urls }));
}

async function restricted(res: Response): Promise<{ restricted: boolean; message: string; withheld: ExportWithheld[] }> {
  const e = ApiError.safeParse(await res.json().catch(() => null));
  if (!e.success) return { restricted: false, message: `HTTP ${res.status}`, withheld: [] };
  const w = z.array(ExportWithheld).safeParse((e.data.details as { withheld?: unknown } | undefined)?.withheld);
  return { restricted: e.data.code === 'RESTRICTED_ASSET', message: e.data.message, withheld: w.success ? w.data : [] };
}

export async function fetchIcs(tripId: string, deps: CalendarMapsDeps = {}): Promise<IcsOutcome> {
  const doFetch: FetchLike = deps.fetch ?? ((i, init) => fetch(i, init));
  try {
    const res = await doFetch(`/api/v1/trips/${encodeURIComponent(tripId)}/ics`, {
      credentials: 'same-origin', cache: 'no-store', headers: { accept: 'text/calendar, application/json' },
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
    if (res.status === 401) return { state: 'unauthenticated' };
    if (res.status === 404) return { state: 'notFound' };
    if (res.status === 422) {
      const r = await restricted(res);
      return r.restricted ? { state: 'restricted' } : { state: 'error', message: r.message };
    }
    if (!res.ok) return { state: 'error', message: `HTTP ${res.status}` };
    if (!(res.headers.get('content-type') ?? '').toLowerCase().startsWith('text/calendar')) {
      return { state: 'error', message: '応答がICSではありません。' };
    }
    return { state: 'ready', blob: await res.blob() };
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw e;
    return { state: 'error', message: 'サーバーに接続できません。' };
  }
}

export async function fetchMapsLinks(tripId: string, deps: CalendarMapsDeps = {}): Promise<MapsOutcome> {
  const doFetch: FetchLike = deps.fetch ?? ((i, init) => fetch(i, init));
  try {
    const res = await doFetch(`/api/v1/trips/${encodeURIComponent(tripId)}/maps-links`, {
      credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' },
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
    if (res.status === 401) return { state: 'unauthenticated' };
    if (res.status === 404) return { state: 'notFound' };
    if (res.status === 422) {
      const r = await restricted(res);
      return r.restricted ? { state: 'restricted', withheld: r.withheld } : { state: 'error', message: r.message };
    }
    if (!res.ok) return { state: 'error', message: `HTTP ${res.status}` };
    const body = MapsLinksResponse.safeParse(await res.json().catch(() => null));
    if (!body.success) return { state: 'error', message: '応答が契約と一致しません。' };
    return { state: 'ready', byDay: groupByDay(body.data.links), withheld: body.data.withheld };
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw e;
    return { state: 'error', message: 'サーバーに接続できません。' };
  }
}

/** Mock mode: a tiny fake ICS and one fake link, no network. */
export function mockIcs(): Promise<IcsOutcome> {
  const text = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//tkb_2627//mock//JA\r\nEND:VCALENDAR\r\n';
  return Promise.resolve({ state: 'ready', blob: new Blob([text], { type: 'text/calendar; charset=utf-8' }) });
}
export function mockMapsLinks(): Promise<MapsOutcome> {
  return Promise.resolve({
    state: 'ready',
    byDay: [{ dayIndex: 0, urls: ['https://www.google.com/maps/search/?api=1&query=35.000000%2C135.000000'] }],
    withheld: [],
  });
}
