// I02 (manual, opt-in): the generation flow with the owner's real Claude Code login and real provider data.
// NOT a test: vitest never imports this file. Run it on the owner's own PC:
//   ALLOW_CLAUDE_EXECUTION=true CLAUDE_TERMS_ACK=true PERSONAL_OWNER_USER_ID=<id> PROVIDER_MODE=mixed \
//   AI_MAX_LIVE_LEGS=4 node --import tsx tests/e2e/generation/live-run.mts --area 金沢 --area <取得不可になりそうな地域>
// Secrets/keys come from the environment or the usual .env.ai-local/.env (read by the app's own loader); this file never reads, prints or stores them.
// The real runner is built ONLY by apps/ai-local/src/runner-factory.ts. This script starts no process itself.
// Output is a redacted summary: counts, dataStatus per item, warnings (place names masked), timings and error codes.
import { randomBytes } from 'node:crypto';
import { JobStatus, PlanBatch, type TripConstraints } from '@tkb/contracts';
import { createUser, migrate, openDatabase } from '@tkb/db';
import { buildApp as buildShared } from '../../../apps/server/src/platform/app.ts';
import { hashPassword } from '../../../apps/server/src/platform/auth/password.ts';
import { loadConfig as loadShared } from '../../../apps/server/src/platform/config.ts';
import { buildApp as buildLocal } from '../../../apps/ai-local/src/app.ts';
import { PairingStore } from '../../../apps/ai-local/src/auth/pairing.ts';
import { loadConfig as loadLocal, loadEnvFile } from '../../../apps/ai-local/src/config.ts';
import { createRunner } from '../../../apps/ai-local/src/runner-factory.ts';
import { MEAL_AFTER_MEAL_WARNING } from '../../../apps/ai-local/src/generation/assemble.ts';
import type { FetchLike } from '../../../apps/ai-local/src/shared-client/index.ts';

const HOST = '127.0.0.1:4311';
const ORIGIN = 'http://127.0.0.1:4311';

function refuse(why: string): never {
  console.error(`refused: ${why}`);
  console.error('live-run needs ALLOW_CLAUDE_EXECUTION=true, CLAUDE_TERMS_ACK=true, PERSONAL_OWNER_USER_ID, PROVIDER_MODE=mixed|live, and AI_MAX_LIVE_LEGS<=6.');
  process.exit(2);
}

function args(argv: string[]): { areas: string[]; days: number } {
  const areas: string[] = [];
  let days = 1;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--area' && argv[i + 1]) areas.push(argv[++i]!);
    else if (argv[i] === '--days' && argv[i + 1]) days = Number(argv[++i]);
    else refuse(`unknown argument ${argv[i]}`);
  }
  if (areas.length === 0) refuse('pass at least one --area <name>');
  if (!Number.isInteger(days) || days < 1 || days > 3) refuse('--days must be 1-3');
  return { areas, days };
}

loadEnvFile();
const env = process.env;
const { areas, days } = args(process.argv.slice(2));
if (env.ALLOW_CLAUDE_EXECUTION !== 'true') refuse('ALLOW_CLAUDE_EXECUTION is not true');
if (env.CLAUDE_TERMS_ACK !== 'true') refuse('CLAUDE_TERMS_ACK is not true');
if (!(env.PERSONAL_OWNER_USER_ID ?? '').trim()) refuse('PERSONAL_OWNER_USER_ID is not set');
if (env.PROVIDER_MODE !== 'mixed' && env.PROVIDER_MODE !== 'live') refuse('PROVIDER_MODE must be mixed or live');
if (Number(env.AI_MAX_LIVE_LEGS ?? 6) > 6) refuse('AI_MAX_LIVE_LEGS must be <= 6');

const localConfig = { ...loadLocal(env), jobDir: null }; // throws on an invalid value (e.g. legs > 6)
const owner = localConfig.ownerUserId!;
const created = await createRunner(localConfig); // the single place the real runner is built
const status = await created.refresh();
if (!status.available || status.runner !== 'claude-code') refuse(`Claude is not available (reason: ${status.reason ?? 'unknown'})`);

// In-process shared server on an in-memory DB, with the owner as its only user (the saved result lives only for this run).
const password = randomBytes(18).toString('base64url');
const db = openDatabase(':memory:');
migrate(db);
createUser(db, { id: owner, loginId: 'live-owner', passwordHash: await hashPassword(password), displayName: 'owner', createdAt: new Date().toISOString() });
const shared = buildShared({ config: { ...loadShared({ ...env, SESSION_SECRET: randomBytes(32).toString('hex') }), databasePath: ':memory:' }, db });
const bridge: FetchLike = async (url, init) => {
  const u = new URL(url);
  const res = await shared.inject({ method: init.method as 'GET' | 'POST', url: u.pathname + u.search, payload: init.body as string | undefined, headers: init.headers as Record<string, string> });
  const h = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (Array.isArray(v)) v.forEach(x => h.append(k, x));
    else if (v !== undefined) h.set(k, String(v));
  }
  return new Response(res.body, { status: res.statusCode, headers: h });
};
const pairing = new PairingStore({ ttlMs: localConfig.pairingTtlMs });
const app = buildLocal({ config: localConfig, pairing, runner: created.runner, fetch: bridge });

