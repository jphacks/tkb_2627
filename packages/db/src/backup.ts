import { DatabaseSync } from 'node:sqlite';
import { chmodSync, copyFileSync, constants, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrate, openDatabase } from './index.ts';

export interface DbSummary {
  integrity: string;
  migrations: string[];
  /** Row counts only. No row content, no secrets. */
  counts: Record<string, number>;
}

export class BackupError extends Error {}

const SIDECARS = ['-wal', '-shm'];

function assertFresh(path: string, what: string): void {
  for (const suffix of ['', ...SIDECARS]) {
    if (existsSync(path + suffix)) throw new BackupError(`${what} already exists, refusing to overwrite: ${path + suffix}`);
  }
}

/** Opens read-only, runs integrity_check and returns versions and per-table row counts. Throws BackupError if not ok. */
export function inspectDatabase(path: string): DbSummary {
  if (!existsSync(path)) throw new BackupError(`file not found: ${path}`);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const rows = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
    const integrity = rows.map((r) => r.integrity_check).join('; ');
    if (integrity !== 'ok') throw new BackupError(`integrity_check failed: ${integrity.slice(0, 300)}`);
    const migrations = (
      db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: string }[]
    ).map((r) => r.version);
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string }[]
    ).map((r) => r.name);
    const counts: Record<string, number> = {};
    for (const t of tables) {
      counts[t] = (db.prepare(`SELECT count(*) AS n FROM "${t.replace(/"/g, '""')}"`).get() as { n: number }).n;
    }
    return { integrity, migrations, counts };
  } catch (e) {
    if (e instanceof BackupError) throw e;
    throw new BackupError(`integrity_check failed: ${(e as Error).message}`);
  } finally {
    db?.close();
  }
}

/**
 * Consistent single-file snapshot of a live (WAL) database via VACUUM INTO. Committed data still
 * in the -wal file is included. Never overwrites an existing file. Output is 0600 in a 0700 dir.
 */
export function backupDatabase(srcPath: string, destPath: string): DbSummary {
  if (!existsSync(srcPath)) throw new BackupError(`source database not found: ${srcPath}`);
  assertFresh(destPath, 'backup file');
  mkdirSync(dirname(destPath), { recursive: true, mode: 0o700 });
  const src = new DatabaseSync(srcPath);
  try {
    src.exec('PRAGMA busy_timeout = 5000');
    src.prepare('VACUUM INTO ?').run(destPath);
  } finally {
    src.close();
  }
  chmodSync(destPath, 0o600);
  try {
    return inspectDatabase(destPath);
  } catch (e) {
    rmSync(destPath, { force: true });
    throw e;
  }
}

/**
 * Restores a backup into a NEW path (never an existing file), verifies it, then applies any newer
 * migrations. Replacing the live database is a manual step (docs/backup.md).
 */
export function restoreDatabase(backupPath: string, toPath: string): DbSummary & { applied: string[] } {
  inspectDatabase(backupPath);
  assertFresh(toPath, 'restore target');
  mkdirSync(dirname(toPath), { recursive: true, mode: 0o700 });
  copyFileSync(backupPath, toPath, constants.COPYFILE_EXCL);
  chmodSync(toPath, 0o600);
  try {
    inspectDatabase(toPath);
    const db = openDatabase(toPath);
    let applied: string[];
    try {
      applied = migrate(db);
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
    return { ...inspectDatabase(toPath), applied };
  } catch (e) {
    for (const s of ['', ...SIDECARS]) rmSync(toPath + s, { force: true });
    throw e;
  }
}

export function formatSummary(s: DbSummary): string {
  const counts = Object.entries(s.counts).map(([k, v]) => `  ${k}: ${v}`);
  return [`integrity_check: ${s.integrity}`, `migrations: ${s.migrations.join(', ') || '(none)'}`, 'rows:', ...counts].join('\n');
}
