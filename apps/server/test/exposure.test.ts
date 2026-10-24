import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/platform/app.ts';
import { loadConfig } from '../src/platform/config.ts';

const spies = vi.hoisted(() => ({ spawn: vi.fn(), exec: vi.fn(), execFile: vi.fn(), fork: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({ ...(await importOriginal<typeof import('node:child_process')>()), ...spies }));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC = join(ROOT, 'apps/server/src');
const walk = (d: string): string[] =>
  readdirSync(d).flatMap(n => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));

describe('shared entry exposure', () => {
  it('registers no local/generation routes', async () => {
    const app = buildApp({ config: { ...loadConfig({}), databasePath: ':memory:' } });
    await app.ready();
    const printed = app.printRoutes({ commonPrefix: false });
    await app.close();
    expect(printed).toContain('/api/v1/health');
    expect(printed).not.toMatch(/\/local\b/);
    expect(printed).not.toMatch(/generat|\/jobs|claude|admin|debug/i);
  });

  it('shared server source cannot start CLI child processes', () => {
    const files = walk(SRC).filter(f => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(3);
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/child_process|@tkb\/ai|\bspawn\s*\(|\bexecFile(Sync)?\s*\(|ALLOW_CLAUDE_EXECUTION/);
    }
  });
});

describe('runtime: generation requests start no child process', () => {
  it('spawns nothing for generation-like requests', async () => {
    const app = buildApp({ config: { ...loadConfig({}), databasePath: ':memory:' } });
    const targets: [string, string][] = [
      ['POST', '/api/v1/trips/generate'],
      ['POST', '/local/v1/generations'],
      ['POST', '/LOCAL/v1/generations'],
      ['GET', '/local/v1/capabilities'],
    ];
    for (const [method, url] of targets) {
      const res = await app.inject({ method: method as 'GET' | 'POST', url, payload: method === 'POST' ? {} : undefined });
      expect(res.statusCode, url).toBeGreaterThanOrEqual(400);
    }
    await app.close();
    for (const [name, spy] of Object.entries(spies)) expect(spy, name).not.toHaveBeenCalled();
  });
});

describe('serve-demo preflight', () => {
  const good = {
    PUBLIC_ORIGIN: 'https://demo.example.trycloudflare.com',
    SESSION_SECRET: 'x'.repeat(40) + 'SECRETMARK',
    TRUST_PROXY: 'loopback',
    SHARED_BIND: '127.0.0.1',
    PROVIDER_MODE: 'fixture',
  };
  const run = (over: Record<string, string>) => {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts/serve-demo.mjs')], {
      env: { PATH: process.env.PATH ?? '', ...good, ...over },
      encoding: 'utf8',
    });
    return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
  };

  it('fails for http origin, short secret and missing TRUST_PROXY without leaking the secret', () => {
    const cases: [Record<string, string>, string][] = [
      [{ PUBLIC_ORIGIN: 'http://demo.example.com' }, 'PUBLIC_ORIGIN'],
      [{ SESSION_SECRET: 'short' }, 'SESSION_SECRET'],
      [{ TRUST_PROXY: '' }, 'TRUST_PROXY'],
      [{ SHARED_BIND: '0.0.0.0' }, 'SHARED_BIND'],
      [{ SHARED_PORT: '4311' }, 'SHARED_PORT'],
      [{ SHARED_PORT: '5173' }, 'SHARED_PORT'],
      [{ SHARED_PORT: '4400', PERSONAL_PORT: '4400' }, 'SHARED_PORT'],
      [{ SHARED_PORT: 'abc' }, 'SHARED_PORT'],
    ];
    for (const [over, word] of cases) {
      const r = run(over);
      expect(r.code, word).toBe(1);
      expect(r.out).toContain(word);
      expect(r.out).not.toContain('SECRETMARK');
      expect(r.out).not.toContain('cloudflared tunnel');
    }
  });

  it('on success only prints the command for the human (needs apps/web/dist)', () => {
    const r = run({});
    if (r.code === 0) expect(r.out).toContain('cloudflared tunnel --url http://127.0.0.1:4310');
    else expect(r.out).toContain('apps/web/dist');
    expect(r.out).not.toContain('SECRETMARK');
  });
});
