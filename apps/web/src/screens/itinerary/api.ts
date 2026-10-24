/**
 * K09 GET /api/v1/trips/{id}: the only source of the itinerary screen in real mode.
 * The trip is always fetched from the server (also after a reload); nothing is kept in browser storage.
 * The response is validated with the shared Trip schema instead of being trusted as a cast.
 */
import { ApiError, Trip } from '@tkb/contracts';
import type { MockApi } from '../../mocks/index.ts';

export type TripSource = 'server' | 'mock';

export type TripLoad =
  | { state: 'ok'; trip: Trip; source: TripSource }
  | { state: 'notFound'; source: TripSource }
  | { state: 'unauthenticated'; source: TripSource }
  | { state: 'error'; message: string; code?: string; requestId?: string; source: TripSource };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function tripUrl(tripId: string): string {
  return `/api/v1/trips/${encodeURIComponent(tripId)}`;
}

export async function fetchTrip(tripId: string, options: { fetch?: FetchLike; signal?: AbortSignal } = {}): Promise<TripLoad> {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const source = 'server' as const;
  try {
    const res = await doFetch(tripUrl(tripId), {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (res.status === 404) return { state: 'notFound', source };
    if (res.status === 401) return { state: 'unauthenticated', source };
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const err = ApiError.safeParse(body);
      return err.success
        ? { state: 'error', message: err.data.message, code: err.data.code, requestId: err.data.requestId, source }
        : { state: 'error', message: `HTTP ${res.status}`, source };
    }
    const parsed = Trip.safeParse(body);
    if (!parsed.success) return { state: 'error', message: '応答が契約(K09 Trip schema v1)と一致しません', source };
    return { state: 'ok', trip: parsed.data, source };
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw e;
    return { state: 'error', message: e instanceof Error ? e.message : '通信に失敗しました', source };
  }
}

/** Mock mode: the same states from the in-memory U01 mock API. */
export async function fetchTripFromMock(api: MockApi, tripId: string): Promise<TripLoad> {
  const source = 'mock' as const;
  const r = await api.getTrip(tripId);
  if (r.ok) return { state: 'ok', trip: r.data, source };
  if (r.status === 404) return { state: 'notFound', source };
  return { state: 'error', message: r.error.message, code: r.error.code, requestId: r.error.requestId, source };
}
