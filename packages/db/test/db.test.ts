import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, openDatabase } from '../src/index.ts';

const TABLES = ['users','sessions','trips','trip_versions','plan_batches','groups','group_members','group_invites','posts','post_snapshots','exports','operation_keys'];

describe('db', () => {
  it('migrates idempotently and creates 12 tables', () => {
    const db = openDatabase(':memory:');
    expect(migrate(db)).toEqual(['001_init.sql']);
    expect(migrate(db)).toEqual([]);
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    for (const t of TABLES) expect(names).toContain(t);
  });
  it('enables WAL and foreign keys on a file db', () => {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'tkb-')), 'sub', 't.sqlite'));
    migrate(db);
    expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
    expect(() => db.prepare("INSERT INTO sessions VALUES ('h','nouser','x',NULL)").run()).toThrow();
    db.close();
  });
  it('rejects invalid visibility', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    db.exec("INSERT INTO users VALUES ('u','l','p','n','t')");
    db.exec("INSERT INTO post_snapshots VALUES ('s','{}',1,'t')");
    expect(() => db.exec("INSERT INTO posts VALUES ('p','u',NULL,1,'s','secret',NULL,1,'x','t','t',NULL)")).toThrow();
  });
});
