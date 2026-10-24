import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CandidateBlueprint, GenerationInput, PlanBlueprint } from '@tkb/contracts';
import { domesticTrip, kanazawaPlaces, samplePlanBlueprint } from '@tkb/fixtures';
import {
  ClaudeCodeRunner,
  checkClaudeCli,
  PLAN_BLUEPRINT_JSON_SCHEMA,
  buildChildEnv,
  buildPrompt,
  parseBlueprint,
} from '../src/index.ts';

const SECRET = 'sk-ant-SENTINEL-SECRET';
const input: GenerationInput = GenerationInput.parse({
  schemaVersion: 1,
  constraints: domesticTrip.constraints,
  allowedPlaceIds: kanazawaPlaces.map(p => p.placeId),
  facts: kanazawaPlaces.map(place => ({ kind: 'place', place })),
  fixedActivities: [],
  instructions: 'Plan a relaxed trip.',
});

const FAKE = `#!/usr/bin/env node
const fs = require('node:fs');
const mode = process.env.FAKE_MODE || 'success';
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => (stdin += d));
const ok = ${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: samplePlanBlueprint })};
const out = o => process.stdout.write(JSON.stringify(o));
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.FAKE_REC, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), envKeys: Object.keys(process.env), stdin }));
  switch (mode) {
    case 'success': return out(ok);
    case 'meta': return out({ ...ok, num_turns: 2, duration_api_ms: 1234, modelUsage: { 'claude-test-model': { inputTokens: 1 } }, result: 'CONTENT-MARK' });
    case 'is_error': return out({ ...ok, is_error: true, subtype: 'error_during_execution' });
    case 'no_structured': return out({ type: 'result', subtype: 'success', is_error: false, result: 'text' });
    case 'limit': out({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: 'RAWTEXT usage limit' }); return process.exit(1);
    case 'auth': out({ type: 'result', is_error: true, api_error_status: 401, result: 'RAWTEXT' }); return process.exit(1);
    case 'overloaded': out({ type: 'result', is_error: true, api_error_status: 529, result: 'RAWTEXT' }); return process.exit(1);
    case 'textlimit': out({ type: 'result', is_error: true, api_error_status: 500, num_turns: 3, result: 'usage limit' }); return process.exit(1);
    case 'textlimit_notturns': out({ type: 'result', is_error: true, num_turns: 0, result: 'usage limit reached' }); return process.exit(1);
    case 'nonjson': return process.stdout.write('RAWTEXT not json');
    case 'exit2': process.stderr.write('RAWSTDERR'); return process.exit(2);
    case 'big': { const b = 'x'.repeat(4096); const t = setInterval(() => process.stdout.write(b), 1); return t; }
    case 'hang': process.on('SIGTERM', () => {}); return setInterval(() => {}, 1000);
    case 'grandchild': {
      const gc = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true });
      gc.unref();
      fs.writeFileSync(process.env.FAKE_REC + '.gc', String(gc.pid));
      return process.exit(0);
    }
    case 'hang_term': return setInterval(() => {}, 1000);
  }
});
`;

let dir: string;
let bin: string;
let rec: string;
let n = 0;
const env = (mode: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  FAKE_MODE: mode,
  FAKE_REC: rec,
  ...extra,
});
const runner = (mode: string, o: Partial<ConstructorParameters<typeof ClaudeCodeRunner>[0]> = {}) =>
  new ClaudeCodeRunner({ bin, model: 'sonnet', timeoutMs: 10_000, killGraceMs: 200, tmpRoot: dir, env: env(mode), preflight: async () => ({ found: true, loggedIn: true, authMethod: 'claude.ai', reason: null }), ...o });
const recorded = () => JSON.parse(readFileSync(rec, 'utf8')) as { argv: string[]; cwd: string; envKeys: string[]; stdin: string };
const run = (mode: string, o = {}) => runner(mode, o).run(input, new AbortController().signal);

