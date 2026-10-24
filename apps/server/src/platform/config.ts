import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DataMode } from '@tkb/contracts';

export interface SharedConfig {
  bind: string;
  port: number;
  databasePath: string;
  providerMode: DataMode;
}

export function loadEnvFile(): void {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  try {
    process.loadEnvFile(resolve(root, '.env'));
  } catch {
    /* .env is optional */
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SharedConfig {
  const mode = env.PROVIDER_MODE ?? 'fixture';
  // Live provider adapters do not exist yet (D01-D04). Refuse live/mixed so fixture data is never
  // reported as live through /api/v1/capabilities.
  if (mode !== 'fixture') {
    throw new Error(`unsupported PROVIDER_MODE: ${mode} (only "fixture" is implemented)`);
  }
  const port = Number(env.SHARED_PORT ?? 4310);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid SHARED_PORT');
  return {
    bind: env.SHARED_BIND ?? '127.0.0.1',
    port,
    databasePath: env.DATABASE_PATH ?? './data/travel.sqlite',
    providerMode: mode,
  };
}
