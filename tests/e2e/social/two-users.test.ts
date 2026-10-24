// I04: SNS integration between two independent users against a real server process.
// Each user has a separate cookie jar and a separate createHttpSocialApi client (the U08 screens' client).
// Temp file DB, fixture mode, no Claude execution, no external API, no .env. Backup/restore use the
// O02 library functions (packages/db/src/backup.ts) that scripts/backup.mjs and scripts/restore.mjs wrap.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Post, PostSummary } from '@tkb/contracts';
import { createUser, migrate, openDatabase } from '@tkb/db';
import { domesticTrip, kanazawaTripPlaces } from '@tkb/fixtures';
import { backupDatabase, restoreDatabase } from '../../../packages/db/src/backup.ts';
import { hashPassword } from '../../../apps/server/src/platform/auth/password.ts';
import { createHttpSocialApi, type SocialApi, type SocialResult } from '../../../apps/web/src/screens/social/api.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PW = 'correct horse battery';
const dir = mkdtempSync(join(tmpdir(), 'tkb-e2e-social-'));
const dbPath = join(dir, 'travel.sqlite');
const PRIVATE_NOTE = '予約番号は非公開メモ';

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

async function startServer(db: string): Promise<void> {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const c = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/main.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_PATH: db,
      SHARED_PORT: String(port),
      SHARED_BIND: '127.0.0.1',
      PROVIDER_MODE: 'fixture',
      ALLOW_CLAUDE_EXECUTION: 'false',
      SESSION_SECRET: 'e'.repeat(48),
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
      if (out.includes('listening on')) {
        clearTimeout(t);
        res();
      }
    });
    c.stderr!.on('data', (b: Buffer) => (out += b.toString()));
    c.once('exit', code => {
      clearTimeout(t);
      rej(new Error(`server exited early (${code}): ${out}`));
    });
  });
}

async function stopServer(): Promise<void> {
  const c = child;
  child = null;
  if (!c || c.exitCode !== null) return;
  await new Promise<void>(res => {
    c.once('exit', () => res());
    c.kill('SIGTERM');
  });
}

/** One browser: its own cookie jar (never shared) and its own social client on top of it. */
interface Browser { jar: Map<string, string>; api: SocialApi; csrf: () => string }
function newBrowser(): Browser {
  const jar = new Map<string, string>();
  let csrf = '';
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
    const res = await fetch(input, { ...init, headers });
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      const expired = attrs.some(a => /^\s*max-age=0\s*$/i.test(a)) || value === '';
      if (expired) jar.delete(name);
      else jar.set(name, value);
    }
    const h = headers.get('x-csrf-token');
    if (h) csrf = h;
    return res;
  };
  return { jar, api: createHttpSocialApi({ baseUrl: base, fetchImpl }), csrf: () => csrf };
}

