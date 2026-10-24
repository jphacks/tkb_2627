// I03: 旅行前編集と旅行中の残り再計画の統合 (Issue #48), against a real server process.
// Real apps/server child (real port, temp file DB, PROVIDER_MODE=fixture, no Claude, no Google, no .env).
// The calls go through the clients the screens use (U06 edit/api.ts, U04 itinerary/api.ts, U06 travel/geo.ts)
// wrapped with a cookie-jar fetch. The server clock decides "now", so the trip dates are built from the current time.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlanBatchCreate, PlanBatchCreated, TripWriteResult, type Activity, type PlaceInfo, type PlanCandidate, type ReplanResult, type Trip, type TripOperation } from '@tkb/contracts';
import { createUser, migrate, openDatabase } from '@tkb/db';
import { domesticTrip, kanazawaPlaces } from '@tkb/fixtures';
import { hashPassword } from '../../../apps/server/src/platform/auth/password.ts';
import { createLiveTripEditApi, type ApiResult, type TripEditApi } from '../../../apps/web/src/screens/edit/api.ts';
import { fetchTrip } from '../../../apps/web/src/screens/itinerary/api.ts';
import { buildReplanRequest } from '../../../apps/web/src/screens/travel/geo.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PW = 'correct horse battery';
const dir = mkdtempSync(join(tmpdir(), 'tkb-e2e-replan-'));
const dbPath = join(dir, 'travel.sqlite');

let child: ChildProcess | null = null;
let base = '';

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

async function startServer(): Promise<void> {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const c = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/main.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_PATH: dbPath,
      SHARED_PORT: String(port),
      SHARED_BIND: '127.0.0.1',
      PROVIDER_MODE: 'fixture',
      ALLOW_CLAUDE_EXECUTION: 'false',
      SESSION_SECRET: 'r'.repeat(48),
      PUBLIC_ORIGIN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = c;
  await new Promise<void>((res, rej) => {
    let out = '';
    const t = setTimeout(() => rej(new Error(`server did not start: ${out}`)), 30_000);
    c.stdout!.on('data', (b: Buffer) => {
      out += b.toString();
      if (out.includes('listening on')) { clearTimeout(t); res(); }
    });
    c.stderr!.on('data', (b: Buffer) => (out += b.toString()));
    c.once('exit', code => { clearTimeout(t); rej(new Error(`server exited early (${code}): ${out}`)); });
  });
}

async function stopServer(): Promise<void> {
  const c = child;
  child = null;
  if (!c || c.exitCode !== null) return;
  await new Promise<void>(res => { c.once('exit', () => res()); c.kill('SIGTERM'); });
}

async function login(loginId: string): Promise<string> {
  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId, password: PW }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
}

// ---- the trip: today (in a zone where it is daytime now) so the server clock lands inside day 0 ----
const ZONES: [string, number][] = [
  ['Pacific/Honolulu', -600], ['America/Phoenix', -420], ['Europe/Moscow', 180], ['Asia/Dubai', 240], ['Asia/Kolkata', 330],
  ['Asia/Dhaka', 360], ['Asia/Bangkok', 420], ['Asia/Singapore', 480], ['Asia/Tokyo', 540],
];
const MIN = 60_000;
const nowMs = Date.now();
const localHour = (off: number) => ((((nowMs + off * MIN) % 86_400_000) + 86_400_000) % 86_400_000) / 3_600_000;
const [TZ, OFFSET] = ZONES.reduce((best, z) => (Math.abs(localHour(z[1]) - 10) < Math.abs(localHour(best[1]) - 10) ? z : best));
const T0 = Math.floor(nowMs / MIN) * MIN;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const at = (minFromNow: number) => ({ utc: iso(T0 + minFromNow * MIN), timeZone: TZ });
const localDate = (ms: number) => new Date(ms + OFFSET * MIN).toISOString().slice(0, 10);
const DAY0 = localDate(T0);
const DAY1 = localDate(T0 + 86_400_000);

