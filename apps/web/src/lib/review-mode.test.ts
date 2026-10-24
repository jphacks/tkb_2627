import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEV_ORIGIN, rewriteOrigin, serverSettings } from './review-mode.ts';

type Cfg = { server: { host: string; proxy: Record<string, unknown> } };

describe('review mode server settings', () => {
  it('default dev is unchanged: loopback, 5173, /api 4310 and /local 4311', () => {
    expect(serverSettings({})).toEqual({
      host: '127.0.0.1', port: 5173, strictPort: true,
      proxy: { '/api': 'http://127.0.0.1:4310', '/local': 'http://127.0.0.1:4311' },
    });
  });
  it('review mode listens on the LAN, follows the chosen ports and has no /local proxy', () => {
    const s = serverSettings({ TKB_REVIEW_LAN: '1', TKB_API_PORT: '4312', TKB_WEB_PORT: '5175' });
    expect(s.host).toBe('0.0.0.0');
    expect(s.port).toBe(5175);
    expect(s).toHaveProperty('allowedHosts', true);
    expect(s.proxy).toEqual({ '/api': 'http://127.0.0.1:4312' });
    expect(Object.keys(s.proxy)).not.toContain('/local');
  });
  it('ignores invalid ports', () => {
    expect(serverSettings({ TKB_REVIEW_LAN: '1', TKB_API_PORT: 'x', TKB_WEB_PORT: '0' }).port).toBe(5173);
  });
});

describe('rewriteOrigin', () => {
  it('maps the page-own LAN origin to the dev origin', () => {
    expect(rewriteOrigin('http://192.168.1.5:5174', '192.168.1.5:5174')).toBe(DEV_ORIGIN);
  });
  it('leaves foreign origins and missing values untouched', () => {
    expect(rewriteOrigin('http://evil.example', '192.168.1.5:5174')).toBe('http://evil.example');
    expect(rewriteOrigin(undefined, 'x')).toBeUndefined();
  });
});

describe('vite.config', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
  it('review mode: host 0.0.0.0 and no /local proxy', async () => {
    vi.stubEnv('TKB_REVIEW_LAN', '1');
    vi.resetModules();
    const cfg = (await import('../../vite.config.ts')).default as unknown as Cfg;
    expect(cfg.server.host).toBe('0.0.0.0');
    expect(Object.keys(cfg.server.proxy)).toEqual(['/api']);
  });
  it('default mode keeps /local and loopback', async () => {
    vi.stubEnv('TKB_REVIEW_LAN', '');
    vi.resetModules();
    const cfg = (await import('../../vite.config.ts')).default as unknown as Cfg;
    expect(cfg.server.host).toBe('127.0.0.1');
    expect(Object.keys(cfg.server.proxy).sort()).toEqual(['/api', '/local']);
  });
});