function ok<T>(r: SocialResult<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.status} ${JSON.stringify(r.error)}`);
  return r.data;
}
const status = (r: SocialResult<unknown>): number => r.status;

async function loginAs(loginId: string): Promise<Browser> {
  const b = newBrowser();
  ok(await b.api.login(loginId, PW));
  return b;
}

/** K07/K08 save has no social-client call, so it uses its own raw session (still a separate cookie). */
async function saveTrip(loginId: string): Promise<string> {
  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ loginId, password: PW }),
  });
  const csrf = ((await res.json()) as { csrfToken: string }).csrfToken;
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
  const h = { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf };
  const created = await fetch(`${base}/api/v1/plan-batches`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({
      schemaVersion: 1,
      baseTripId: null,
      baseRevision: null,
      generationId: `gen_${loginId}`,
      candidates: [{
        candidateId: 'cand_1',
        title: domesticTrip.title,
        days: structuredClone(domesticTrip.days),
        reasons: ['fixture'],
        warnings: [...domesticTrip.warnings],
        excludedPlaceIds: [],
        totalKnownCost: [{ amountMinor: 4520, currency: 'JPY' }],
        hasUnknownCost: true,
        validationState: domesticTrip.validationState,
      }],
      places: kanazawaTripPlaces,
      constraints: domesticTrip.constraints,
    }),
  });
  expect(created.status).toBe(201);
  const { batchId } = (await created.json()) as { batchId: string };
  const applied = await fetch(`${base}/api/v1/trips/apply-candidate`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ batchId, candidateId: 'cand_1', tripId: null, expectedRevision: null }),
  });
  expect(applied.status).toBe(201);
  return ((await applied.json()) as { tripId: string }).tripId;
}

async function publish(b: Browser, tripId: string, visibility: 'public' | 'private' | 'group', story: string, groupId: string | null = null): Promise<Post> {
  const preview = ok(await b.api.previewPost({ tripId, sourceRevision: 1, visibility, groupId, story }));
  return ok(await b.api.createPost(preview.previewToken));
}

const ids = (items: PostSummary[]) => items.map(i => i.postId);

let A: Browser;
let B: Browser;
let anon: Browser;
let userA = '';
let userB = '';
let tripA = '';
let publicPost: Post;
let privatePost: Post;
let copyTripId = '';
let groupId = '';
let groupPost: Post;

beforeAll(async () => {
  const db = openDatabase(dbPath);
  migrate(db);
  const hash = await hashPassword(PW);
  for (const id of ['user_a', 'user_b']) {
    createUser(db, { id, loginId: id.replace('_', '-'), passwordHash: hash, displayName: id, createdAt: '2026-10-24T03:00:00Z' });
  }
  db.close();
  await startServer(dbPath);
  A = await loginAs('user-a');
  B = await loginAs('user-b');
  anon = newBrowser();
  tripA = await saveTrip('user-a');
  userA = ok(await A.api.me()).userId;
  userB = ok(await B.api.me()).userId;
}, 60_000);

afterAll(async () => {
  await stopServer();
  rmSync(dir, { recursive: true, force: true });
});

describe('I04 cookie isolation', () => {
  it('each browser has its own jar with its own session cookie', () => {
    expect(A.jar).not.toBe(B.jar);
    expect(A.jar.size).toBeGreaterThan(0);
    expect(B.jar.size).toBeGreaterThan(0);
    expect([...A.jar.values()]).not.toEqual([...B.jar.values()]);
    expect(anon.jar.size).toBe(0);
    expect(userA).not.toBe(userB);
  });
});

describe('I04 scenario 1: public vs private visibility (R20, R26)', () => {
  it('A posts one public and one private post via preview then confirm', async () => {
    const preview = ok(await A.api.previewPost({ tripId: tripA, sourceRevision: 1, visibility: 'public', groupId: null, story: '公開の旅' }));
    expect(JSON.stringify(preview.snapshot)).not.toContain(PRIVATE_NOTE);
    publicPost = ok(await A.api.createPost(preview.previewToken));
    expect(publicPost.visibility).toBe('public');
    privatePost = await publish(A, tripA, 'private', '非公開の旅');
    expect(privatePost.visibility).toBe('private');
    expect(JSON.stringify(publicPost)).not.toContain(PRIVATE_NOTE);
  });

  it('B and anonymous see only the public post in the public feed', async () => {
    const feedB = ok(await B.api.getFeed('public'));
    expect(ids(feedB.items)).toContain(publicPost.postId);
    expect(ids(feedB.items)).not.toContain(privatePost.postId);
    const feedAnon = await anon.api.getFeed('public');
    if (feedAnon.ok) {
      expect(ids(feedAnon.data.items)).toContain(publicPost.postId);
      expect(ids(feedAnon.data.items)).not.toContain(privatePost.postId);
    } else {
      expect(feedAnon.status).toBe(401); // feed may require login; still no private leak
    }
    expect(ids(ok(await A.api.getFeed('mine')).items)).toEqual(expect.arrayContaining([publicPost.postId, privatePost.postId]));
  });

  it('private post direct GET and copy are 404 for B (same as a missing id)', async () => {
    const direct = await B.api.getPost(privatePost.postId);
    expect(status(direct)).toBe(404);
    const missing = await B.api.getPost('post_missing');
    expect(status(missing)).toBe(404);
    if (!direct.ok && !missing.ok) expect({ ...direct.error, requestId: '' }).toEqual({ ...missing.error, requestId: '' });
    expect(status(await B.api.copyPost(privatePost.postId, { newStartDate: '2027-01-10', timeZone: 'Asia/Tokyo' }))).toBe(404);
    expect(ok(await B.api.getPost(publicPost.postId)).postId).toBe(publicPost.postId);
  });
});

describe('I04 scenario 2: copy (R21, R22)', () => {
  it('B copies the public post: 201, needs_revalidation, owner B, no private data', async () => {
    const r = await B.api.copyPost(publicPost.postId, { newStartDate: '2027-01-10', timeZone: 'Asia/Tokyo' });
    expect(status(r)).toBe(201);
    const c = ok(r);
    expect(c.ownerId).toBe(userB);
    expect(c.revision).toBe(1);
    expect(c.validationState).toBe('needs_revalidation');
    copyTripId = c.tripId;
    const trip = ok(await B.api.getTrip(copyTripId));
    expect(trip.ownerId).toBe(userB);
    expect(JSON.stringify(trip)).not.toContain(PRIVATE_NOTE);
    expect(trip.constraints.startDate).toBe('2027-01-10');
    expect(trip.constraints.budget ?? null).toBeNull();
    expect(trip.constraints.departure ?? null).toBeNull();
    expect(trip.constraints.return ?? null).toBeNull();
  });

  it('A cannot read B copy; A original trip and post are unchanged', async () => {
    expect(status(await A.api.getTrip(copyTripId))).toBe(404);
    const mine = ok(await A.api.listMyTrips());
    expect(mine.items.map(t => t.tripId)).toEqual([tripA]);
    expect(mine.items[0]!.revision).toBe(1);
    const again = ok(await A.api.getPost(publicPost.postId));
    expect(again.postRevision).toBe(publicPost.postRevision);
    expect(again.snapshot).toEqual(publicPost.snapshot);
  });
});

describe('I04 scenario 3: group (R20, R26)', () => {
  it('A creates a group and invites B, who accepts with the token', async () => {
    const g = ok(await A.api.createGroup('旅仲間'));
    groupId = g.groupId;
    const inv = ok(await A.api.createInvite(groupId));
    const token = inv.inviteUrl.split('#')[1]!;
    expect(token.length).toBeGreaterThanOrEqual(16);
    expect(status(await anon.api.acceptInvite(token))).toBe(401);
    const m = ok(await B.api.acceptInvite(token));
    expect(m).toMatchObject({ groupId, userId: userB, membership: 'active' });
    expect(ok(await B.api.listGroups()).map(x => x.groupId)).toContain(groupId);
  });

  it('group post is visible to B (feed and GET) but not in the public feed or to anonymous', async () => {
    groupPost = await publish(A, tripA, 'group', 'グループ限定', groupId);
    expect(ok(await B.api.getPost(groupPost.postId)).postId).toBe(groupPost.postId);
    expect(ids(ok(await B.api.getFeed('groups')).items)).toContain(groupPost.postId);
    expect(ids(ok(await B.api.getFeed('public')).items)).not.toContain(groupPost.postId);
    expect(status(await anon.api.getPost(groupPost.postId))).toBeGreaterThanOrEqual(401);
  });

  it('after B leaves, the group post is 404 and gone from B feed', async () => {
    expect(status(await B.api.leaveGroup(groupId, userB))).toBe(204);
    expect(status(await B.api.getPost(groupPost.postId))).toBe(404);
    expect(status(await B.api.copyPost(groupPost.postId, { newStartDate: '2027-02-01', timeZone: 'Asia/Tokyo' }))).toBe(404);
    expect(ids(ok(await B.api.getFeed('groups')).items)).not.toContain(groupPost.postId);
  });
});

describe('I04 scenario 5 (run before 4): backup and restore keep data and ACLs (R25)', () => {
  it('backs up, restarts on the restored DB, and posts, visibility, copy and ACLs hold', async () => {
    const backupPath = join(dir, 'backup.sqlite');
    const restoredPath = join(dir, 'restored.sqlite');
    backupDatabase(dbPath, backupPath);
    await stopServer();
    restoreDatabase(backupPath, restoredPath);
    await startServer(restoredPath);

    const A2 = await loginAs('user-a');
    const B2 = await loginAs('user-b');
    const an2 = newBrowser();
    const mine = ok(await A2.api.getFeed('mine'));
    expect(ids(mine.items)).toEqual(expect.arrayContaining([publicPost.postId, privatePost.postId, groupPost.postId]));
    expect(ok(await A2.api.getPost(publicPost.postId)).snapshot).toEqual(publicPost.snapshot);
    expect(ok(await A2.api.getPost(privatePost.postId)).visibility).toBe('private');

    const pub = ok(await B2.api.getFeed('public'));
    expect(ids(pub.items)).toContain(publicPost.postId);
    expect(ids(pub.items)).not.toContain(privatePost.postId);
    expect(status(await B2.api.getPost(privatePost.postId))).toBe(404);
    expect(status(await B2.api.getPost(groupPost.postId))).toBe(404); // B left the group before the backup
    const copy = ok(await B2.api.getTrip(copyTripId));
    expect(copy.ownerId).toBe(userB);
    expect(copy.validationState).toBe('needs_revalidation');
    expect(status(await A2.api.getTrip(copyTripId))).toBe(404);
    const anonFeed = await an2.api.getFeed('public');
    if (anonFeed.ok) expect(ids(anonFeed.data.items)).not.toContain(privatePost.postId);
    A = A2;
    B = B2;
    anon = an2;
  }, 60_000);
});

describe('I04 scenario 4: unpublish, delete, stale revision (R20)', () => {
  it('stale expectedPostRevision is 409 and changes nothing', async () => {
    const cur = ok(await A.api.getPost(publicPost.postId));
    const stale = await A.api.changeVisibility(publicPost.postId, cur.postRevision + 5, 'private', null);
    expect(status(stale)).toBe(409);
    expect(ok(await B.api.getPost(publicPost.postId)).visibility).toBe('public');
  });

  it('after A unpublishes, B gets 404 on the next GET and feed; the old revision is then 409', async () => {
    const cur = ok(await A.api.getPost(publicPost.postId));
    const changed = ok(await A.api.changeVisibility(publicPost.postId, cur.postRevision, 'private', null));
    expect(changed.visibility).toBe('private');
    expect(status(await B.api.getPost(publicPost.postId))).toBe(404);
    expect(ids(ok(await B.api.getFeed('public')).items)).not.toContain(publicPost.postId);
    expect(status(await A.api.changeVisibility(publicPost.postId, cur.postRevision, 'public', null))).toBe(409);
    // B's earlier copy is an independent trip and stays
    expect(ok(await B.api.getTrip(copyTripId)).ownerId).toBe(userB);
  });

  it('delete removes the post; B cannot delete A posts', async () => {
    expect(status(await B.api.deletePost(privatePost.postId))).toBe(404);
    expect(status(await A.api.deletePost(privatePost.postId))).toBe(204);
    expect(status(await A.api.getPost(privatePost.postId))).toBe(404);
    expect(status(await A.api.deletePost(privatePost.postId))).toBe(404);
  });
});
