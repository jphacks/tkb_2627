import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = DatabaseSync;

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

/** Only the shared server opens the database. Never call this from apps/ai-local. */
export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/** Applies pending NNN_name.sql files in order. Idempotent. Returns applied versions. */
export function migrate(db: Db): string[] {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const done = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: string }[]).map(
      (r) => r.version,
    ),
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const applied: string[] = [];
  const record = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');
  const isApplied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?');
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = readFileSync(MIGRATIONS_DIR + file, 'utf8');
    db.exec('BEGIN IMMEDIATE');
    try {
      // Another process (e.g. `npm run setup` while `npm run dev` starts) may have applied it meanwhile.
      if (isApplied.get(file)) {
        db.exec('COMMIT');
        continue;
      }
      db.exec(sql);
      record.run(file, new Date().toISOString());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    applied.push(file);
  }
  return applied;
}

export function checkConnection(db: Db): boolean {
  try {
    db.prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}
export * from './repo.ts';
export * from './auth.ts';
export * from './groups.ts';
