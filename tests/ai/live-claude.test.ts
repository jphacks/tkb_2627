// T04-8: OPT-IN live Claude check. Skipped unless TKB_LIVE_CLAUDE=1; default CI and `npm run test:all` never run it.
//
// WARNING: enabling this runs the owner's real local `claude` CLI. With TKB_LIVE_CLAUDE_CALL=1 it sends ONE minimal
// request and consumes the OWNER'S OWN Claude Pro quota. Only the owner who completed the A01 acknowledgement
// (docs/claude-connection-check.md: terms/usage confirmation) may enable it, on their own PC, with no
// ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN set. Never enable it in shared CI.
// Default mode (no CALL flag) still runs `claude -p` with an INVALID schema; that has been OBSERVED to stop before a
// model call (docs/claude-connection-check.md) but is not guaranteed by the CLI.
//   TKB_LIVE_CLAUDE=1 npx vitest run tests/ai/live-claude.test.ts                       # version/flags/auth + invalid-schema probe
//   TKB_LIVE_CLAUDE=1 TKB_LIVE_CLAUDE_CALL=1 npx vitest run tests/ai/live-claude.test.ts # adds --live (1 call)
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const enabled = process.env.TKB_LIVE_CLAUDE === '1';
const withCall = process.env.TKB_LIVE_CLAUDE_CALL === '1';

describe.skipIf(!enabled)('live Claude probe (opt-in, uses the owner\'s own login)', () => {
  it(withCall ? 'probe --live reports the expected shape' : 'probe reports the expected shape (invalid-schema probe, observed not to call the model)', () => {
    const args = ['packages/ai/probes/claude-probe.mjs', ...(withCall ? ['--live'] : [])];
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 120_000, shell: false });
    // exit 2 = CLI not found: still a well-formed report
    expect([0, 2]).toContain(r.status);
    const report = JSON.parse(r.stdout) as Record<string, any>;
    expect(typeof report.probedAt).toBe('string');
    expect(report.cli).toBeTypeOf('object');
    if (report.cli.found) {
      expect(report.cli.version).toBeTypeOf('string');
      expect(report.flags).toBeTypeOf('object');
      expect(report.billingEnv).toBeTypeOf('object');
      // never leak credentials or identity into the report
      expect(r.stdout).not.toMatch(/sk-ant-|@[a-z0-9-]+\.[a-z]{2,}/i);
    } else {
      expect(report.cli.reason).toMatch(/CLI_NOT_FOUND|SPAWN_FAILED/);
    }
    if (!withCall) expect(report.live).toBeUndefined();
  });
});

it('live probe is never enabled by repo config (vitest config, CI workflows)', () => {
  const files = ['vitest.config.ts', ...readdirSync('.github/workflows').filter(f => /\.ya?ml$/.test(f)).map(f => `.github/workflows/${f}`)];
  for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/TKB_LIVE_CLAUDE/);
});
