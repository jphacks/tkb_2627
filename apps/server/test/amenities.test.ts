import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '@tkb/contracts';
import { migrate, openDatabase } from '@tkb/db';
import { LiveAmenitiesProvider, PolicyError, type AmenitiesProvider } from '@tkb/travel-data';
import { buildApp } from '../src/platform/app.ts';
import { loadConfig } from '../src/platform/config.ts';
import { AmenityResponse } from '../src/guides/index.ts';

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});
function make(amenities?: AmenitiesProvider) {
  const db = openDatabase(':memory:');
  migrate(db);
  const app = buildApp({ config: { ...loadConfig({ SESSION_SECRET: 's'.repeat(40) }), databasePath: ':memory:' }, db, ...(amenities ? { amenities } : {}) });
  apps.push(app);
  return app;
}
const KANAZAWA = '36.55,136.64,36.59,136.68';
const get = (app: ReturnType<typeof buildApp>, q: string) => app.inject({ method: 'GET', url: `/api/v1/amenities?${q}` });

describe('GET /api/v1/amenities (U07 / K19)', () => {
  it('is public, no-store, and keeps shelter and site separate with openNow null', async () => {
    const res = await get(make(), `bbox=${KANAZAWA}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = AmenityResponse.parse(res.json());
    expect(body.dataStatus).toBe('fixture');
    const kinds = new Set(body.items.map(i => i.kind));
    expect(kinds).toEqual(new Set(['toilet', 'evacuation_site', 'evacuation_shelter']));
    for (const i of body.items) expect(i.openNow).toBeNull();
    expect(body.items.find(i => i.kind === 'evacuation_shelter')?.warning).toContain('開設状況は自治体の発表');
  });

  it('filters by kind and hazard', async () => {
    const app = make();
    const k = AmenityResponse.parse((await get(app, `bbox=${KANAZAWA}&kind=toilet`)).json());
    expect(k.items.length).toBeGreaterThan(0);
    expect(k.items.every(i => i.kind === 'toilet')).toBe(true);
    const h = AmenityResponse.parse((await get(app, `bbox=${KANAZAWA}&kind=evacuation_site,evacuation_shelter&hazard=tsunami`)).json());
    expect(h.items.map(i => i.id)).toEqual(['fx-site-2']);
  });

  it('empty set inside covered area is 200 items [] (not unsupported, not an error)', async () => {
    const res = await get(make(), 'bbox=36.50,136.60,36.51,136.61');
    expect(res.statusCode).toBe(200);
    const body = AmenityResponse.parse(res.json());
    expect(body.items).toEqual([]);
    expect(body.dataStatus).toBe('fixture');
  });

  it('unsupported region is explicit 200 dataStatus unsupported_region', async () => {
    for (const bbox of ['35.67,139.72,35.69,139.75', '48.85,2.30,48.87,2.33']) {
      const res = await get(make(), `bbox=${bbox}`);
      expect(res.statusCode).toBe(200);
      const body = AmenityResponse.parse(res.json());
      expect(body.dataStatus).toBe('unsupported_region');
      expect(body.items).toEqual([]);
      expect(body.reason).toBeTruthy();
    }
  });

  it('422 for oversize range, malformed bbox, unknown kind/hazard, unknown params', async () => {
    const app = make();
    for (const q of ['bbox=30,130,40,140', 'bbox=1,2,3', 'bbox=a,b,c,d', '', `bbox=${KANAZAWA}&kind=hospital`, `bbox=${KANAZAWA}&hazard=meteor`, `bbox=${KANAZAWA}&x=1`]) {
      const res = await get(app, q);
      expect(res.statusCode, q).toBe(422);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(ApiError.parse(res.json()).code).toBe('VALIDATION_FAILED');
    }
  });

  it('503 retryable when the provider is unavailable (live not connected), never an empty 200', async () => {
    const res = await get(make(new LiveAmenitiesProvider()), `bbox=${KANAZAWA}`);
    expect(res.statusCode).toBe(503);
    const err = ApiError.parse(res.json());
    expect(err.code).toBe('UNAVAILABLE');
    expect(err.retryable).toBe(true);
  });

  it('503 when the provider throws, 422 when it throws a validation PolicyError', async () => {
    const boom: AmenitiesProvider = { search: async () => { throw new Error('secret detail'); } };
    const r = await get(make(boom), `bbox=${KANAZAWA}`);
    expect(r.statusCode).toBe(503);
    expect(r.body).not.toContain('secret detail');
    const bad: AmenitiesProvider = { search: async () => { throw new PolicyError('VALIDATION_FAILED', 'too big', false); } };
    expect((await get(make(bad), `bbox=${KANAZAWA}`)).statusCode).toBe(422);
  });
});
