import { Capabilities, Health } from '@tkb/contracts';
import type { z } from 'zod';

export type Probe<T> = { ok: true; data: T } | { ok: false; error: string };

/** Fetches JSON and validates it against the shared contract instead of trusting a cast. */
export async function getJson<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<Probe<T>> {
  try {
    const res = await fetch(path, signal ? { signal } : {});
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const parsed = schema.safeParse(await res.json());
    if (!parsed.success) return { ok: false, error: '応答が契約(schema v1)と一致しません' };
    return { ok: true, data: parsed.data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'fetch failed' };
  }
}

export interface ConnectionState {
  health: Probe<z.infer<typeof Health>>;
  shared: Probe<z.infer<typeof Capabilities>>;
  personal: Probe<z.infer<typeof Capabilities>>;
}

export async function probeConnections(signal?: AbortSignal): Promise<ConnectionState> {
  const [health, shared, personal] = await Promise.all([
    getJson('/api/v1/health', Health, signal),
    getJson('/api/v1/capabilities', Capabilities, signal),
    getJson('/local/v1/capabilities', Capabilities, signal),
  ]);
  return { health, shared, personal };
}
