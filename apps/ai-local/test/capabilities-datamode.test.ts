import { describe, expect, it } from 'vitest';
import { Capabilities, SCHEMA_VERSION } from '@tkb/contracts';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { createCapabilitiesClient, UPSTREAM_CAPABILITIES_PATHS, type FetchLike } from '../src/shared-client/index.ts';

const upstream = (dataMode: string) =>
  new Response(JSON.stringify({ entry: 'shared', aiGeneration: { available: false, runner: 'none', reason: null }, storage: 'shared-server', dataMode, schemaVersion: SCHEMA_VERSION }), { status: 200 });
const H = { host: '127.0.0.1:4311' };

describe('/local/v1/capabilities dataMode comes from the shared server', () => {
  it('reports the real mode, calls only the fixed path with manual redirects, caches for 60 s', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let mode = 'mixed';
    let t = 1_000;
    const fetch: FetchLike = async (url, init) => (calls.push({ url, init }), upstream(mode));
    const client = createCapabilitiesClient({ baseUrl: 'http://shared.test/', fetch, now: () => t });
    const app = buildApp({ config: loadConfig({}), capabilitiesClient: client });
    const get = async () => Capabilities.parse((await app.inject({ method: 'GET', url: '/local/v1/capabilities', headers: H })).json());
    expect((await get()).dataMode).toBe('mixed');
    mode = 'live';
    expect((await get()).dataMode).toBe('mixed'); // cached
    t += 59_000;
    expect((await get()).dataMode).toBe('mixed');
    t += 2_000;
    expect((await get()).dataMode).toBe('live');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe(`http://shared.test${UPSTREAM_CAPABILITIES_PATHS.capabilities}`);
    expect(calls[0]!.init).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect(Object.keys(calls[0]!.init.headers as object)).toEqual([]); // no cookie, no csrf
  });

  it('falls back to fixture only when the shared server is unreachable or answers badly, and does not cache that', async () => {
    let step: 'down' | 'bad' | 'status' | 'up' = 'down';
    const fetch: FetchLike = async () => {
      if (step === 'down') throw new Error('ECONNREFUSED');
      if (step === 'bad') return upstream('nonsense');
      if (step === 'status') return new Response('x', { status: 503 });
      return upstream('live');
    };
    let t = 5_000;
    const client = createCapabilitiesClient({ baseUrl: 'http://shared.test', fetch, now: () => t });
    const app = buildApp({ config: loadConfig({}), capabilitiesClient: client });
    const mode = async () => Capabilities.parse((await app.inject({ method: 'GET', url: '/local/v1/capabilities', headers: H })).json()).dataMode;
    expect(await mode()).toBe('fixture');
    step = 'bad';
    t += 11_000;
    expect(await mode()).toBe('fixture');
    step = 'status';
    t += 11_000;
    expect(await mode()).toBe('fixture');
    step = 'up';
    expect(await mode()).toBe('fixture'); // negative cache: not asked again within 10 s
    t += 11_000;
    expect(await mode()).toBe('live');
  });

  it('refuses an oversized answer (64 KB cap)', async () => {
    const big = new Response(JSON.stringify({ pad: 'x'.repeat(70_000) }), { status: 200 });
    const client = createCapabilitiesClient({ baseUrl: 'http://shared.test', fetch: async () => big });
    expect(await client.getDataMode()).toBeNull();
  });
});
