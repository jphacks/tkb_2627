import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PersonalConfig {
  bind: string;
  port: number;
  allowClaudeExecution: boolean;
  sharedBaseUrl: string;
  /** Shared-server userIds allowed to use this personal entry. Empty = deny all (fail closed). */
  allowedUserIds: string[];
  aiQueueLimit: number;
  aiTimeoutMs: number;
  pairingTtlMs: number;
}

function posInt(v: string | undefined, def: number, name: string): number {
  const n = Number(v ?? def);
  if (!Number.isInteger(n) || n < 1) throw new Error(`invalid ${name}`);
  return n;
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
    allowedUserIds: (env.PERSONAL_ALLOWED_USER_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean),
    aiQueueLimit: posInt(env.AI_QUEUE_LIMIT, 8, 'AI_QUEUE_LIMIT'),
    aiTimeoutMs: posInt(env.AI_TIMEOUT_SECONDS, 180, 'AI_TIMEOUT_SECONDS') * 1000,
    pairingTtlMs: 10 * 60_000,
  };
}
