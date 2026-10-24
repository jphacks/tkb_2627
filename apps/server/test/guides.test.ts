import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, GuideResponse } from '@tkb/contracts';
import { migrate, openDatabase } from '@tkb/db';
import { PolicyError, type GuideRequest, type GuideResult, type GuideSource } from '@tkb/travel-data';
import { buildApp } from '../src/platform/app.ts';
import { loadConfig } from '../src/platform/config.ts';
import type { SpotGuideDeps } from '../src/guides/spots.ts';

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});
function make(guides?: SpotGuideDeps) {
  const db = openDatabase(':memory:');
  migrate(db);
  const app = buildApp({ config: { ...loadConfig({ SESSION_SECRET: 's'.repeat(40) }), databasePath: ':memory:' }, db, ...(guides ? { guides } : {}) });
  apps.push(app);
  return app;
}
const get = (app: ReturnType<typeof buildApp>, q: string) => app.inject({ method: 'GET', url: `/api/v1/guides?${q}` });

const prov = { source: 'wikipedia', fetchedAt: '2026-10-24T00:00:00Z', attribution: 'Wikipedia (CC BY-SA 4.0)', maySendToModel: false, mayStore: true, mayExport: true, retainUntil: null };
function okSource(calls: GuideRequest[], mayStore = true): GuideSource {
  return {
    async guide(req): Promise<GuideResult> {
      calls.push(req);
      return {
        item: { number: req.number, placeId: req.place.placeId, name: req.place.name, kind: 'spot', location: req.place.location, description: '庭園。', photo: { url: 'https://upload.wikimedia.org/a.jpg', attribution: 'A', license: 'CC BY-SA 4.0' }, provenance: { ...prov, mayStore } },
        reason: null, photoRejected: null,
      };
    },
  };
}

describe('GET /api/v1/guides (K19)', () => {
  it('fixture mode: public, no-store, description from the known place, no network', async () => {
    const res = await get(make(), 'placeId=fx_kenrokuen&lang=ja');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = GuideResponse.parse(res.json());
    expect(body.dataStatus).toBe('fixture');
    expect(body.items[0]?.placeId).toBe('fx_kenrokuen');
  });

  it('empty is explicit: known place without description and unknown place are unknown, not unavailable', async () => {
    const app = make();
    for (const id of ['fx_21c_museum', 'nope']) {
      const res = await get(app, `placeId=${id}`);
      expect(res.statusCode).toBe(200);
      const body = GuideResponse.parse(res.json());
      expect(body.items).toEqual([]);
      expect(body.dataStatus).toBe('unknown');
      expect(body.reason).toBeTruthy();
    }
  });

  it('422 for missing/invalid placeId, bad lang and extra params', async () => {
    const app = make();
    for (const q of ['', 'placeId=', 'placeId=https://evil.example/x', 'placeId=a%20b', 'placeId=fx_kenrokuen&lang=zz', 'placeId=fx_kenrokuen&title=x']) {
      const res = await get(app, q);
      expect(res.statusCode, q).toBe(422);
      expect(ApiError.parse(res.json()).code).toBe('VALIDATION_FAILED');
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('503 when the source fails, and all-failed is never reported as empty', async () => {
    const source: GuideSource = { guide: async () => ({ item: null, reason: 'provider_unavailable', photoRejected: null }) };
    const res = await get(make({ source, live: true }), 'placeId=fx_kenrokuen');
    expect(res.statusCode).toBe(503);
    expect(ApiError.parse(res.json())).toMatchObject({ code: 'UNAVAILABLE', retryable: true });
    const thrown: GuideSource = { guide: async () => { throw new PolicyError('PROVIDER_UNAVAILABLE', 'x', true); } };
    expect((await get(make({ source: thrown }), 'placeId=fx_kenrokuen')).statusCode).toBe(503);
  });

  it('live: the Wikipedia title is the known place name, never request text; other languages do no lookup', async () => {
    const calls: GuideRequest[] = [];
    const app = make({ source: okSource(calls), live: true });
    expect((await get(app, 'placeId=fx_kenrokuen&lang=ja')).statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ title: '兼六園', lang: 'ja' });
    const en = GuideResponse.parse((await get(app, 'placeId=fx_kenrokuen&lang=en')).json());
    expect(en.items).toEqual([]);
    const unknown = GuideResponse.parse((await get(app, 'placeId=something_else')).json());
    expect(unknown.items).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('caches for 10 minutes when mayStore, not otherwise', async () => {
    let t = 1_000_000;
    const calls: GuideRequest[] = [];
    const app = make({ source: okSource(calls), live: true, now: () => t });
    await get(app, 'placeId=fx_kenrokuen');
    t += 5 * 60_000;
    await get(app, 'placeId=fx_kenrokuen');
    expect(calls).toHaveLength(1);
    t += 6 * 60_000;
    await get(app, 'placeId=fx_kenrokuen');
    expect(calls).toHaveLength(2);

    const calls2: GuideRequest[] = [];
    const app2 = make({ source: okSource(calls2, false), live: true, now: () => t });
    await get(app2, 'placeId=fx_kenrokuen');
    await get(app2, 'placeId=fx_kenrokuen');
    expect(calls2).toHaveLength(2);
  });

  it('rate-limits live lookups per minute (429) and recovers', async () => {
    let t = 5_000_000;
    const calls: GuideRequest[] = [];
    const app = make({ source: okSource(calls, false), live: true, now: () => t, liveLimitPerMinute: 2 });
    expect((await get(app, 'placeId=fx_kenrokuen')).statusCode).toBe(200);
    expect((await get(app, 'placeId=fx_kenrokuen')).statusCode).toBe(200);
    const limited = await get(app, 'placeId=fx_kenrokuen');
    expect(limited.statusCode).toBe(429);
    expect(ApiError.parse(limited.json()).code).toBe('RATE_LIMITED');
    expect(calls).toHaveLength(2);
    t += 61_000;
    expect((await get(app, 'placeId=fx_kenrokuen')).statusCode).toBe(200);
  });
});
