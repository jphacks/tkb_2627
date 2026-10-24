import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CandidateBlueprint, GenerationInput, PlanBlueprint } from '@tkb/contracts';
import { domesticTrip, kanazawaPlaces, samplePlanBlueprint } from '@tkb/fixtures';
import {
  ClaudeCodeRunner,
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
    case 'is_error': return out({ ...ok, is_error: true, subtype: 'error_during_execution' });
    case 'no_structured': return out({ type: 'result', subtype: 'success', is_error: false, result: 'text' });
    case 'limit': out({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: 'RAWTEXT usage limit' }); return process.exit(1);
    case 'auth': out({ type: 'result', is_error: true, api_error_status: 401, result: 'RAWTEXT' }); return process.exit(1);
    case 'overloaded': out({ type: 'result', is_error: true, api_error_status: 529, result: 'RAWTEXT' }); return process.exit(1);
    case 'nonjson': return process.stdout.write('RAWTEXT not json');
    case 'exit2': process.stderr.write('RAWSTDERR'); return process.exit(2);
    case 'big': { const b = 'x'.repeat(4096); const t = setInterval(() => process.stdout.write(b), 1); return t; }
    case 'hang': process.on('SIGTERM', () => {}); return setInterval(() => {}, 1000);
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
  new ClaudeCodeRunner({ bin, model: 'sonnet', timeoutMs: 10_000, killGraceMs: 200, tmpRoot: dir, env: env(mode), ...o });
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

  it('buildPrompt contains only the input fields', () => {
    const body = JSON.parse(buildPrompt(input).split('INPUT:\n')[1]!);
    expect(Object.keys(body).sort()).toEqual(['allowedPlaceIds', 'constraints', 'facts', 'fixedActivities', 'instructions']);
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
    for (const b of ['claude; rm -rf', '../x', 'a b', '', './claude', '/a/../b', '-x', '$(id)', '/a b/c'])
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