const act = (id: string, placeId: string, from: number, to: number, extra: Partial<Activity> = {}): Activity => ({
  type: 'activity', activityId: id, kind: 'visit', title: id, placeId, areaName: null,
  start: at(from), end: at(to), fixed: false, status: 'planned', cost: null, costStatus: 'unknown', privateNotes: null, ...extra,
});
const places: PlaceInfo[] = kanazawaPlaces.map(p => ({ ...p, timeZone: TZ }));
const A_DONE = 'act_done', A_NEXT = 'act_next', A_FIXED = 'act_fixed', A_FREE = 'act_free', A_TOMORROW = 'act_tomorrow';

function candidate(): PlanCandidate {
  return {
    candidateId: 'cand_1',
    title: '再計画E2E',
    days: [
      {
        date: DAY0, timeZone: TZ,
        items: [
          act(A_DONE, 'fx_kenrokuen', -150, -90),
          act(A_NEXT, 'fx_21c_museum', 30, 90),
          act(A_FIXED, 'fx_sushi', 180, 240, { fixed: true, kind: 'meal', cost: { amountMinor: 4000, currency: 'JPY' }, costStatus: 'fixture', privateNotes: '予約番号は非公開メモ' }),
          act(A_FREE, 'fx_omicho', 270, 330, { kind: 'free_walk', areaName: '近江町市場周辺' }),
        ],
      },
      { date: DAY1, timeZone: TZ, items: [act('act_d1', 'fx_higashi', 24 * 60 + 60, 24 * 60 + 120, { kind: 'free_walk' })] },
    ],
    reasons: ['i03'], warnings: [], excludedPlaceIds: [],
    totalKnownCost: [{ amountMinor: 4000, currency: 'JPY' }], hasUnknownCost: true, validationState: 'needs_review',
  };
}

let edit: TripEditApi;
let tripId = '';
let a: (path: string, init?: RequestInit) => Promise<Response>;

const ok = <T>(r: ApiResult<T>): T => {
  if (!r.ok) throw new Error(`api error ${r.error.code}: ${r.error.message}`);
  return r.data;
};
const getTrip = async (): Promise<Trip> => {
  const r = await fetchTrip(tripId, { fetch: (u, i) => a(u, i) });
  if (r.state !== 'ok') throw new Error(`fetchTrip ${r.state}`);
  return r.trip;
};
const acts = (t: Trip, d = 0): Activity[] => t.days[d]!.items.filter((i): i is Activity => i.type === 'activity');
const byId = (t: Trip, id: string, d = 0) => acts(t, d).find(x => x.activityId === id);
const csrfToken = async () => ((await (await a('/api/v1/auth/me')).json()) as { csrfToken: string }).csrfToken;
/** All rows of every table of the shared DB, as one string (for the "never stored" check). */
function dumpDb(): string {
  const db = openDatabase(dbPath);
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(r => r.name);
    return JSON.stringify(tables.map(t => db.prepare(`SELECT * FROM "${t}"`).all()));
  } finally { db.close(); }
}

beforeAll(async () => {
  const db = openDatabase(dbPath);
  migrate(db);
  const hash = await hashPassword(PW);
  createUser(db, { id: 'user_a', loginId: 'user-a', passwordHash: hash, displayName: 'A', createdAt: '2026-10-24T03:00:00Z' });
  db.close();
  await startServer();
  const cookie = await login('user-a');
  // A browser-like fetch: keeps the session cookie and resolves the screens' relative URLs.
  a = (path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), cookie } });
  edit = createLiveTripEditApi((u, i) => a(String(u), i));

  // K07 save + K08 adopt, as the smoke test does.
  const csrf = await csrfToken();
  const post = (path: string, payload: unknown) =>
    a(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(payload) });
  const batchBody = PlanBatchCreate.parse({
    schemaVersion: 1, baseTripId: null, baseRevision: null, generationId: 'gen_i03', candidates: [candidate()], places,
    constraints: { ...domesticTrip.constraints, startDate: DAY0, endDate: DAY1, timeZone: TZ },
  });
  const created = await post('/api/v1/plan-batches', batchBody);
  expect(created.status, await created.clone().text()).toBe(201);
  const batch = PlanBatchCreated.parse(await created.json());
  const applied = await post('/api/v1/trips/apply-candidate', { batchId: batch.batchId, candidateId: 'cand_1', tripId: null, expectedRevision: null });
  expect(applied.status, await applied.clone().text()).toBe(201);
  const w = TripWriteResult.parse(await applied.json());
  expect(w.revision).toBe(1);
  tripId = w.tripId;
}, 60_000);

