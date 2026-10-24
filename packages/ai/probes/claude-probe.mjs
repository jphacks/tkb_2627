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

const isBillingEnv = k => BILLING_ENV.includes(k) || k.startsWith('ANTHROPIC_') || k.startsWith('CLAUDE_CODE_USE_');
/** Child env without any API-billing / alternate-provider variable. */
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !isBillingEnv(k)));

/** shell:false, argument array, fixed timeout (SIGTERM then SIGKILL), bounded output. */
function run(args, { stdin = '', cwd, timeoutMs = 30_000 } = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(BIN, args, { shell: false, cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let errText = '';
    let timedOut = false;
    const cap = 1_000_000;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { if (out.length < cap) out = (out + d).slice(0, cap); });
    child.stderr.on('data', d => { if (errText.length < cap) errText = (errText + d).slice(0, cap); });
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    }, timeoutMs);
    const finish = r => { clearTimeout(timer); clearTimeout(killTimer); resolve({ ...r, timedOut, errLen: errText.length, errText, ms: Date.now() - started }); };
    child.on('error', e => finish({ code: null, spawnError: e.code, out: '' }));
    child.on('close', (code, signal) => finish({ code, signal, out }));
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
report.billingEnv = Object.fromEntries(BILLING_ENV.map(k => [k, k in process.env ? 'SET' : 'unset']));
report.otherAnthropicEnv = Object.keys(process.env).filter(k => isBillingEnv(k) && !BILLING_ENV.includes(k));

// Rejected by the CLI before any model call: costs nothing. Only a fixed stderr prefix is recorded.
const bad = await run(['-p', '--output-format', 'json', '--json-schema', '{"type":"nope"}', '--tools', '', '--no-session-persistence'], { stdin: 'x' });
report.invalidSchema = {
  exitCode: bad.code,
  stdoutBytes: bad.out.length,
  stderrStartsWithSchemaError: bad.errText.startsWith('Error: --json-schema is not a valid JSON Schema'),
};

if (LIVE) {
  const unsafe =
    Object.values(report.billingEnv).includes('SET') || report.otherAnthropicEnv.length > 0 || report.auth.authMethod !== 'claude.ai';
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
      // Never copy result, session_id or uuid values into the report.
      let env = null;
      try { env = JSON.parse(r.out); } catch { /* recorded below */ }
      report.live = {
        exitCode: r.code,
        signal: r.signal ?? null,
        timedOut: r.timedOut,
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
