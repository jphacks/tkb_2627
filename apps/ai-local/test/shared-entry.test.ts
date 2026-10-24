import { afterEach, expect, it } from 'vitest';
import { Capabilities } from '@tkb/contracts';
import { buildApp } from '../../server/src/platform/app.ts';
import { loadConfig } from '../../server/src/platform/config.ts';

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

it('shared entry cannot run the CLI', async () => {
  const app = buildApp({ config: { ...loadConfig({}), databasePath: ':memory:' } });
  apps.push(app);
  for (const url of ['/api/v1/generations', '/local/v1/generations']) {
    const r = await app.inject({ method: 'POST', url, payload: { constraints: {} } });
    expect(r.statusCode).toBe(404);
  }
  const c = Capabilities.parse((await app.inject('/api/v1/capabilities')).json());
  expect(c.aiGeneration).toEqual({ available: false, runner: 'none', reason: 'SHARED_ENTRY_NO_PERSONAL_CLAUDE' });
});