afterAll(async () => {
  await stopServer();
  rmSync(dir, { recursive: true, force: true });
});

const addTomorrow: TripOperation[] = [
  { op: 'add', dayIndex: 1, position: 1, item: act(A_TOMORROW, 'fx_omicho', 24 * 60 + 150, 24 * 60 + 210, { kind: 'free_walk', title: '追加した散策' }) },
  { op: 'set_title', title: '編集後のタイトル' },
];

describe('シナリオ1: 旅行前編集 (alternatives -> PATCH -> GET)', () => {
  it('プレビューは保存せず、候補のoperationsをPATCHすると同じdiffで保存され画面の取得に反映される', async () => {
    const before = await getTrip();
    expect(before.revision).toBe(1);
    const alt = ok(await edit.alternatives(tripId, { expectedRevision: before.revision, operations: addTomorrow, maxAlternatives: 3 }));
    expect(alt.baseRevision).toBe(1);
    expect(await getTrip()).toEqual(before); // preview wrote nothing

    const chosen = alt.candidates.find(c => c.kind === 'requested' && c.operations !== null);
    expect(chosen).toBeTruthy();
    // R11: the added stop has no known cost, so it is listed as unknown and the known delta stays empty (not 0).
    expect(chosen!.diff.unknownCostItems).toContain(A_TOMORROW);
    expect(chosen!.diff.knownCostDelta).toEqual([]);
    expect(chosen!.trip.days[1]!.items.some(i => i.type === 'activity' && i.activityId === A_TOMORROW)).toBe(true);

    const saved = ok(await edit.patch(tripId, { expectedRevision: alt.baseRevision, operations: chosen!.operations! }));
    expect(saved.revision).toBe(2);
    expect(saved.diff).toEqual(chosen!.diff);

    const after = await getTrip();
    expect(after.revision).toBe(2);
    expect(after.title).toBe('編集後のタイトル');
    expect(byId(after, A_TOMORROW, 1)?.cost).toBeNull();
    expect(byId(after, A_TOMORROW, 1)?.costStatus).toBe('unknown');
    expect(after).toEqual(saved.trip);
    // The other day is untouched by the edit.
    expect(JSON.stringify(after.days[0])).toBe(JSON.stringify(before.days[0]));
  });
});

