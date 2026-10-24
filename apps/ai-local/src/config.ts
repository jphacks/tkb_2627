import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PersonalConfig {
  bind: string;
  port: number;
  allowClaudeExecution: boolean;
  sharedBaseUrl: string;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function loadEnvFile(): void {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  for (const f of ['.env.ai-local', '.env']) {
    try {
      process.loadEnvFile(resolve(root, f));
    } catch {
      /* optional */
    }
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PersonalConfig {
  const bind = env.PERSONAL_BIND ?? '127.0.0.1';
  if (!LOOPBACK.has(bind)) throw new Error('PERSONAL_BIND must be a loopback address');
  const port = Number(env.PERSONAL_PORT ?? 4311);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid PERSONAL_PORT');
  return {
    bind,
    port,
    allowClaudeExecution: env.ALLOW_CLAUDE_EXECUTION === 'true',
    sharedBaseUrl: env.SHARED_BASE_URL ?? 'http://127.0.0.1:4310',
  };
}
