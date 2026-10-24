import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PersonalConfig {
  bind: string;
  port: number;
  allowClaudeExecution: boolean;
  /** CLAUDE_TERMS_ACK=true: "A01 ack on #25 by M4 and M1" (owner's own PC/account only, no relaying). Without it the runner stays fake. */
  claudeTermsAck: boolean;
  /** CLAUDE_BIN (default 'claude'). */
  claudeBin: string;
  /** CLAUDE_MODEL (default 'sonnet'). */
  claudeModel: string;
  sharedBaseUrl: string;
  /** The single shared-server userId allowed to use this entry (A01: owner's own account only). null = deny all. */
  ownerUserId: string | null;
  aiQueueLimit: number;
  /** Overall per-job deadline, counted from submit (queue wait included). */
  aiTimeoutMs: number;
  /** Per CLI invocation timeout; used by the real runner later. */
  cliTimeoutMs: number;
  pairingTtlMs: number;
  /** Upper bound for one candidate save call to the shared server (AI_SAVE_TIMEOUT_SECONDS). */
  saveTimeoutMs: number;
  /** Job journal directory (AI_JOB_DIR); null = in-memory only. main.ts defaults it to <repo>/.local/ai-local. */
  jobDir: string | null;
  /** AI_MAX_LIVE_LEGS: live Routes lookups per job (1-6, default 6; M1 cap). */
  maxLiveLegs: number;
}

function posInt(v: string | undefined, def: number, name: string): number {
  const n = Number(v ?? def);
  if (!Number.isInteger(n) || n < 1) throw new Error(`invalid ${name}`);
  return n;
}

function liveLegs(v: string | undefined): number {
  const n = posInt(v, 6, 'AI_MAX_LIVE_LEGS');
  if (n > 6) throw new Error('AI_MAX_LIVE_LEGS cannot exceed 6');
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
  if (env.PERSONAL_ALLOWED_USER_IDS !== undefined) throw new Error('PERSONAL_ALLOWED_USER_IDS is replaced by PERSONAL_OWNER_USER_ID');
  const owner = (env.PERSONAL_OWNER_USER_ID ?? '').trim();
  if (/[\s,]/.test(owner)) throw new Error('PERSONAL_OWNER_USER_ID must be a single user id');
  return {
    bind,
    port,
    allowClaudeExecution: env.ALLOW_CLAUDE_EXECUTION === 'true',
    claudeTermsAck: env.CLAUDE_TERMS_ACK === 'true',
    claudeBin: env.CLAUDE_BIN?.trim() || 'claude',
    claudeModel: env.CLAUDE_MODEL?.trim() || 'sonnet',
    sharedBaseUrl: env.SHARED_BASE_URL ?? 'http://127.0.0.1:4310',
    ownerUserId: owner || null,
    aiQueueLimit: posInt(env.AI_QUEUE_LIMIT, 8, 'AI_QUEUE_LIMIT'),
    aiTimeoutMs: posInt(env.AI_TIMEOUT_SECONDS, 300, 'AI_TIMEOUT_SECONDS') * 1000,
    cliTimeoutMs: posInt(env.CLI_TIMEOUT_SECONDS, 120, 'CLI_TIMEOUT_SECONDS') * 1000,
    pairingTtlMs: 10 * 60_000,
    saveTimeoutMs: posInt(env.AI_SAVE_TIMEOUT_SECONDS, 60, 'AI_SAVE_TIMEOUT_SECONDS') * 1000,
    maxLiveLegs: liveLegs(env.AI_MAX_LIVE_LEGS),
    jobDir: env.AI_JOB_DIR?.trim() ? resolve(env.AI_JOB_DIR.trim()) : null,
  };
}
