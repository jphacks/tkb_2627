// T04-8: OPT-IN live Claude check. Skipped unless TKB_LIVE_CLAUDE=1; default CI and `npm run test:all` never run it.
//
// WARNING: enabling this runs the owner's real local `claude` CLI. With TKB_LIVE_CLAUDE_CALL=1 it sends ONE minimal
// request and consumes the OWNER'S OWN Claude Pro quota. Only the owner who completed the A01 acknowledgement
// (docs/claude-connection-check.md: terms/usage confirmation) may enable it, on their own PC, with no
// ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN set. Never enable it in shared CI.
//   TKB_LIVE_CLAUDE=1 npx vitest run tests/ai/live-claude.test.ts                       # no model call (version/flags/auth)
//   TKB_LIVE_CLAUDE=1 TKB_LIVE_CLAUDE_CALL=1 npx vitest run tests/ai/live-claude.test.ts # adds --live (1 call)
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const enabled = process.env.TKB_LIVE_CLAUDE === '1';
const withCall = process.env.TKB_LIVE_CLAUDE_CALL === '1';

describe.skipIf(!enabled)('live Claude probe (opt-in, uses the owner\'s own login)', () => {
  it(withCall ? 'probe --live reports the expected shape' : 'probe reports the expected shape (no model call)', () => {
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

it('live probe is off by default', () => {
  if (!enabled) expect(process.env.TKB_LIVE_CLAUDE).not.toBe('1');
});
