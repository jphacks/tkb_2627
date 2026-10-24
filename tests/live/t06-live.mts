// T06 opt-in live probe. NOT a vitest test. Usage: npx tsx tests/live/t06-live.mts [--live]
// Without --live: prints the plan, makes 0 calls. With --live AND GOOGLE_MAPS_SERVER_KEY: runs <= HARD_CAP Google calls.
import { mkdirSync, writeFileSync } from 'node:fs';
import { CallCap, HARD_CAP, buildCases, expectedCalls, googleHostOf, summarizeLeg, summarizePlaces, tomorrow10Utc, AREAS } from './t06-lib.ts';

const cases = buildCases();
const plan = { cases: cases.map(c => ({ id: c.id, area: c.area, mode: c.mode, region: c.region })), expectedGoogleCalls: expectedCalls(cases), hardCap: HARD_CAP };
const live = process.argv.includes('--live');
try { process.loadEnvFile('.env'); } catch { /* no .env: rely on the process env */ }

if (!live || !(process.env.GOOGLE_MAPS_SERVER_KEY ?? '').trim()) {
  console.log(JSON.stringify({ ran: false, reason: live ? 'GOOGLE_MAPS_SERVER_KEY is not set' : '--live not passed', plan }, null, 2));
  process.exit(live ? 1 : 0);
}

// Wrap fetch BEFORE importing any app module. Identical Places searches are served from memory (not counted, not sent).
const cap = new CallCap(HARD_CAP);
const realFetch = globalThis.fetch;
const placesCache = new Map<string, { status: number; headers: [string, string][]; body: string }>();
let cacheHits = 0;
globalThis.fetch = (async (input: any, init?: any) => {
  const host = googleHostOf(input);
  if (!host) return realFetch(input, init);
  const ckey = host === 'places.googleapis.com' ? `${typeof input === 'string' ? input : input.url ?? String(input)}|${String(init?.body ?? '')}` : null;
  const hit = ckey ? placesCache.get(ckey) : undefined;
  if (hit) { cacheHits++; return new Response(hit.body, { status: hit.status, headers: hit.headers }); }
  cap.record(host); // throws before exceeding the cap
  const res = await realFetch(input, init);
  if (ckey && res.ok) placesCache.set(ckey, { status: res.status, headers: [...res.headers.entries()], body: await res.clone().text() });
  return res;
}) as typeof fetch;

const { createUser, migrate, openDatabase } = await import('@tkb/db');
const { buildApp } = await import('../../apps/server/src/platform/app.ts');
const { hashPassword } = await import('../../apps/server/src/platform/auth/password.ts');
const { loadConfig } = await import('../../apps/server/src/platform/config.ts');

const PW = 'probe-' + Math.random().toString(36).slice(2) + 'Xx9!long';
const db = openDatabase(':memory:');
migrate(db);
createUser(db, { id: 'user_t06', loginId: 't06-probe', passwordHash: await hashPassword(PW), displayName: 't06', createdAt: new Date().toISOString() });
const config = { ...loadConfig({ ...process.env, PROVIDER_MODE: 'live', SESSION_SECRET: 's'.repeat(40) }), databasePath: ':memory:' };
const app = buildApp({ config, db });

const results: any[] = [];
try {
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { loginId: 't06-probe', password: PW } });
  if (login.statusCode !== 200) throw new Error(`login failed: ${login.statusCode}`);
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  const csrf = login.json().csrfToken as string;
  const post = (payload: object) => app.inject({ method: 'POST', url: '/api/v1/planning-context', payload, headers: { cookie, 'x-csrf-token': csrf } });
  const MAX_PLACES = 4; // same value in both calls so call 2's Places searches hit the in-script cache

  for (const a of AREAS) {
    const mine = cases.filter(c => c.area === a.area);
    const base = { area: a.area, transportMode: 'transit' as const, maxPlaces: MAX_PLACES, timeZone: a.timeZone };
    // Call 1: places only (leg ids are Google place ids, unknown until this returns).
    const r1 = await post(base);
    const b1 = r1.statusCode === 200 ? r1.json() : null;
    const places: any[] = b1?.places ?? [];
    const placeSummary = b1 ? summarizePlaces(places) : null;
    const callsAfterPlaces = { ...cap.counts };
    let r2: any = null, b2: any = null;
    if (places.length >= 2) {
      const departureUtc = tomorrow10Utc(a.timeZone);
      const from = places[0].placeId, to = places[places.length - 1].placeId;
      // Call 2: same area/maxPlaces + the two legs (transit and car). Places come from cache; only 2 Routes calls are sent.
      r2 = await post({ ...base, legs: mine.map(c => ({ fromPlaceId: from, toPlaceId: to, departureUtc, mode: c.mode })) });
      b2 = r2.statusCode === 200 ? r2.json() : null;
    }
    for (const c of mine) {
      const leg = b2?.legs?.find((l: any) => l.mode === c.mode);
      results.push({
        case: c.id, area: c.region === 'domestic' ? 'domestic(金沢)' : 'overseas(パリ)', mode: c.mode, region: c.region,
        httpStatus: { placesCall: r1.statusCode, legsCall: r2?.statusCode ?? null },
        errorCode: (r1.statusCode !== 200 ? r1.json()?.error?.code ?? r1.json()?.code : r2 && r2.statusCode !== 200 ? r2.json()?.error?.code ?? r2.json()?.code : null) ?? null,
        places: placeSummary,
        leg: summarizeLeg(leg),
        unknown: b2?.unknown ?? b1?.unknown ?? null,
        dataMode: b2?.dataMode ?? b1?.dataMode ?? null,
        legsReturned: b2?.legs?.length ?? 0,
        placesCallsAfterCall1: callsAfterPlaces['places.googleapis.com'],
      });
    }
  }
} finally {
  await app.close();
}
const summary = { ran: true, ranAt: new Date().toISOString(), google: { ...cap.counts, total: cap.total, cap: cap.cap, placesCacheHits: cacheHits }, results };
mkdirSync('.local/t06', { recursive: true });
writeFileSync('.local/t06/last-run.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
