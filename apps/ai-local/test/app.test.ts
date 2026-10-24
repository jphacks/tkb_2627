import { describe, expect, it } from 'vitest';
import { ApiError, Capabilities, Health } from '@tkb/contracts';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';

const app = buildApp({ config: loadConfig({}) });
const get = (url: string, headers: Record<string, string> = { host: '127.0.0.1:4311' }) =>
  app.inject({ url, headers });

describe('personal app server', () => {
  it('health and capabilities', async () => {
    const h = await get('/local/v1/health');
    expect(Health.parse(h.json()).service).toBe('personal');
    const c = Capabilities.parse((await get('/local/v1/capabilities')).json());
    expect(c.entry).toBe('personal');
    expect(c.aiGeneration).toEqual({ available: false, runner: 'fake', reason: 'CLAUDE_EXECUTION_DISABLED' });
  });
  it('rejects forged Host', async () => {
    for (const host of ['evil.example', 'evil.example:4311', '127.0.0.1:9999', '127.0.0.1']) {
      const r = await get('/local/v1/health', { host });
      expect(r.statusCode).toBe(403);
      expect(ApiError.parse(r.json()).code).toBe('FORBIDDEN');
    }
  });
  it('rejects foreign Origin, allows dev origin, adds no CORS', async () => {
    const bad = await get('/local/v1/health', { host: 'localhost:4311', origin: 'https://evil.example' });
    expect(bad.statusCode).toBe(403);
    const ok = await get('/local/v1/health', { host: 'localhost:4311', origin: 'http://127.0.0.1:5173' });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('refuses non-loopback bind', () => {
    expect(() => loadConfig({ PERSONAL_BIND: '0.0.0.0' })).toThrow();
    expect(() => loadConfig({ PERSONAL_BIND: '192.168.1.5' })).toThrow();
    expect(loadConfig({ PERSONAL_BIND: '::1' }).bind).toBe('::1');
  });
});
