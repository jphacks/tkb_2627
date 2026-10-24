// T05-3/5: no unauthorised billing path; secrets stay out of the repository surface. Static + config level, no network.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Capabilities } from '@tkb/contracts';
import { buildApp as buildLocal } from '../../apps/ai-local/src/app.ts';
import { loadConfig as loadLocal } from '../../apps/ai-local/src/config.ts';
import { loadConfig as loadShared } from '../../apps/server/src/platform/config.ts';
import { ROOT, makeShared, read, rel, sourceFiles } from './helpers.ts';

const BILLING = /ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDE_CODE_USE_|api\.anthropic\.com|@anthropic-ai\/|x-api-key|OPENAI_|api\.openai\.com/i;
const PROD_DIRS = ['apps', 'packages', 'scripts'];

describe('T05-3 no unauthorised billing', () => {
  it('only the A01 probe and the A04 runner mention billing env/API names, and only to strip them from the child env', () => {
    const files = sourceFiles(PROD_DIRS, { exts: /\.(ts|tsx|mjs|js|cjs|json)$/, skipTests: true }).filter(f => !/package-lock/.test(f));
    expect(files.length).toBeGreaterThan(40);
    const offenders = files.filter(f => BILLING.test(read(f))).map(rel);
    expect(offenders).toEqual(['packages/ai/probes/claude-probe.mjs', 'packages/ai/src/claude-runner.ts']);
  });

  it('the probe never reads a billing value, never sets one, and spawns with the filtered env only', () => {
    const t = read(join(ROOT, 'packages/ai/probes/claude-probe.mjs'));
    // Every ANTHROPIC_/CLAUDE_CODE_ reference is a deny-list literal or a prefix test, never process.env.<NAME> access.
    expect(t).not.toMatch(/process\.env\.(ANTHROPIC|CLAUDE_CODE)/);
    expect(t).not.toMatch(/process\.env\[\s*['"`](ANTHROPIC|CLAUDE_CODE)/);
    expect(t).not.toMatch(/(env|childEnv)\.(ANTHROPIC|CLAUDE_CODE)\w*\s*=/);
    expect(t).toContain("const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !isBillingEnv(k)))");
    const spawns = [...t.matchAll(/spawn\(([^)]*)\)/g)].map(m => m[1]!);
    expect(spawns.length).toBeGreaterThan(0);
    for (const s of spawns) {
      expect(s).toMatch(/env:\s*childEnv/);
      expect(s).toMatch(/shell:\s*false/);
    }
    expect(t).not.toMatch(/\.\.\.process\.env|env:\s*process\.env/);
    expect(t).not.toMatch(/--dangerously-skip-permissions/);
  });

  it('the A04 runner never reads or sets a billing value and spawns with the filtered env only', () => {
    const t = read(join(ROOT, 'packages/ai/src/claude-runner.ts'));
    expect(t).not.toMatch(/process\.env\.(ANTHROPIC|CLAUDE_CODE)/);
    expect(t).not.toMatch(/process\.env\[\s*['"`](ANTHROPIC|CLAUDE_CODE)/);
    expect(t).not.toMatch(/\.\.\.process\.env|env:\s*process\.env/);
    expect(t).not.toMatch(/--dangerously-skip-permissions|'--bare'/);
    expect(t).toMatch(/shell:\s*false/);
    expect(t).toMatch(/env:\s*buildChildEnv\(/);
    expect(t).not.toMatch(/shell:\s*true|\bexecSync?\(|\bexecFile/);
  });

  it('no production module outside the probe and the A04 runner can start a process with the inherited environment', () => {
    for (const f of sourceFiles(['apps', 'packages'], { skipTests: true })) {
      const t = read(f);
      if (rel(f) === 'packages/ai/probes/claude-probe.mjs' || rel(f) === 'packages/ai/src/claude-runner.ts') continue;
      expect(t, rel(f)).not.toMatch(/child_process/);
      expect(t, rel(f)).not.toMatch(/\.\.\.process\.env|env:\s*process\.env/);
    }
  });

  it('no dependency on an LLM/provider SDK in any package.json or the lockfile', () => {
    for (const p of ['package.json', 'apps/server/package.json', 'apps/ai-local/package.json', 'apps/web/package.json', 'packages/ai/package.json', 'packages/planner/package.json', 'packages/travel-data/package.json']) {
      if (existsSync(join(ROOT, p))) expect(read(join(ROOT, p)), p).not.toMatch(/@anthropic-ai|"openai"|@google\/generative-ai|@google\/genai|langchain|ollama/i);
    }
    expect(read(join(ROOT, 'package-lock.json'))).not.toMatch(/node_modules\/(@anthropic-ai|openai|ollama|langchain)/);
  });

  it('CI workflows reference no secrets, never run the Claude CLI, and pin execution off', () => {
    const wf = sourceFiles(['.github/workflows'], { exts: /\.ya?ml$/ });
    expect(wf.length).toBeGreaterThan(0);
    for (const f of wf) {
      const t = read(f).split('\n').filter(l => !/^\s*#/.test(l)).join('\n'); // comments may mention the word
      expect(t, rel(f)).not.toMatch(/\$\{\{\s*(secrets|github\.token)|\bsecrets\.|GITHUB_TOKEN|toJSON\(secrets\)/);
      expect(t, rel(f)).not.toMatch(/pull_request_target|workflow_run/); // forks must not reach privileged contexts
      expect(t, rel(f)).not.toMatch(/\bclaude\b\s+(-p|--print|code)|anthropic|claude-code-action|npx\s+claude/i);
      expect(t, rel(f)).toMatch(/permissions:\s*\n\s+contents:\s*read/);
      expect(t, rel(f)).not.toMatch(/ALLOW_CLAUDE_EXECUTION:\s*['"]?true|PROVIDER_MODE:\s*['"]?(live|mixed)/);
    }
    expect(wf.map(f => read(f)).join('\n')).toMatch(/ALLOW_CLAUDE_EXECUTION:\s*'false'/);
  });

  it('vitest pins fixture mode and execution off, so unit tests cannot spend', () => {
    expect(process.env.PROVIDER_MODE).toBe('fixture');
    expect(process.env.ALLOW_CLAUDE_EXECUTION).toBe('false');
  });

  it('defaults: execution disabled, provider fixture, live/mixed provider refused', () => {
    expect(loadLocal({}).allowClaudeExecution).toBe(false);
    for (const v of ['', 'TRUE', '1', 'yes', 'True', ' true']) expect(loadLocal({ ALLOW_CLAUDE_EXECUTION: v }).allowClaudeExecution, JSON.stringify(v)).toBe(false);
    expect(loadShared({ SESSION_SECRET: 's'.repeat(40) }).providerMode).toBe('fixture');
    for (const m of ['live', 'mixed', 'LIVE', 'anthropic']) expect(() => loadShared({ SESSION_SECRET: 's'.repeat(40), PROVIDER_MODE: m }), m).toThrow(/PROVIDER_MODE/);
  });

  it('shared config ignores billing/execution env entirely (nothing is copied, capabilities stay none)', async () => {
    const env = { SESSION_SECRET: 's'.repeat(40), ANTHROPIC_API_KEY: 'sk-ant-LEAKX', CLAUDE_CODE_OAUTH_TOKEN: 'oat-LEAKY', ALLOW_CLAUDE_EXECUTION: 'true', GOOGLE_MAPS_SERVER_KEY: 'GKEYLEAK' };
    expect(JSON.stringify(loadShared(env))).not.toMatch(/LEAK/);
    const s = await makeShared({ ANTHROPIC_API_KEY: 'sk-ant-LEAKX', ALLOW_CLAUDE_EXECUTION: 'true' });
    try {
      const r = await s.app.inject('/api/v1/capabilities');
      expect(Capabilities.parse(r.json()).aiGeneration).toEqual({ available: false, runner: 'none', reason: 'SHARED_ENTRY_NO_PERSONAL_CLAUDE' });
      expect(r.payload).not.toMatch(/LEAK/);
    } finally { await s.app.close(); }
  });

  it('personal capabilities: available=false by default and with execution allowed (no real runner is wired)', async () => {
    for (const allow of [undefined, 'false', 'true']) {
      const app = buildLocal({ config: loadLocal({ PERSONAL_OWNER_USER_ID: 'u1', ...(allow ? { ALLOW_CLAUDE_EXECUTION: allow } : {}) }) });
      try {
        const r = await app.inject({ url: '/local/v1/capabilities', headers: { host: '127.0.0.1:4311' } });
        const c = Capabilities.parse(r.json());
        expect(c.aiGeneration.available, String(allow)).toBe(false);
        expect(c.aiGeneration.runner).toBe('fake');
      } finally { await app.close(); }
    }
  });

  it('the personal main entry wires no real runner and the app default runner is the fake (source pin)', () => {
    expect(read(join(ROOT, 'apps/ai-local/src/main.ts'))).not.toMatch(/Runner|claude/i);
    expect(read(join(ROOT, 'apps/ai-local/src/app.ts'))).toMatch(/opts\.runner \?\? new FakeRunner\(\)/);
  });

  // D02 (external API call limits / billing counters) is not integrated yet; add its tests after D02 (see FINDINGS.md).
});

describe('T05-5 secret files and web bundle surface', () => {
  const lines = (f: string) => read(join(ROOT, f)).split('\n').filter(l => /^[A-Z0-9_]+=/.test(l));
  it('env templates hold no values for key/secret/token/password variables and default to safe modes', () => {
    for (const f of ['.env.example', '.env.ai-local.example']) {
      for (const l of lines(f)) {
        const [k, ...v] = l.split('=');
        if (/KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i.test(k!)) expect(v.join('='), `${f} ${k}`).toBe('');
      }
    }
    expect(lines('.env.ai-local.example')).toContain('ALLOW_CLAUDE_EXECUTION=false');
    expect(lines('.env.example')).toContain('PROVIDER_MODE=fixture');
    expect(lines('.env.ai-local.example').join('\n')).not.toMatch(/ANTHROPIC|OAUTH/);
    expect(lines('.env.example').join('\n')).not.toMatch(/ANTHROPIC|OAUTH|ALLOW_CLAUDE/);
    // bind addresses in templates are loopback
    for (const l of [...lines('.env.example'), ...lines('.env.ai-local.example')].filter(l => /_BIND=/.test(l))) expect(l).toMatch(/=127\.0\.0\.1$/);
  });

  it('the web app reads no secret-bearing environment variable (only PUBLIC_/VITE_ allowed names, none server-side)', () => {
    for (const f of sourceFiles(['apps/web/src'], { skipTests: true })) {
      const t = read(f);
      for (const m of t.matchAll(/import\.meta\.env\.(\w+)/g)) expect(m[1], rel(f)).toMatch(/^(MODE|DEV|PROD|BASE_URL|VITE_\w+|PUBLIC_MAPS_BROWSER_KEY)$/);
      expect(t, rel(f)).not.toMatch(/SESSION_SECRET|GOOGLE_MAPS_SERVER_KEY|ANTHROPIC|process\.env/);
    }
  });

  it('.gitignore keeps real env files, databases, credentials and job journals out of Git', () => {
    const g = read(join(ROOT, '.gitignore'));
    for (const p of ['.env', '.env.*', '!.env.example', '!.env.ai-local.example', '.local/', 'data/', '*.sqlite', 'backups/']) expect(g.split('\n'), p).toContain(p);
  });
});