describe('シナリオ2: 旅行中の再計画 (固定予約・完了済み保持)', () => {
  const replanReq = (rev: number, over: Partial<Parameters<typeof buildReplanRequest>[0]> = {}) =>
    buildReplanRequest({
      expectedRevision: rev, location: { kind: 'unavailable', reason: 'denied' },
      completed: new Set([A_DONE]), pinned: new Set(), missed: new Set(), ...over,
    });

  it('位置不明: 固定予約は変わらず、完了済みが保たれ、operationsのPATCHが画面の取得に反映される', async () => {
    const stored = await getTrip();
    const fixedBefore = JSON.stringify(byId(stored, A_FIXED));
    const res: ReplanResult = ok(await edit.replan(tripId, replanReq(stored.revision)));
    expect(res.baseRevision).toBe(stored.revision);
    expect(res.dayIndex).toBe(0);
    expect(res.start.kind).toBe('last_completed'); // no location: starts from the last completed stop
    expect(await getTrip()).toEqual(stored); // preview wrote nothing

    const c = res.candidates[0]!;
    expect(JSON.stringify(byId(c.trip, A_FIXED))).toBe(fixedBefore);
    expect(c.kept.fixed).toContain(A_FIXED);
    expect(c.kept.completed).toEqual([A_DONE]);
    expect(byId(c.trip, A_DONE)?.status).toBe('completed');
    expect(JSON.stringify(c.trip.days[1])).toBe(JSON.stringify(stored.days[1]));
    expect((c.operations ?? []).some(o => (o.op === 'update' || o.op === 'remove') && o.itemId === A_FIXED)).toBe(false); // a reorder (move) is allowed, a rewrite is not
    expect(c.diff.knownCostDelta.every(m => m.amountMinor !== 0)).toBe(true);

    expect(c.operations).not.toBeNull();
    const saved = ok(await edit.patch(tripId, { expectedRevision: res.baseRevision, operations: c.operations! }));
    expect(saved.revision).toBe(stored.revision + 1);
    expect(saved.diff).toEqual(c.diff);
    const after = await getTrip();
    expect(after.revision).toBe(stored.revision + 1);
    expect(JSON.stringify(byId(after, A_FIXED))).toBe(fixedBefore);
    expect(byId(after, A_DONE)?.status).toBe('completed');
    expect(after).toEqual(saved.trip);
    expect(JSON.stringify(after.days[1])).toBe(JSON.stringify(stored.days[1]));
    expect(acts(after).map(x => x.activityId)).toEqual(acts(c.trip).map(x => x.activityId));
    expect(byId(after, A_NEXT)?.start).toEqual(byId(c.trip, A_NEXT)?.start);
  });

  it('場所指定 + 固定予約を過ぎた: missed が競合として報告され、予約は動かない', async () => {
    const stored = await getTrip();
    const fixedBefore = JSON.stringify(byId(stored, A_FIXED));
    const res = ok(await edit.replan(tripId, replanReq(stored.revision, { location: { kind: 'place', placeId: 'fx_kanazawa_station' }, missed: new Set([A_FIXED]) })));
    expect(res.start.kind).toBe('place');
    expect(res.start.placeId).toBe('fx_kanazawa_station');
    const c = res.candidates[0]!;
    expect(c.reservationConflicts).toContainEqual({ activityId: A_FIXED, reason: 'missed' });
    expect(JSON.stringify(byId(c.trip, A_FIXED))).toBe(fixedBefore);
    expect(c.kept.completed).toContain(A_DONE);
    // An empty list means "nothing to change" (PATCH needs >= 1 operation, so there is nothing to save).
    if (c.operations && c.operations.length > 0) {
      expect(c.operations.some(o => (o.op === 'update' || o.op === 'remove') && o.itemId === A_FIXED)).toBe(false);
      const saved = ok(await edit.patch(tripId, { expectedRevision: res.baseRevision, operations: c.operations }));
      const after = await getTrip();
      expect(after.revision).toBe(saved.revision);
      expect(JSON.stringify(byId(after, A_FIXED))).toBe(fixedBefore);
      expect(byId(after, A_DONE)?.status).toBe('completed');
    }
  });

  it('一時固定(fixedActivityIds)は保存済みfixedを変えない', async () => {
    const stored = await getTrip();
    const res = ok(await edit.replan(tripId, replanReq(stored.revision, { pinned: new Set([A_FREE]) })));
    const c = res.candidates[0]!;
    expect(c.kept.fixed).toContain(A_FREE);
    expect(JSON.stringify(byId(c.trip, A_FREE))).toBe(JSON.stringify(byId(stored, A_FREE)));
    expect(byId(c.trip, A_FREE)?.fixed).toBe(false);
    expect(await getTrip()).toEqual(stored);
  });
});

