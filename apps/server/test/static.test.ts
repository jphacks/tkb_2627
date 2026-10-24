import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/platform/app.ts';
import { loadConfig } from '../src/platform/config.ts';

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

let symlinkOk = false;
function fixtureDist() {
  const base = mkdtempSync(join(tmpdir(), 'tkb-static-'));
  const dist = join(base, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>spa</title>');
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(dist, 'assets', 'app.js.map'), '{}');
  writeFileSync(join(dist, '.env'), 'DOTSECRET');
  writeFileSync(join(base, 'secret.txt'), 'TOPSECRET');
  try {
    symlinkSync(join(base, 'secret.txt'), join(dist, 'link.txt'));
    symlinkOk = true;
  } catch (e) {
    // Windows without admin/Developer Mode: EPERM. Skip only the symlink URL below.
    if (!['EPERM', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
    symlinkOk = false;
  }
  return dist;
}
function make(staticDir: string | null) {
  const app = buildApp({ config: { ...loadConfig({}), databasePath: ':memory:', staticDir } });
  apps.push(app);
  return app;
}

describe('static delivery', () => {
  it('serves index.html at / and as SPA fallback with no-cache', async () => {
    const app = make(fixtureDist());
    for (const url of ['/', '/trips/abc']) {
      const res = await app.inject(url);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('<title>spa</title>');
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.headers['cache-control']).toBe('no-cache');
    }
  });
  it('serves assets with type and cache', async () => {
    const res = await make(fixtureDist()).inject('/assets/app.js');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
    expect(res.headers['cache-control']).toContain('max-age');
  });
  it('missing assets are 404, not the SPA', async () => {
    const res = await make(fixtureDist()).inject('/assets/missing.js');
    expect(res.statusCode).toBe(404);
  });
  it('rejects traversal and symlinks', async () => {
    const app = make(fixtureDist());
    for (const url of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/../../secret.txt', '/..%2fsecret.txt', '/%5c..%5csecret.txt', ...(symlinkOk ? ['/link.txt'] : []), '/%00']) {
      const res = await app.inject(url);
      expect(res.statusCode, url).toBe(404);
      expect(res.body).not.toContain('TOPSECRET');
    }
  });
  it('never exposes /local/ and keeps /api behaviour', async () => {
    const app = make(fixtureDist());
    for (const url of ['/local/v1/capabilities', '/local/', '/local']) {
      expect((await app.inject(url)).statusCode, url).toBe(404);
    }
    expect((await app.inject('/api/v1/health')).statusCode).toBe(200);
    const miss = await app.inject('/api/v1/nope');
    expect(miss.statusCode).toBe(404);
    expect(miss.json().code).toBe('NOT_FOUND');
  });
  it('adds security headers to every response', async () => {
    const app = make(fixtureDist());
    for (const url of ['/', '/api/v1/health', '/local/x', '/api/v1/nope']) {
      const h = (await app.inject(url)).headers;
      expect(h['x-content-type-options']).toBe('nosniff');
      expect(h['referrer-policy']).toBe('no-referrer');
      expect(h['x-frame-options']).toBe('DENY');
      expect(h['content-security-policy']).toContain("default-src 'self'");
    }
  });
  it('is disabled without dist but the API works', async () => {
    const app = make(join(tmpdir(), 'tkb-no-such-dist'));
    expect((await app.inject('/')).statusCode).toBe(404);
    expect((await app.inject('/api/v1/health')).statusCode).toBe(200);
  });
  it('treats reserved prefixes case-insensitively and after decoding', async () => {
    const app = make(fixtureDist());
    for (const url of ['/LOCAL/v1/x', '/%6cocal/v1/x', '//local/v1/x', '/API/v1/x', '/%61pi/v1/x', '/Local']) {
      const res = await app.inject(url);
      expect(res.statusCode, url).toBe(404);
      expect(res.body, url).not.toContain('<title>spa</title>');
      expect(res.json().code, url).toBe('NOT_FOUND');
    }
  });
  it('rejects dot segments and source maps', async () => {
    const app = make(fixtureDist());
    for (const url of ['/.env', '/assets/.hidden', '/assets/app.js.map', '/.well-known/x']) {
      const res = await app.inject(url);
      expect(res.statusCode, url).toBe(404);
      expect(res.body).not.toContain('DOTSECRET');
    }
  });
  it('returns K23 errors with security headers for malformed URLs', async () => {
    const res = await make(fixtureDist()).inject('/%ff');
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.json().requestId).toBeTruthy();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
  it('sends HSTS only for an https public origin', async () => {
    const mk = (publicOrigin: string) => {
      const app = buildApp({ config: { ...loadConfig({}), databasePath: ':memory:', staticDir: null, publicOrigin } });
      apps.push(app);
      return app;
    };
    expect((await mk('https://demo.example.com').inject('/api/v1/health')).headers['strict-transport-security']).toBe('max-age=15552000');
    expect((await mk('').inject('/api/v1/health')).headers['strict-transport-security']).toBeUndefined();
  });
});