const pr = await app.inject({ method: 'POST', url: '/local/v1/pair', payload: { code: pairing.issue() }, headers: { host: HOST, origin: ORIGIN } });
const h = { host: HOST, origin: ORIGIN, cookie: String(pr.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': (pr.json() as { csrfToken: string }).csrfToken };
const lr = await app.inject({ method: 'POST', url: '/local/v1/auth/login', payload: { loginId: 'live-owner', password }, headers: h });
if (lr.statusCode !== 200) refuse(`login failed (${lr.statusCode})`);
const sharedLogin = await shared.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { loginId: 'live-owner', password } });
const sharedHeaders = { cookie: String(sharedLogin.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': sharedLogin.json().csrfToken as string };

const count = <T,>(xs: T[], key: (x: T) => string) => xs.reduce<Record<string, number>>((m, x) => ((m[key(x)] = (m[key(x)] ?? 0) + 1), m), {});
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

console.log(`live-run: mode=${env.PROVIDER_MODE} legsCap=${localConfig.maxLiveLegs} model=${localConfig.claudeModel} areas=${areas.length}`);
let failed = 0;
for (const [n, area] of areas.entries()) {
  const constraints: TripConstraints = { area, startDate: day(10), endDate: day(10 + days - 1), timeZone: 'Asia/Tokyo', transportMode: 'transit' };
  const t0 = Date.now();
  console.log(`\n== area ${n + 1}: ${area}`);
  const g = await app.inject({ method: 'POST', url: '/local/v1/generations', payload: { constraints }, headers: { ...h, 'idempotency-key': `live-${randomBytes(8).toString('hex')}` } });
  if (g.statusCode !== 202) {
    console.log(`submit refused: HTTP ${g.statusCode} code=${g.json().code ?? '-'}`);
    failed++;
    continue;
  }
  const jobId = g.json().jobId as string;
  let job = JobStatus.parse((await app.inject({ url: `/local/v1/jobs/${jobId}`, headers: h })).json());
  const deadline = Date.now() + localConfig.aiTimeoutMs + 30_000;
  while (!['succeeded', 'failed', 'cancelled'].includes(job.state) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1000));
    job = JobStatus.parse((await app.inject({ url: `/local/v1/jobs/${jobId}`, headers: h })).json());
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (job.state !== 'succeeded' || !job.batchId) {
    // Not a success: say so, with the error code only.
    console.log(`result: NOT SUCCEEDED state=${job.state} stage=${job.stage} errorCode=${job.error?.code ?? '-'} retryable=${job.error?.retryable ?? '-'} elapsed=${secs}s`);
    failed++;
    continue;
  }
  const res = await shared.inject({ url: `/api/v1/plan-batches/${job.batchId}`, headers: sharedHeaders });
  const batch = PlanBatch.parse(res.json());
  const names = batch.places.map(p => p.name).filter(x => x.length > 1).sort((a, b) => b.length - a.length);
  const mask = (s: string) => names.reduce((acc, nm) => acc.split(nm).join('<place>'), s);
  console.log(`result: succeeded elapsed=${secs}s k08Fetch=${res.statusCode} candidates=${batch.candidates.length} places=${batch.places.length}`);
  console.log(`places dataStatus: ${JSON.stringify(count(batch.places, p => p.dataStatus))} source: ${JSON.stringify(count(batch.places, p => p.provenance.source))}`);
  for (const c of batch.candidates) {
    const items = c.days.flatMap(d => d.items);
    const acts = items.filter(i => i.type === 'activity');
    const legs = items.filter(i => i.type === 'leg');
    console.log(`- ${c.candidateId}: validation=${c.validationState} activities=${acts.length} legs=${legs.length} unknownCost=${c.hasUnknownCost}`);
    const byPlace = new Map(batch.places.map(p => [p.placeId, p.dataStatus]));
    console.log(`  activity place dataStatus ${JSON.stringify(count(acts, i => (i.type === 'activity' && i.placeId ? byPlace.get(i.placeId) ?? 'missing' : 'no-place')))}; activity cost known ${acts.filter(i => i.type === 'activity' && i.cost !== null).length}/${acts.length}; leg dataStatus ${JSON.stringify(count(legs, i => i.dataStatus))}`);
    console.log(`  legs: fare=null ${legs.filter(l => l.type === 'leg' && l.fare === null).length}/${legs.length}, platform=null ${legs.filter(l => l.type === 'leg' && l.platform === null).length}/${legs.length}`);
    const children = acts.filter(i => i.type === 'activity' && i.parentActivityId);
    console.log(`  grouping: children=${children.length} parents=${new Set(children.map(i => i.type === 'activity' ? i.parentActivityId : null)).size} mealAfterMeal=${c.warnings.includes(MEAL_AFTER_MEAL_WARNING)}`);
    for (const w of c.warnings) console.log(`  warning: ${mask(w).slice(0, 160)}`);
  }
}
await app.close();
await shared.close();
console.log(`\ndone: ${areas.length - failed}/${areas.length} succeeded`);
process.exit(failed === 0 ? 0 : 1);