describe('シナリオ3: 競合保存の拒否', () => {
  it('古いrevisionのプレビューを適用すると409 REVISION_CONFLICTで、旅程は変わらない', async () => {
    const n = await getTrip();
    const altOld = ok(await edit.alternatives(tripId, { expectedRevision: n.revision, operations: [{ op: 'set_title', title: '古いプレビュー由来' }] }));
    // A destination change (operations in the replan request) makes the replan preview carry operations to save.
    const replanOld = ok(await edit.replan(tripId, {
      ...buildReplanRequest({
        expectedRevision: n.revision, location: { kind: 'unavailable', reason: 'skipped' }, completed: new Set([A_DONE]), pinned: new Set(), missed: new Set(),
      }),
      operations: [{ op: 'update', itemId: A_NEXT, item: { ...byId(n, A_NEXT)!, title: '行き先変更' } }],
    }));

    // Another device moves the trip to N+1.
    const other = ok(await edit.patch(tripId, { expectedRevision: n.revision, operations: [{ op: 'set_title', title: '別端末の変更' }] }));
    expect(other.revision).toBe(n.revision + 1);
    const latest = await getTrip();

    const stale1 = await edit.patch(tripId, { expectedRevision: altOld.baseRevision, operations: altOld.candidates.find(c => c.operations)!.operations! });
    expect(stale1.ok).toBe(false);
    if (!stale1.ok) expect(stale1.error.code).toBe('REVISION_CONFLICT');

    const ops = replanOld.candidates[0]!.operations;
    expect(ops?.length ?? 0).toBeGreaterThan(0);
    if (ops) {
      const stale2 = await edit.patch(tripId, { expectedRevision: replanOld.baseRevision, operations: ops });
      expect(stale2.ok).toBe(false);
      if (!stale2.ok) expect(stale2.error.code).toBe('REVISION_CONFLICT');
    }
    // A preview request on the stale revision is refused too.
    const staleReplan = await edit.replan(tripId, buildReplanRequest({
      expectedRevision: n.revision, location: { kind: 'unavailable', reason: 'skipped' }, completed: new Set(), pinned: new Set(), missed: new Set(),
    }));
    expect(staleReplan.ok).toBe(false);
    if (!staleReplan.ok) expect(staleReplan.error.code).toBe('REVISION_CONFLICT');

    const after = await getTrip();
    expect(after).toEqual(latest);
    expect(after.title).toBe('別端末の変更');
    expect(after.revision).toBe(n.revision + 1);
  });
});

describe('シナリオ4: 座標は返さず保存しない', () => {
  it('coords位置で再計画しても応答本文・保存済み旅程・DBに座標が現れない', async () => {
    const stored = await getTrip();
    const point = { lat: 36.55123456, lng: 136.66123456 };
    const req = {
      ...buildReplanRequest({
        expectedRevision: stored.revision, location: { kind: 'coords', point }, completed: new Set([A_DONE]), pinned: new Set(), missed: new Set(),
      }),
      operations: [{ op: 'update', itemId: A_NEXT, item: { ...byId(stored, A_NEXT)!, title: '座標テスト用の変更' } }],
    };
    const raw = await a(`/api/v1/trips/${tripId}/replan`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': await csrfToken() }, body: JSON.stringify(req),
    });
    expect(raw.status).toBe(200);
    const text = await raw.text();
    for (const s of ['36.55123456', '136.66123456', '36.551234', '136.661234']) expect(text).not.toContain(s);
    expect(text).not.toContain('"point"');
    const res = JSON.parse(text) as ReplanResult;
    expect(['coords', 'none']).toContain(res.start.kind);

    const c = res.candidates[0]!;
    expect(c.operations?.length ?? 0).toBeGreaterThan(0);
    ok(await edit.patch(tripId, { expectedRevision: res.baseRevision, operations: c.operations! }));
    const after = await getTrip();
    for (const s of ['36.55123456', '136.66123456']) {
      expect(JSON.stringify(after)).not.toContain(s);
      expect(dumpDb()).not.toContain(s);
    }
  });
});
