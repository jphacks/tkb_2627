import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Trip } from '@tkb/contracts';
import { fixtureTrips } from '@tkb/fixtures';
import {
  createUser,
  getTripForOwner,
  insertTrip,
  isInTransaction,
  migrate,
  openDatabase,
  transaction,
  updateTripWithRevision,
  type Db,
} from '../src/index.ts';

const dirs: string[] = [];
const dbs: Db[] = [];
function tmpPath(): string {
  const d = mkdtempSync(join(tmpdir(), 'tkb-db-'));
  dirs.push(d);
  return join(d, 'travel.sqlite');
}
function open(path: string): Db {
  const db = openDatabase(path);
  dbs.push(db);
  migrate(db);
  return db;
}
afterEach(() => {
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const OWNER = 'user_owner';
const OTHER = 'user_other';
const NOW = '2026-10-24T03:00:00Z';
function seedUsers(db: Db): void {
  for (const id of [OWNER, OTHER]) {
    createUser(db, { id, loginId: id, passwordHash: 'hash', displayName: id, createdAt: '2026-01-01T00:00:00Z' });
  }
}
function makeTrip(): Trip {
  return { ...structuredClone(fixtureTrips[0]!), tripId: 'trip_s01', ownerId: OWNER, revision: 1 };
}
const count = (db: Db, table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('trip repository', () => {
  it('persists across close and reopen', () => {
    const path = tmpPath();
    let db = open(path);
    seedUsers(db);
    insertTrip(db, OWNER, makeTrip(), NOW);
    const r = updateTripWithRevision(db, OWNER, { ...makeTrip(), title: '更新後' }, 1, NOW);
    expect(r).toMatchObject({ ok: true, revision: 2 });
    db.close();
    db = open(path);
    const t = getTripForOwner(db, 'trip_s01', OWNER);
    expect(t?.revision).toBe(2);
    expect(t?.title).toBe('更新後');
    expect(count(db, 'trip_versions')).toBe(2);
  });

  it('rolls back everything when the transaction throws', () => {
    const db = open(tmpPath());
    expect(() =>
      transaction(db, () => {
        seedUsers(db);
        insertVersionlessTripRow(db);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    for (const t of ['users', 'trips', 'trip_versions']) expect(count(db, t)).toBe(0);
    expect(isInTransaction(db)).toBe(false);
  });

  it('rolls back insertTrip as a whole when the version row fails', () => {
    const db = open(tmpPath());
    seedUsers(db);
    db.exec(
      "INSERT INTO trips VALUES ('trip_s01','user_owner',1,'x',1,'{}','[]','[]','[]','valid','t','t',NULL)",
    );
    db.exec("INSERT INTO trip_versions VALUES ('trip_s01',1,'{}','t')");
    // Same id again fails on trips PK; nothing new may remain.
    expect(() => insertTrip(db, OWNER, makeTrip(), NOW)).toThrow();
    expect(count(db, 'trips')).toBe(1);
    expect(count(db, 'trip_versions')).toBe(1);
  });

  it('forbids nested transactions', () => {
    const db = open(tmpPath());
    expect(() => transaction(db, () => transaction(db, () => 1))).toThrow(/nested/);
    expect(isInTransaction(db)).toBe(false);
  });

  it('returns REVISION_CONFLICT for a stale revision and leaves data unchanged', () => {
    const db = open(tmpPath());
    seedUsers(db);
    insertTrip(db, OWNER, makeTrip(), NOW);
    expect(updateTripWithRevision(db, OWNER, { ...makeTrip(), title: 'v2' }, 1, NOW)).toMatchObject({ ok: true, revision: 2 });
    const stale = updateTripWithRevision(db, OWNER, { ...makeTrip(), title: 'stale' }, 1, NOW);
    expect(stale).toEqual({ ok: false, code: 'REVISION_CONFLICT', currentRevision: 2 });
    expect(getTripForOwner(db, 'trip_s01', OWNER)).toMatchObject({ title: 'v2', revision: 2 });
    expect(count(db, 'trip_versions')).toBe(2);
  });

  it('hides trips from other owners and deleted trips', () => {
    const db = open(tmpPath());
    seedUsers(db);
    insertTrip(db, OWNER, makeTrip(), NOW);
    expect(getTripForOwner(db, 'trip_s01', OTHER)).toBeNull();
    const r = updateTripWithRevision(db, OTHER, { ...makeTrip(), title: 'hijack' }, 1, NOW);
    expect(r).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(getTripForOwner(db, 'trip_s01', OWNER)?.title).toBe(makeTrip().title);
    db.exec("UPDATE trips SET deleted_at = 't'");
    expect(getTripForOwner(db, 'trip_s01', OWNER)).toBeNull();
    expect(updateTripWithRevision(db, OWNER, makeTrip(), 1, NOW)).toEqual({ ok: false, code: 'NOT_FOUND' });
  });

  it('takes the owner and timestamps from the server, not from the trip body', () => {
    const db = open(tmpPath());
    seedUsers(db);
    const saved = insertTrip(db, OWNER, { ...makeTrip(), ownerId: OTHER, createdAt: '2000-01-01T00:00:00Z' }, NOW);
    expect(saved.ownerId).toBe(OWNER);
    expect(saved.createdAt).toBe(NOW);
    expect(getTripForOwner(db, 'trip_s01', OTHER)).toBeNull();
    const r = updateTripWithRevision(db, OWNER, { ...makeTrip(), ownerId: OTHER, title: 'v2' }, 1, '2026-10-24T04:00:00Z');
    expect(r).toMatchObject({ ok: true, revision: 2, trip: { ownerId: OWNER, createdAt: NOW, updatedAt: '2026-10-24T04:00:00Z' } });
  });

  it('rejects a trip whose owner does not exist (foreign key)', () => {
    const db = open(tmpPath());
    expect(() => insertTrip(db, OWNER, makeTrip(), NOW)).toThrow(/FOREIGN KEY/i);
    expect(count(db, 'trips')).toBe(0);
    expect(count(db, 'trip_versions')).toBe(0);
  });

  it('rejects duplicate login ids', () => {
    const db = open(tmpPath());
    seedUsers(db);
    expect(() => createUser(db, { id: 'x', loginId: OWNER, passwordHash: 'h', displayName: 'd', createdAt: 't' })).toThrow();
  });
});

function insertVersionlessTripRow(db: Db): void {
  db.exec("INSERT INTO trips VALUES ('t','user_owner',1,'x',1,'{}','[]','[]','[]','valid','t','t',NULL)");
  db.exec("INSERT INTO trip_versions VALUES ('t',1,'{}','t')");
}

describe('concurrent writers', () => {
  it('reports SQLITE_BUSY when busy_timeout is short', () => {
    const path = tmpPath();
    const a = open(path);
    const b = open(path);
    b.exec('PRAGMA busy_timeout = 50');
    a.exec('BEGIN IMMEDIATE');
    const t0 = Date.now();
    expect(() => b.exec('BEGIN IMMEDIATE')).toThrow(/locked|busy/i);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(40);
    a.exec('ROLLBACK');
    b.exec('BEGIN IMMEDIATE');
    b.exec('ROLLBACK');
  });

  it('waits within busy_timeout for another process holding the write lock', async () => {
    const path = tmpPath();
    const db = open(path);
    seedUsers(db);
    const script = `
      import { DatabaseSync } from 'node:sqlite';
      const d = new DatabaseSync(process.argv[1]);
      d.exec('PRAGMA busy_timeout = 5000');
      d.exec('BEGIN IMMEDIATE');
      process.stdout.write('locked\\n');
      setTimeout(() => { d.exec('COMMIT'); d.close(); }, 1500);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, path], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((res, rej) => {
      child.stdout.once('data', () => res());
      child.once('error', rej);
    });
    const t0 = Date.now();
    insertTrip(db, OWNER, makeTrip(), NOW); // blocks on the child's lock, then succeeds
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
    expect(getTripForOwner(db, 'trip_s01', OWNER)?.revision).toBe(1);
    await new Promise((res) => child.once('exit', res));
  });
});

describe('git hygiene', () => {
  it('ignores the database files', () => {
    const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
    const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' });
    if (inside.status !== 0) return; // not a git checkout: nothing to verify
    for (const f of ['data/travel.sqlite', 'data/travel.sqlite-wal', 'data/travel.sqlite-shm']) {
      expect(spawnSync('git', ['check-ignore', '-q', f], { cwd: root }).status, f).toBe(0);
    }
  });
});
