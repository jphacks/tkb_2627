#!/usr/bin/env node
// A01: records how the local official Claude Code CLI behaves, without secrets.
// Default: version, help flags, auth method and billing-related env presence only (no model call).
// `--live`: additionally sends ONE minimal structured-output request using the owner's own login.
// Never reads OAuth tokens, never prints email/org, never sets API keys.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = process.env.CLAUDE_BIN || 'claude';
const LIVE = process.argv.includes('--live');
const BILLING_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
];
const REQUIRED_FLAGS = ['--print', '--output-format', '--json-schema', '--tools', '--strict-mcp-config', '--no-session-persistence', '--model', '--bare'];
const SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, echo: { type: 'string' } },
  required: ['ok', 'echo'],
  additionalProperties: false,
};

/** shell:false, argument array, fixed timeout, bounded output. */
function run(args, { stdin = '', cwd, timeoutMs = 30_000, env = process.env } = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(BIN, args, { shell: false, cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let errLen = 0;
    const cap = 1_000_000;
    child.stdout.on('data', d => { if (out.length < cap) out += d; });
    child.stderr.on('data', d => { errLen += d.length; });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', e => { clearTimeout(timer); resolve({ code: null, spawnError: e.code, out: '', errLen, ms: Date.now() - started }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, out, errLen, ms: Date.now() - started }); });
    child.stdin.end(stdin);
  });
}

const report = { probedAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, node: process.version };

const ver = await run(['--version']);
if (ver.spawnError) {
  report.cli = { found: false, reason: ver.spawnError === 'ENOENT' ? 'CLI_NOT_FOUND' : 'SPAWN_FAILED' };
  console.log(JSON.stringify(report, null, 2));
  process.exit(2);
}
report.cli = { found: true, version: ver.out.trim() };

const help = await run(['--help']);
report.flags = Object.fromEntries(REQUIRED_FLAGS.map(f => [f, help.out.includes(f)]));

const auth = await run(['auth', 'status', '--json']);
try {
  const a = JSON.parse(auth.out);
  // Only non-identifying fields.
  report.auth = { loggedIn: a.loggedIn, authMethod: a.authMethod, apiProvider: a.apiProvider, subscriptionType: a.subscriptionType };
} catch {
  report.auth = { parsed: false, exitCode: auth.code };
}
report.billingEnv = Object.fromEntries(BILLING_ENV.map(k => [k, process.env[k] ? 'SET' : 'unset']));

if (LIVE) {
  const unsafe = Object.values(report.billingEnv).includes('SET') || report.auth.authMethod !== 'claude.ai';
  if (unsafe) {
    report.live = { skipped: true, reason: 'API billing env or non-subscription auth detected; refusing to run' };
  } else {
    const cwd = mkdtempSync(join(tmpdir(), 'tkb-claude-probe-'));
    try {
      const args = [
        '-p', '--output-format', 'json', '--json-schema', JSON.stringify(SCHEMA),
        '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--model', process.env.CLAUDE_MODEL || 'sonnet',
      ];
      const r = await run(args, { cwd, timeoutMs: 120_000, stdin: 'Return ok=true and echo="tkb_2627 probe". Do nothing else.' });
      let env = null;
      try { env = JSON.parse(r.out); } catch { /* recorded below */ }
      report.live = {
        exitCode: r.code,
        signal: r.signal ?? null,
        wallMs: r.ms,
        stderrBytes: r.errLen,
        envelopeParsed: env !== null,
        type: env?.type,
        subtype: env?.subtype,
        is_error: env?.is_error,
        num_turns: env?.num_turns,
        hasStructuredOutput: env ? 'structured_output' in env : false,
        structuredOutputMatches: env?.structured_output?.ok === true && env?.structured_output?.echo === 'tkb_2627 probe',
        envelopeKeys: env ? Object.keys(env).sort() : [],
      };
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
}

console.log(JSON.stringify(report, null, 2));