describe.skipIf(process.platform === 'win32')('ClaudeCodeRunner', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tkb-runner-test-'));
    bin = join(dir, 'fake-claude');
    writeFileSync(bin, FAKE);
    chmodSync(bin, 0o755);
    rec = join(dir, `rec-${n++}.json`);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('runs with exact args, prompt on stdin, and fresh cwd removed afterwards', async () => {
    const r = await run('success');
    expect(r.exitCode).toBe(0);
    expect(r.error).toBeUndefined();
    const p = parseBlueprint(r.envelope, input.allowedPlaceIds);
    expect(p.ok).toBe(true);
    const rc = recorded();
    expect(rc.argv).toEqual([
      '-p', '--output-format', 'json', '--json-schema', JSON.stringify(PLAN_BLUEPRINT_JSON_SCHEMA),
      '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--model', 'sonnet',
    ]);
    expect(rc.argv).not.toContain('--bare');
    expect(rc.argv).not.toContain('--dangerously-skip-permissions');
    expect(rc.stdin).toBe(buildPrompt(input));
    expect(rc.stdin).not.toContain(SECRET);
    expect(rc.cwd.startsWith(dir) || rc.cwd.includes('tkb-claude-')).toBe(true);
    expect(rc.cwd).not.toBe(dir);
    expect(existsSync(rc.cwd)).toBe(false);
    expect(readdirSync(dir).filter(f => f.startsWith('tkb-claude-'))).toEqual([]);
  });

  it('reports content-free run metadata (model from modelUsage keys, turns, API time)', async () => {
    const r = await run('meta');
    expect(r.meta).toEqual({ model: 'claude-test-model', numTurns: 2, durationApiMs: 1234 });
    expect(JSON.stringify(r.meta)).not.toContain('CONTENT-MARK');
    expect((await run('success')).meta).toEqual({ model: null, numTurns: null, durationApiMs: null });
  });

  it('buildPrompt contains only the input fields', () => {
    const body = JSON.parse(buildPrompt(input).split('INPUT:\n')[1]!);
    expect(Object.keys(body).sort()).toEqual(['allowedPlaceIds', 'constraints', 'facts', 'fixedActivities', 'instructions']);
  });

  it('spawn receives the filtered env, no shell, detached group', async () => {
    const seen: { env?: NodeJS.ProcessEnv; shell?: unknown; detached?: unknown } = {};
    const spawnImpl = ((b: string, a: string[], o: SpawnOptions) => {
      seen.env = o.env;
      seen.shell = o.shell;
      seen.detached = o.detached;
      return nodeSpawn(b, a, o);
    }) as typeof nodeSpawn;
    await run('success', { spawnImpl, env: env('success', { HOME: '/h', LANG: 'C', claude_config_x: '1' }) });
    expect(seen.env).toEqual(buildChildEnv(env('success', { HOME: '/h', LANG: 'C', claude_config_x: '1' })));
    expect(seen.env).toMatchObject({ HOME: '/h', LANG: 'C', FAKE_MODE: 'success' });
    expect(seen.shell).toBe(false);
    expect(seen.detached).toBe(true);
  });

  it('billing and config keys are matched case-insensitively', async () => {
    expect(buildChildEnv({ anthropic_api_key: 'x', Claude_Code_Use_Vertex: '1', claude_config_dir: '/c', A: '1' })).toEqual({ A: '1' });
    const r = await run('success', { env: env('success', { anthropic_api_key: '' }) });
    expect(r.error?.message).toBe('API billing environment detected; refusing to run.');
    rmSync(rec, { force: true });
    const c = await run('success', { env: env('success', { CLAUDE_CONFIG_DIR: '/x' }) });
    expect(c.error?.code).toBe('CLI_NOT_AUTHENTICATED');
    expect(c.error?.message).toBe('Alternate Claude config detected; refusing to run.');
    expect(existsSync(rec)).toBe(false);
  });

  it('abort during mkdtemp: no spawn, temp dir removed', async () => {
    rmSync(rec, { force: true });
    let spawned = false;
    const spawnImpl = ((...a: Parameters<typeof nodeSpawn>) => {
      spawned = true;
      return nodeSpawn(...a);
    }) as typeof nodeSpawn;
    const ac = new AbortController();
    const p = runner('success', { spawnImpl }).run(input, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(spawned).toBe(false);
    expect(existsSync(rec)).toBe(false);
    expect(readdirSync(dir).filter(f => f.startsWith('tkb-claude-'))).toEqual([]);
  });

  it('a grandchild holding stdout cannot hang run()', async () => {
    const t = Date.now();
    const r = await run('grandchild', { timeoutMs: 300, exitGraceMs: 200, killGraceMs: 200 });
    const gc = Number(readFileSync(rec + '.gc', 'utf8'));
    try {
      expect(r.error?.code).toBe('CLI_TIMEOUT');
      expect(Date.now() - t).toBeLessThan(5000);
    } finally {
      try { process.kill(gc, 'SIGKILL'); } catch { /* gone */ }
    }
  });

  it('refuses an unsafe tmpRoot and fails with a path-free error when mkdtemp fails', async () => {
    const open = join(dir, 'open');
    mkdirSync(open);
    chmodSync(open, 0o777);
    const r = await run('success', { tmpRoot: open });
    expect(r.error).toMatchObject({ code: 'CLI_EXIT', message: 'The generator could not be started.' });
    const sticky = join(dir, 'sticky');
    mkdirSync(sticky);
    chmodSync(sticky, 0o1777);
    expect((await run('success', { tmpRoot: sticky })).error).toBeUndefined();
    const m = await run('success', { tmpRoot: join(dir, 'missing') });
    expect(m.error?.message).toBe('The generator could not be started.');
    expect(JSON.stringify(m)).not.toContain(dir);
  });

  it('default tmpRoot is an owner-only directory', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tkb-home-'));
    const old = process.env.HOME;
    process.env.HOME = home;
    try {
      const r = await run('success', { tmpRoot: undefined });
      expect(r.error).toBeUndefined();
      const root = join(home, '.cache', 'tkb-claude');
      expect(statSync(root).mode & 0o777).toBe(0o700);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      process.env.HOME = old;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('free-text classification is ignored when api_error_status exists or turns ran', async () => {
    const r = await run('textlimit');
    expect(r.error?.code).toBe('CLI_EXIT');
    const r2 = await run('textlimit_notturns');
    expect(r2.error?.code).toBe('CLI_LIMIT');
  });

  it('buildChildEnv strips billing variables and the child sees none', async () => {
    const parent = { PATH: '/bin', ANTHROPIC_API_KEY: SECRET, ANTHROPIC_FOO: 'x', CLAUDE_CODE_USE_BEDROCK: '', CLAUDE_CODE_OAUTH_TOKEN: SECRET, HOME: '/h' };
    expect(buildChildEnv(parent)).toEqual({ PATH: '/bin', HOME: '/h' });
    await run('success');
    expect(recorded().envKeys.filter(k => k.startsWith('ANTHROPIC_') || k.startsWith('CLAUDE_CODE_'))).toEqual([]);
  });

  it('refuses without spawning when a billing variable is present (even empty)', async () => {
    for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_OAUTH_TOKEN']) {
      rmSync(rec, { force: true });
      const r = await run('success', { env: env('success', { [k]: '' }) });
      expect(r.error?.code).toBe('CLI_NOT_AUTHENTICATED');
      expect(r.error?.message).toBe('API billing environment detected; refusing to run.');
      expect(existsSync(rec)).toBe(false);
    }
  });

  it('rejects an invalid GenerationInput', async () => {
    await expect(runner('success').run({} as GenerationInput, new AbortController().signal)).rejects.toThrow();
  });

  it('classifies failures with fixed messages only', async () => {
    const cases: [string, string, boolean][] = [
      ['limit', 'CLI_LIMIT', false],
      ['auth', 'CLI_NOT_AUTHENTICATED', false],
      ['overloaded', 'CLI_EXIT', true],
      ['exit2', 'CLI_EXIT', true],
      ['is_error', 'CLI_EXIT', false],
      ['nonjson', 'INVALID_OUTPUT', true],
      ['no_structured', 'INVALID_OUTPUT', true],
    ];
    for (const [mode, code, retryable] of cases) {
      const r = await run(mode);
      expect(r.error?.code, mode).toBe(code);
      expect(r.error?.retryable, mode).toBe(retryable);
      expect(JSON.stringify(r)).not.toMatch(/RAW/);
      expect(r.envelope).toBeNull();
    }
  });

  it('kills the child and returns INVALID_OUTPUT when stdout exceeds the cap', async () => {
    const r = await run('big', { maxOutputBytes: 10_000 });
    expect(r.error?.code).toBe('INVALID_OUTPUT');
  });

  it('times out with CLI_TIMEOUT, escalating to SIGKILL when SIGTERM is ignored', async () => {
    const t = Date.now();
    const r = await run('hang', { timeoutMs: 300, killGraceMs: 200 });
    expect(r.error?.code).toBe('CLI_TIMEOUT');
    expect(r.error?.retryable).toBe(true);
    expect(Date.now() - t).toBeLessThan(5000);
    const r2 = await run('hang_term', { timeoutMs: 300 });
    expect(r2.error?.code).toBe('CLI_TIMEOUT');
  });

  it('abort rejects with AbortError and kills the child', async () => {
    const ac = new AbortController();
    const p = runner('hang', { killGraceMs: 200 }).run(input, ac.signal);
    setTimeout(() => ac.abort(), 300);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(readdirSync(dir).filter(f => f.startsWith('tkb-claude-'))).toEqual([]);
    const pre = new AbortController();
    pre.abort();
    await expect(runner('success').run(input, pre.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reports a missing binary', async () => {
    const r = await run('success', { bin: join(dir, 'does-not-exist') });
    expect(r.error?.code).toBe('CLI_EXIT');
    expect(r.error?.message).toBe('Claude Code CLI not found.');
    const r2 = await run('success', { bin: 'definitely-not-a-command-xyz' });
    expect(r2.error?.message).toBe('Claude Code CLI not found.');
  });

  it('validates bin and model at construction', () => {
    const base = { model: 'sonnet', timeoutMs: 1000 };
    for (const b of ['claude; rm -rf', '../x', 'a b', '', './claude', '/a/../b', '-x', '$(id)', '/a b/c', 'claude.cmd', '/x/claude.BAT'])
      expect(() => new ClaudeCodeRunner({ ...base, bin: b }), b).toThrow();
    for (const b of ['claude', '/usr/local/bin/claude']) expect(() => new ClaudeCodeRunner({ ...base, bin: b })).not.toThrow();
    for (const m of ['gpt-4', '--bare', 'sonnet;x', 'claude-', 'Claude-x', ''])
      expect(() => new ClaudeCodeRunner({ bin: 'claude', model: m, timeoutMs: 1000 }), m).toThrow();
    expect(() => new ClaudeCodeRunner({ bin: 'claude', model: 'claude-sonnet-4-5', timeoutMs: 1000 })).not.toThrow();
  });
});

describe('PLAN_BLUEPRINT_JSON_SCHEMA', () => {
  it('sample blueprint satisfies PlanBlueprint', () => {
    expect(PlanBlueprint.safeParse(samplePlanBlueprint).success).toBe(true);
  });
  it('edge cases are rejected by zod and declared in the JSON schema', () => {
    const c = samplePlanBlueprint.candidates[0]!;
    const bad = (b: unknown) => expect(PlanBlueprint.safeParse(b).success).toBe(false);
    bad({ schemaVersion: 1, candidates: [c, c, c, c] });
    bad({ schemaVersion: 1, candidates: [] });
    bad({ schemaVersion: 1, candidates: [{ ...c, activityOrder: [] }] });
    bad({ schemaVersion: 1, candidates: [{ ...c, activityOrder: ['a', 'a'] }] });
    bad({ schemaVersion: 1, candidates: [{ ...c, candidateId: 'bad id!' }] });
    bad({ schemaVersion: 1, candidates: [{ ...c, candidateId: 'x'.repeat(129) }] });
    bad({ schemaVersion: 2, candidates: [c] });
    const s = PLAN_BLUEPRINT_JSON_SCHEMA;
    const cand = s.properties.candidates.items;
    expect(s.properties.candidates.maxItems).toBe(3);
    expect(s.properties.candidates.minItems).toBe(1);
    expect(cand.properties.activityOrder.minItems).toBe(1);
    expect(cand.properties.activityOrder.uniqueItems).toBe(true);
    expect(s.properties.schemaVersion.const).toBe(1);
    expect(cand.properties.candidateId).toMatchObject({ pattern: '^[A-Za-z0-9_-]+$', maxLength: 128, minLength: 1 });
    expect(cand.properties.activityOrder.items).toMatchObject({ pattern: '^[A-Za-z0-9_-]+$', maxLength: 128 });
  });
  it('key sets mirror the zod shapes', () => {
    const s = PLAN_BLUEPRINT_JSON_SCHEMA;
    const cand = s.properties.candidates.items;
    expect(Object.keys(s.properties).sort()).toEqual(Object.keys(PlanBlueprint.shape).sort());
    expect(Object.keys(cand.properties).sort()).toEqual(Object.keys(CandidateBlueprint.shape).sort());
    const optional = (shape: Record<string, { isOptional(): boolean }>) =>
      Object.keys(shape).filter(k => !shape[k]!.isOptional()).sort();
    expect([...s.required].sort()).toEqual(optional(PlanBlueprint.shape));
    expect([...cand.required].sort()).toEqual(optional(CandidateBlueprint.shape));
    expect(s.additionalProperties).toBe(false);
    expect(cand.additionalProperties).toBe(false);
  });
});

const AUTH_FAKE = `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.FAKE_REC, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), envKeys: Object.keys(process.env) }));
switch (process.env.FAKE_AUTH) {
  case 'ok': return console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', apiProvider: 'firstParty', email: 'me@example.com', orgName: 'SECRETORG' }));
  case 'out': return console.log(JSON.stringify({ loggedIn: false, authMethod: 'none' }));
  case 'bedrock': return console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock' }));
  case 'noprovider': return console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }));
  case 'exit1': console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' })); return process.exit(1);
  case 'apikey': return console.log(JSON.stringify({ loggedIn: true, authMethod: 'api_key' }));
  case 'garbage': return console.log('<<< not json');
  case 'hang': return setInterval(() => {}, 1000);
}
`;

describe.skipIf(process.platform === 'win32')('checkClaudeCli (W1 preflight)', () => {
  let d: string;
  let b: string;
  let r: string;
  beforeAll(() => {
    d = mkdtempSync(join(tmpdir(), 'tkb-auth-test-'));
    b = join(d, 'fake-claude');
    r = join(d, 'rec.json');
    writeFileSync(b, AUTH_FAKE);
    chmodSync(b, 0o755);
  });
  afterAll(() => rmSync(d, { recursive: true, force: true }));
  const chk = (mode: string, o: Record<string, unknown> = {}, extra: Record<string, string> = {}) =>
    checkClaudeCli({ bin: b, tmpRoot: d, timeoutMs: 3000, env: { PATH: process.env.PATH, FAKE_AUTH: mode, FAKE_REC: r, ...extra }, ...o });

  it('logged in via claude.ai is ok, keeps only whitelisted fields, runs exact args in a removed cwd', async () => {
    const res = await chk('ok');
    expect(res).toEqual({ found: true, loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', apiProvider: 'firstParty', reason: null });
    expect(JSON.stringify(res)).not.toMatch(/example\.com|SECRETORG/);
    const rec = JSON.parse(readFileSync(r, 'utf8')) as { argv: string[]; cwd: string };
    expect(rec.argv).toEqual(['auth', 'status', '--json']);
    expect(existsSync(rec.cwd)).toBe(false);
  });
  it('logged out, api-key method and garbage output are CLI_NOT_AUTHENTICATED', async () => {
    expect((await chk('out')).reason).toBe('CLI_NOT_AUTHENTICATED');
    const k = await chk('apikey');
    expect(k).toMatchObject({ found: true, loggedIn: true, authMethod: 'api_key', reason: 'CLI_NOT_AUTHENTICATED' });
    expect((await chk('garbage')).reason).toBe('CLI_NOT_AUTHENTICATED');
    for (const m of ['bedrock', 'noprovider', 'exit1']) expect((await chk(m)).reason, m).toBe('CLI_NOT_AUTHENTICATED');
  });
  it('timeout is not ok; missing binary is CLI_NOT_FOUND', async () => {
    expect((await chk('hang', { timeoutMs: 300, killGraceMs: 100 })).reason).toBe('CLI_NOT_AUTHENTICATED');
    expect(await checkClaudeCli({ bin: join(d, 'nope'), tmpRoot: d, env: { PATH: process.env.PATH } })).toEqual({ found: false, reason: 'CLI_NOT_FOUND' });
  });
  it('billing env refuses without spawning', async () => {
    const res = await chk('ok', {}, { ANTHROPIC_API_KEY: 'x' });
    expect(res.reason).toBe('CLI_NOT_AUTHENTICATED');
  });
  it('default run() gate runs a fresh preflight before every spawn (no cache)', async () => {
    let n = 0;
    const pf = async () => {
      n++;
      return { found: true, loggedIn: true, authMethod: 'claude.ai', reason: null as null };
    };
    const rr = runner('success', { preflight: pf });
    await rr.run(input, new AbortController().signal);
    await rr.run(input, new AbortController().signal);
    expect(n).toBe(2);
  });
  it('run() refuses when the preflight is not ok and does not spawn; default preflight uses the fake CLI', async () => {
    const calls: string[] = [];
    const refused = await run('success', { preflight: async () => ({ found: true, loggedIn: false, reason: 'CLI_NOT_AUTHENTICATED' as const }), spawnImpl: ((...a: unknown[]) => { calls.push(String(a[0])); throw new Error('no'); }) as never });
    expect(refused.error?.code).toBe('CLI_NOT_AUTHENTICATED');
    expect(calls).toEqual([]);
    const nf = await run('success', { preflight: async () => ({ found: false, reason: 'CLI_NOT_FOUND' as const }) });
    expect(nf.error?.code).toBe('CLI_EXIT');
    // default preflight: the AUTH_FAKE only answers auth status, so a logged-out fake blocks run()
    const dflt = new ClaudeCodeRunner({ bin: b, model: 'sonnet', timeoutMs: 3000, tmpRoot: d, env: { PATH: process.env.PATH, FAKE_AUTH: 'out', FAKE_REC: r } });
    expect((await dflt.run(input, new AbortController().signal)).error?.code).toBe('CLI_NOT_AUTHENTICATED');
  });
});
