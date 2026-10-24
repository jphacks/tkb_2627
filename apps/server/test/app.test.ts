import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, Capabilities, Health } from '@tkb/contracts';
import { buildApp } from '../src/platform/app.ts';
import { loadConfig } from '../src/platform/config.ts';

const apps: ReturnType<typeof buildApp>[] = [];
function make() {
  const app = buildApp({ config: { ...loadConfig({}), databasePath: ':memory:' } });
  apps.push(app);
  return app;
}
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

describe('shared server', () => {
  it('health', async () => {
    const res = await make().inject('/api/v1/health');
    expect(res.statusCode).toBe(200);
    expect(Health.parse(res.json()).service).toBe('shared');
    expect(res.headers['x-request-id']).toBeTruthy();
  });
  it('capabilities', async () => {
    const res = await make().inject('/api/v1/capabilities');
    const c = Capabilities.parse(res.json());
    expect(c.entry).toBe('shared');
    expect(c.aiGeneration).toEqual({ available: false, runner: 'none', reason: 'SHARED_ENTRY_NO_PERSONAL_CLAUDE' });
    expect(c.dataMode).toBe('fixture');
  });
  it('404 is ApiError', async () => {
    const res = await make().inject('/api/v1/nope');
    expect(res.statusCode).toBe(404);
    const e = ApiError.parse(res.json());
    expect(e.code).toBe('NOT_FOUND');
    expect(e.requestId).toBe(res.headers['x-request-id']);
  });
  it('malformed request is ApiError', async () => {
    const res = await make().inject({ method: 'POST', url: '/api/v1/health' });
    expect(ApiError.parse(res.json()).code).toBe('NOT_FOUND');
  });
});
