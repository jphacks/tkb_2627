// T05 shared helpers (not a test file).
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUser, migrate, openDatabase } from '@tkb/db';
import { buildApp as buildShared } from '../../apps/server/src/platform/app.ts';
import { hashPassword } from '../../apps/server/src/platform/auth/password.ts';
import { loadConfig as loadShared } from '../../apps/server/src/platform/config.ts';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
export const PW = 'correct horse battery';
export type Shared = ReturnType<typeof buildShared>;

/** Repo-relative path with '/' separators on every OS. */
export const rel = (p: string) => relative(ROOT, p).split(sep).join('/');

/** All files under the given repo-relative dirs, skipping node_modules/dist/test files when asked. */
export function sourceFiles(dirs: string[], opts: { exts?: RegExp; skipTests?: boolean } = {}): string[] {
  const exts = opts.exts ?? /\.(ts|tsx|mjs|js)$/;
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      if (n === 'node_modules' || n === 'dist' || n === '.local') continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (exts.test(n) && !(opts.skipTests && (/\.test\./.test(n) || /(^|\/)test\//.test(rel(p))))) out.push(p);
    }
  };
  for (const d of dirs) walk(join(ROOT, d));
  return out;
}
export const read = (p: string) => readFileSync(p, 'utf8');

/** Static dist fixture so the SPA fallback is active (the widest surface of the shared entry). */
export function fixtureDist(): string {
  const dist = join(mkdtempSync(join(tmpdir(), 'tkb-sec-')), 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>spa</title>');
  return dist;
}

let pwHash: string | null = null;
export async function makeShared(env: Record<string, string> = {}, extra: { staticDir?: string | null } = {}) {
  pwHash ??= await hashPassword(PW);
  const db = openDatabase(':memory:');
  migrate(db);
  createUser(db, { id: 'user_a', loginId: 'user-a', passwordHash: pwHash, displayName: 'A', createdAt: '2026-10-24T03:00:00Z' });
  const config = { ...loadShared({ SESSION_SECRET: 's'.repeat(40), ...env }), databasePath: ':memory:', ...extra };
  const app = buildShared({ config, db });
  return { app, db, config };
}
