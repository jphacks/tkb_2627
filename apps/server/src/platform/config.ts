import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DataMode } from '@tkb/contracts';
import { usageLimitsFromEnv } from '@tkb/travel-data';
import { dailyPerUserFromEnv } from '../trips/generation/user-limit.ts';
import { liveRouteCallsPerUserFromEnv } from '../trips/generation/live-route-budget.ts';

export interface SharedConfig {
  bind: string;
  port: number;
  databasePath: string;
  providerMode: DataMode;
  /** HMAC key for CSRF tokens. Random per process when SESSION_SECRET is unset (dev only). */
  sessionSecret: string;
  /** Exact origin of the shared web app, e.g. https://app.example. Empty in local development. */
  publicOrigin: string;
  sessionTtlMs: number;
  /** Only 'loopback' (a local tunnel/proxy on this machine) is allowed; `true` would trust spoofed headers. */
  trustProxy: 'loopback' | false;
  /** Built web app (apps/web/dist) served same-origin. null or a missing directory disables static delivery. */
  staticDir: string | null;
}

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

export function loadEnvFile(): void {
  try {
    process.loadEnvFile(resolve(REPO_ROOT, '.env'));
  } catch {
    /* .env is optional */
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SharedConfig {
  const rawMode = env.PROVIDER_MODE ?? 'fixture';
  if (rawMode !== 'fixture' && rawMode !== 'mixed' && rawMode !== 'live') {
    throw new Error(`unsupported PROVIDER_MODE: ${rawMode} (expected fixture, mixed or live)`);
  }
  const mode: DataMode = rawMode;
  // mixed/live call Google: refuse to start without a key so fixture data is never served as live, or the reverse.
  // The key itself is read from the environment by the provider adapters and is never kept in this config.
  if (mode !== 'fixture' && !(env.GOOGLE_MAPS_SERVER_KEY ?? '').trim()) {
    throw new Error(`PROVIDER_MODE=${mode} requires GOOGLE_MAPS_SERVER_KEY`);
  }
  dailyPerUserFromEnv(env); // refuse an invalid per-user K05 cap at startup
  liveRouteCallsPerUserFromEnv(env); // refuse an invalid per-user live route budget at startup
  usageLimitsFromEnv(env); // throws on an invalid or raised limit: refuse to start rather than spend more than intended
  const port = Number(env.SHARED_PORT ?? 4310);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid SHARED_PORT');
  const publicOrigin = (env.PUBLIC_ORIGIN ?? '').trim().replace(/\/+$/, '');
  if (publicOrigin) {
    try {
      const u = new URL(publicOrigin);
      const loopbackHttp = u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
      if (u.origin !== publicOrigin || (u.protocol !== 'https:' && !loopbackHttp)) throw new Error('bad origin');
    } catch {
      throw new Error('invalid PUBLIC_ORIGIN (expected https://host[:port], or http://127.0.0.1|localhost[:port] for development)');
    }
  }
  let sessionSecret = env.SESSION_SECRET ?? '';
  if (!sessionSecret) {
    if (publicOrigin.startsWith('https://')) throw new Error('SESSION_SECRET is required when PUBLIC_ORIGIN is https');
    sessionSecret = randomBytes(32).toString('hex');
    console.warn('[auth] SESSION_SECRET is not set: using a random secret; CSRF tokens become invalid on restart (dev only).');
  } else if (sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters');
  }
  const ttlDays = Number(env.SESSION_TTL_DAYS ?? 7);
  if (!(ttlDays > 0 && ttlDays <= 90)) throw new Error('invalid SESSION_TTL_DAYS');
  const tp = env.TRUST_PROXY ?? '';
  if (tp !== '' && tp !== 'loopback') throw new Error('TRUST_PROXY only accepts "loopback"');
  return {
    trustProxy: tp === 'loopback' ? 'loopback' : false,
    sessionSecret,
    publicOrigin,
    sessionTtlMs: Math.round(ttlDays * 86_400_000),
    bind: env.SHARED_BIND ?? '127.0.0.1',
    port,
    // Relative to the repo root so the server and `npm run db:migrate` share one file.
    databasePath: (p => (p === ':memory:' ? p : resolve(REPO_ROOT, p)))(env.DATABASE_PATH ?? './data/travel.sqlite'),
    providerMode: mode,
    staticDir: resolve(REPO_ROOT, 'apps/web/dist'),
  };
}
