// `npm run review`: one command to open every UI screen on this PC and on a phone (same Wi-Fi).
// Fixture data only: never calls Google, never runs Claude, uses a separate DB under .local/review/.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canListenAll, formatReady, needsSeed, pickLanIp, pickPort, planUsers, reviewEnv } from './lib/review-core.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = join(root, '.local', 'review');
const dbPath = join(dir, 'review.sqlite');
const LOGINS = ['demo-a', 'demo-b'];
const die = msg => {
  console.error(`エラー: ${msg}`);
  process.exit(1);
};

// 1) Preparation that needs no dependencies.
if (!existsSync(join(root, 'node_modules'))) {
  console.log('初回の準備をしています（npm ci。数分かかることがあります）...');
  const r = spawnSync('npm', ['ci'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) die('npm ci に失敗しました。ネットワークを確認して、もう一度 npm run review を実行してください。');
}
if (!existsSync(join(root, '.env')) && existsSync(join(root, '.env.example'))) {
  copyFileSync(join(root, '.env.example'), join(root, '.env'), 1 /* COPYFILE_EXCL: never overwrite */);
}
mkdirSync(dir, { recursive: true });

// 2) Ports: API on loopback only, web on all interfaces.
// 4311 is the personal (Claude) entry; never take it for the review API.
const apiPort = await pickPort(4310, 4310, p => canListenAll(p)) ?? await pickPort(4320, 4329, p => canListenAll(p));
const webPort = await pickPort(5173, 5182, p => canListenAll(p));
if (apiPort === null || webPort === null) die('空いているポートが見つかりません。他のアプリを閉じてからやり直してください。');

const env = reviewEnv(process.env, { dbPath, apiPort, webPort, sessionSecret: randomBytes(32).toString('hex') });

// 3) Users (reuse scripts/create-user.mjs logic: db package + hashPassword).
const { register } = await import('tsx/esm/api');
register();
const { openDatabase, migrate, createUser, getUserByLoginId } = await import('../packages/db/src/index.ts');
const { hashPassword } = await import('../apps/server/src/platform/auth/password.ts');

const pwFile = login => join(dir, `pw-${login}`);
const db = openDatabase(dbPath);
try {
  migrate(db);
  const existing = new Set(LOGINS.filter(l => getUserByLoginId(db, l)));
  const withPw = new Set(LOGINS.filter(l => existsSync(pwFile(l))));
  for (const { login, action } of planUsers(LOGINS, existing, withPw)) {
    if (action === 'broken') die(`${login} は作成済みですがパスワードの控えがありません。.local/review を消して、もう一度実行してください。`);
    if (action !== 'create') continue;
    const password = randomBytes(16).toString('base64url');
    createUser(db, {
      id: `user_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      loginId: login,
      passwordHash: await hashPassword(password),
      displayName: login === 'demo-a' ? 'デモA' : 'デモB',
      createdAt: new Date().toISOString(),
    });
    writeFileSync(pwFile(login), password, { mode: 0o600 });
    try { chmodSync(pwFile(login), 0o600); } catch { /* Windows */ }
  }
} finally {
  db.close();
}
const creds = LOGINS.map(login => ({ login, password: readFileSync(pwFile(login), 'utf8').trim() }));

// 4) Start the two servers.
const children = [];
let stopping = false;
const stopAll = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill(process.platform === 'win32' ? undefined : 'SIGTERM');
  setTimeout(() => process.exit(code), 1500).unref();
};
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
if (process.platform === 'win32') process.on('SIGHUP', () => stopAll(0));

const spawnChild = (args, cwd, name) => {
  const c = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = '';
  const keep = b => { tail = (tail + b.toString()).slice(-2000); };
  c.stdout.on('data', keep);
  c.stderr.on('data', keep);
  c.once('exit', code => {
    if (!stopping) {
      console.error(`${name} が止まりました（終了コード ${code}）。\n${tail}`);
      stopAll(1);
    }
  });
  children.push(c);
  return () => tail;
};

spawnChild(['--import', 'tsx', 'apps/server/src/main.ts'], root, '共有サーバー');
const viteBin = join(resolve(createRequire(join(root, 'apps/web/package.json')).resolve('vite/package.json'), '..'), 'bin', 'vite.js');
spawnChild([viteBin, '--host', '0.0.0.0', '--port', String(webPort), '--strictPort'], join(root, 'apps/web'), '画面サーバー');

const waitFor = async (url, what) => {
  for (let i = 0; i < 120 && !stopping; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  if (!stopping) { console.error(`${what} が起動しませんでした。`); stopAll(1); }
};
const web = `http://127.0.0.1:${webPort}`;
const api = `http://127.0.0.1:${apiPort}`;
await waitFor(`${api}/api/v1/health`, '共有サーバー');
await waitFor(`${web}/api/v1/health`, '画面サーバー'); // through the Vite proxy
if (stopping) await new Promise(() => {});

// 5) Seed one trip for demo-a through the API (K07 plan-batches + K08 apply-candidate). Idempotent.
const { domesticTrip } = await import('../packages/fixtures/src/index.ts');
async function seed() {
  const res = await fetch(`${api}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ loginId: 'demo-a', password: creds[0].password }),
  });
  if (!res.ok) throw new Error(`login ${res.status}`);
  const { csrfToken } = await res.json();
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  const call = (method, path, payload) =>
    fetch(`${api}${path}`, {
      method,
      headers: { cookie, 'x-csrf-token': csrfToken, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
  const list = await (await call('GET', '/api/v1/trips')).json();
  if (!needsSeed(list)) return;
  const created = await call('POST', '/api/v1/plan-batches', {
    schemaVersion: 1,
    baseTripId: null,
    baseRevision: null,
    generationId: `gen_review_${Date.now()}`,
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
    places: domesticTrip.places, // the trip's own places (#155 added more than kanazawaPlaces has)
    constraints: domesticTrip.constraints,
  });
  if (created.status !== 201) throw new Error(`plan-batches ${created.status}`);
  const { batchId } = await created.json();
  const applied = await call('POST', '/api/v1/trips/apply-candidate', { batchId, candidateId: 'cand_1', tripId: null, expectedRevision: null });
  if (applied.status !== 201) throw new Error(`apply-candidate ${applied.status}`);
}
try {
  await seed();
} catch (e) {
  console.error(`（見本の旅程を作れませんでした: ${e.message}。画面は使えます）`);
}

console.log(formatReady({ webPort, lanIp: pickLanIp(networkInterfaces()), creds }));
