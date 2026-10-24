/** Hub client: K22 capabilities, K11 me, K09 trip list. Every body is zod-parsed; a mismatch is an error, never a cast. */
import { Capabilities, LoginResponse, TripList } from '@tkb/contracts';
import type { z } from 'zod';

export type HubResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; kind: 'unauthorized' | 'network' | 'http' | 'schema' };

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HubUser {
  userId: string;
  displayName: string;
}

export interface HubApi {
  capabilities(): Promise<HubResult<Capabilities>>;
  me(): Promise<HubResult<HubUser>>;
  listTrips(cursor?: string | null): Promise<HubResult<TripList>>;
}

const Me = LoginResponse.pick({ userId: true, displayName: true });

export function createHubApi(fetchImpl: FetchLike = (u, i) => fetch(u, i)): HubApi {
  async function get<S extends z.ZodType>(path: string, schema: S): Promise<HubResult<z.infer<S>>> {
    let res: Response;
    try {
      res = await fetchImpl(path, { method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' });
    } catch {
      return { ok: false, status: 0, kind: 'network' };
    }
    if (res.status === 401) return { ok: false, status: 401, kind: 'unauthorized' };
    if (!res.ok) return { ok: false, status: res.status, kind: 'http' };
    try {
      const parsed = schema.safeParse(await res.json());
      return parsed.success ? { ok: true, data: parsed.data } : { ok: false, status: res.status, kind: 'schema' };
    } catch {
      return { ok: false, status: res.status, kind: 'schema' };
    }
  }
  return {
    capabilities: () => get('/api/v1/capabilities', Capabilities),
    me: () => get('/api/v1/auth/me', Me),
    listTrips: cursor => get(`/api/v1/trips?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, TripList),
  };
}
