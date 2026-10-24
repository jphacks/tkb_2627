// T04 shared helpers (not a test file). Drives apps/ai-local through its public HTTP surface only.
import { expect } from 'vitest';
import { ApiError, JobStatus, SCHEMA_VERSION, type GenerationInput } from '@tkb/contracts';
import type { Runner, RunnerResult } from '@tkb/ai';
import { samplePlanBlueprint } from '@tkb/fixtures';
import { buildApp, type BuildAppOptions } from '../../apps/ai-local/src/app.ts';
import { PairingStore } from '../../apps/ai-local/src/auth/pairing.ts';
import { loadConfig, type PersonalConfig } from '../../apps/ai-local/src/config.ts';
import type { FetchLike } from '../../apps/ai-local/src/shared-client/index.ts';

export const HOST = '127.0.0.1:4311';
export const ORIGIN = 'http://127.0.0.1:4311';
export const UP_COOKIE = 'tkb_sid=UPSTREAMSECRET-COOKIE';
export const UP_CSRF = 'UPSTREAMCSRF-TOKEN';
export const constraints = { area: 'Kanazawa', startDate: '2026-11-01', endDate: '2026-11-02', timeZone: 'Asia/Tokyo', transportMode: 'transit' };
export const placeIds = samplePlanBlueprint.candidates.flatMap(c => c.activityOrder);
export const goodBlueprint = () => structuredClone(samplePlanBlueprint);

/** Realistic Claude Code 2.1.301 `--output-format json` envelope (docs/claude-connection-check.md). */
export const envelope = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: '',
  structured_output: goodBlueprint(),
  num_turns: 2,
  stop_reason: 'end_turn',
  terminal_reason: 'completed',
  api_error_status: null,
  session_id: 'sess-0000',
  uuid: 'uuid-0000',
  duration_ms: 3200,
  duration_api_ms: 3000,
  total_cost_usd: 0.01,
  permission_denials: [],
  ...over,
});
export const ok = (env: unknown): RunnerResult => ({ exitCode: 0, envelope: env, durationMs: 1 });
export const runnerOf = (f: (input: GenerationInput, signal: AbortSignal) => Promise<RunnerResult>) => {
  const calls: { input: GenerationInput; signal: AbortSignal }[] = [];
  const runner: Runner = { run: (input, signal) => (calls.push({ input, signal }), f(input, signal)) };
  return { runner, calls };
};
export const returning = (env: unknown) => runnerOf(async () => ok(env));

export const loginFetch = (userId = 'u1'): FetchLike => async () => {
  const h = new Headers({ 'content-type': 'application/json' });
  h.append('set-cookie', `${UP_COOKIE}; HttpOnly; Path=/`);
  return new Response(JSON.stringify({ userId, displayName: 'Taro', csrfToken: UP_CSRF }), { status: 200, headers: h });
};

export interface Ctx {
  app: ReturnType<typeof buildApp>;
  pairing: PairingStore;
  config: PersonalConfig;
}
const open: Ctx['app'][] = [];
export async function closeAll() {
  while (open.length) await open.pop()!.close();
}
export function make(o: { env?: NodeJS.ProcessEnv; config?: Partial<PersonalConfig>; app?: Partial<BuildAppOptions>; owner?: string } = {}): Ctx {
  const config = { ...loadConfig({ PERSONAL_OWNER_USER_ID: o.owner ?? 'u1', ...o.env }), ...o.config };
  const pairing = new PairingStore({ ttlMs: config.pairingTtlMs });
  const app = buildApp({ config, pairing, fetch: loginFetch(o.owner ?? 'u1'), allowedPlaceIds: placeIds, ...o.app });
  open.push(app);
  return { app, pairing, config };
}

export const post = (c: Ctx, url: string, payload: unknown, headers: Record<string, string> = {}) =>
  c.app.inject({ method: 'POST', url, payload: payload as object, headers: { host: HOST, origin: ORIGIN, ...headers } });

export async function session(c: Ctx) {
  const r = await post(c, '/local/v1/pair', { code: c.pairing.issue() });
  expect(r.statusCode).toBe(200);
  const cookie = String(r.headers['set-cookie']).split(';')[0]!;
  const csrf = (r.json() as { csrfToken: string }).csrfToken;
  const h = { cookie, 'x-csrf-token': csrf };
  const l = await post(c, '/local/v1/auth/login', { loginId: 'a', password: 'b' }, h);
  expect(l.statusCode).toBe(200);
  return { cookie, csrf, h };
}
export const gen = (c: Ctx, h: Record<string, string>, key = 'key-12345678', body: unknown = { constraints }) =>
  post(c, '/local/v1/generations', body, { ...h, 'idempotency-key': key });
export const getJob = (c: Ctx, h: Record<string, string>, id: string) =>
  c.app.inject({ url: `/local/v1/jobs/${id}`, headers: { host: HOST, ...h } });
export const cancel = (c: Ctx, h: Record<string, string>, id: string) => post(c, `/local/v1/jobs/${id}/cancel`, undefined, h);
export const codeOf = (r: { json(): unknown }) => ApiError.parse(r.json()).code;

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
export async function until(f: () => boolean | Promise<boolean>, ms = 3000) {
  for (let t = 0; t < ms; t += 10) {
    if (await f()) return;
    await sleep(10);
  }
  throw new Error('until: timeout');
}
export async function settle(c: Ctx, h: Record<string, string>, jobId: string) {
  let last: JobStatus | undefined;
  await until(async () => {
    last = JobStatus.parse((await getJob(c, h, jobId)).json());
    return last.state === 'succeeded' || last.state === 'failed' || last.state === 'cancelled';
  });
  return last!;
}
export const submit = async (c: Ctx, h: Record<string, string>, key = 'key-12345678') => {
  const r = await gen(c, h, key);
  expect(r.statusCode).toBe(202);
  return (r.json() as { jobId: string }).jobId;
};
export const emptyInput = (): GenerationInput => ({ schemaVersion: SCHEMA_VERSION, constraints: constraints as GenerationInput['constraints'], allowedPlaceIds: [], facts: [], fixedActivities: [], instructions: 'x' });
