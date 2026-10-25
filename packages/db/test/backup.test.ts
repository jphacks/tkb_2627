import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, symlinkSync, rmSync, statSync, openSync, writeSync, chmodSync, writeFileSync, closeSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureTrips } from '@tkb/fixtures';
import {
  acceptInvite,
  backupDatabase,
  BackupError,
  createGroup,
  createInvite,
  createPostFromPreview,
  createUser,
  getPostForViewer,
  hashPreviewToken,
  insertPreview,
  insertTrip,
  inspectDatabase,
  migrate,
  openDatabase,
  restoreDatabase,
  updateTripWithRevision,
  type Db,
} from '../src/index.ts';

const NOW = '2026-10-24T03:00:00Z';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const dirs: string[] = [];
const dbs: Db[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) {
    try {
      d.close();
    } catch {
      /* already closed */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'tkb-backup-'));
  dirs.push(d);
  return d;
};
const snapshot = (title: string) =>
  JSON.stringify({
    schemaVersion: 1,
    title,
    constraints: { area: 'A', startDate: '2026-11-01', endDate: '2026-11-02', timeZone: 'Asia/Tokyo', transportMode: 'transit' },
    days: [],
    places: [],
    redactionVersion: 1,
  });

/** Seeds through one connection that is then left OPEN, so its writes stay in the -wal file. */
function seedLive(path: string) {
  const db = openDatabase(path);
  dbs.push(db);
  migrate(db);
  for (const id of ['u1', 'u2', 'u3']) createUser(db, { id, loginId: id, passwordHash: `hash-${id}`, displayName: id, createdAt: NOW });
  db.prepare("INSERT INTO sessions VALUES ('sess-hash','u1','2026-10-24T03:00:00Z','2099-01-01T00:00:00Z')").run();
  const trip = insertTrip(db, 'u1', { ...structuredClone(fixtureTrips[0]!), tripId: 't1' }, NOW);
  expect(updateTripWithRevision(db, 'u1', { ...trip, title: 'v2' }, 1, NOW)).toMatchObject({ ok: true, revision: 2 });
  const g = createGroup(db, 'u1', 'G', NOW);
  const inv = createInvite(db, g.groupId, 'u2', new Date(NOW));
  expect(acceptInvite(db, inv.token, 'u2', new Date(NOW)).ok).toBe(true);
  createInvite(db, g.groupId, null, new Date(NOW)); // stays pending
  const postIds: Record<string, string> = {};
  for (const [i, vis] of (['public', 'group', 'private'] as const).entries()) {
    insertPreview(db, { tokenHash: hashPreviewToken(`tok${i}`), ownerId: 'u1', tripId: 't1', sourceRevision: 2, visibility: vis, groupId: vis === 'group' ? g.groupId : null, story: vis, snapshotJson: snapshot(vis), expiresAt: '2026-10-24T03:10:00Z' }, NOW);
    const r = createPostFromPreview(db, hashPreviewToken(`tok${i}`), 'u1', NOW);
    if (r.ok) postIds[vis] = r.post.postId;
  }
  // a preview left uncommitted
  insertPreview(db, { tokenHash: hashPreviewToken('pending'), ownerId: 'u1', tripId: 't1', sourceRevision: 2, visibility: 'public', groupId: null, story: 'p', snapshotJson: snapshot('p'), expiresAt: '2026-10-24T03:10:00Z' }, NOW);
  return { db, postIds };
}

function dump(db: Db): Record<string, unknown[]> {
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  const out: Record<string, unknown[]> = {};
  for (const n of names) out[n] = db.prepare(`SELECT * FROM "${n}" ORDER BY rowid`).all();
  return out;
}

describe('backup and restore', () => {
  it('snapshots a live WAL database and restores identical rows and ACL into an empty path', () => {
    const dir = tmp();
    const live = join(dir, 'live.sqlite');
    const { db, postIds } = seedLive(live);
    expect(Object.keys(postIds)).toHaveLength(3);
    expect(statSync(live + '-wal').size).toBeGreaterThan(0); // un-checkpointed writes exist

    // A plain copy of the main file alone loses the un-checkpointed rows; the snapshot must not.
    const naive = join(dir, 'naive.sqlite');
    copyFileSync(live, naive);
    const naiveDb = new DatabaseSync(naive, { readOnly: true });
    const naivePosts = (() => {
      try {
        return (naiveDb.prepare('SELECT count(*) AS n FROM posts').get() as { n: number }).n;
      } catch {
        return 0;
      }
    })();
    naiveDb.close();
    expect(naivePosts).toBe(0);

    const bak = join(dir, 'out', 'b.sqlite');
    const summary = backupDatabase(live, bak);
    expect(summary.integrity).toBe('ok');
    expect(summary.counts.posts).toBe(3);
    expect(summary.counts.trip_versions).toBeGreaterThanOrEqual(2);
    // POSIX mode bits are not meaningful on Windows (NTFS reports 0666/0777).
    if (process.platform !== 'win32') {
      expect(statSync(bak).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'out')).mode & 0o777).toBe(0o700);
    }

    const to = join(dir, 'restored', 'new.sqlite');
    const r = restoreDatabase(bak, to);
    expect(r.applied).toEqual([]);
    const restored = openDatabase(to);
    dbs.push(restored);
    const a = dump(db);
    const b = dump(restored);
    expect(b).toEqual(a);
    expect(a.posts).toHaveLength(3);
    expect(a.group_invites).toHaveLength(2);
    expect(a.post_previews).toHaveLength(4);

    // ACL parity on the restored copy
    for (const viewer of ['u1', 'u2', 'u3', null]) {
      for (const id of Object.values(postIds)) {
        const x = getPostForViewer(db, id, viewer);
        const y = getPostForViewer(restored, id, viewer);
        expect(y).toEqual(x);
      }
    }
    expect(getPostForViewer(restored, postIds.private!, 'u2')).toBeNull();
    expect(getPostForViewer(restored, postIds.group!, 'u2')).not.toBeNull();
    expect(getPostForViewer(restored, postIds.group!, 'u3')).toBeNull();
    expect(getPostForViewer(restored, postIds.public!, null)).not.toBeNull();
  });

  it('refuses to overwrite existing backup or restore target', () => {
    const dir = tmp();
    const live = join(dir, 'live.sqlite');
    seedLive(live);
    const bak = join(dir, 'b.sqlite');
    backupDatabase(live, bak);
    const before = readFileSync(bak);
    expect(() => backupDatabase(live, bak)).toThrow(BackupError);
    expect(readFileSync(bak).equals(before)).toBe(true);
    expect(() => restoreDatabase(bak, live)).toThrow(/already exists/);
    expect(() => backupDatabase(join(dir, 'missing.sqlite'), join(dir, 'x.sqlite'))).toThrow(BackupError);
  });

  it('refuses a dangling symlink as output, warns on a loose existing directory, and cleans up on failure', (ctx) => {
    const dir = tmp();
    const live = join(dir, 'live.sqlite');
    seedLive(live);
    const link = join(dir, 'link.sqlite');
    try {
      symlinkSync(join(dir, 'nowhere'), link);
    } catch (e) {
      if (['EPERM', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) ctx.skip('symlink not permitted on this OS');
      throw e;
    }
    expect(() => backupDatabase(live, link)).toThrow(/already exists/);
    expect(existsSync(join(dir, 'nowhere'))).toBe(false);
    // dir is created by mkdtemp as 0700 normally; loosen it to check the warning
    chmodSync(dir, 0o755);
    const r = backupDatabase(live, join(dir, 'ok.sqlite'));
    // the loose-mode warning relies on POSIX mode bits (absent on Windows)
    if (process.platform !== 'win32') expect(r.warnings).toHaveLength(1);
    // failure (source is not a database) leaves no partial output
    const notDb = join(dir, 'notdb.sqlite');
    writeFileSync(notDb, 'x'.repeat(200));
    const out = join(dir, 'fail.sqlite');
    expect(() => backupDatabase(notDb, out)).toThrow();
    expect(existsSync(out)).toBe(false);
  });

  it('reports an integrity error for a damaged backup and creates no restore target', () => {
    const dir = tmp();
    const live = join(dir, 'live.sqlite');
    seedLive(live);
    const bak = join(dir, 'b.sqlite');
    backupDatabase(live, bak);
    const fd = openSync(bak, 'r+');
    writeSync(fd, Buffer.alloc(64, 0xff), 0, 64, 0);
    closeSync(fd);
    expect(() => inspectDatabase(bak)).toThrow(/integrity_check failed/);
    const to = join(dir, 'new.sqlite');
    expect(() => restoreDatabase(bak, to)).toThrow(/integrity_check failed/);
    expect(existsSync(to)).toBe(false);
  });

  it('applies newer migrations to an older backup on restore', () => {
    const dir = tmp();
    const old = join(dir, 'old.sqlite');
    const db = openDatabase(old);
    // Only the first migration applied, as an older server would have.
    db.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    db.exec(readFileSync(fileURLToPath(new URL('../src/migrations/001_init.sql', import.meta.url)), 'utf8'));
    db.prepare("INSERT INTO schema_migrations VALUES ('001_init.sql', ?)").run(NOW);
    db.close();
    const bak = join(dir, 'b.sqlite');
    backupDatabase(old, bak);
    const r = restoreDatabase(bak, join(dir, 'new.sqlite'));
    expect(r.applied).toEqual(['002_post_previews.sql', '003_social_follow_like_images.sql']);
    expect(r.counts.post_previews).toBe(0);
  });

  it('default backups/ output is ignored by git', () => {
    const out = execFileSync('git', ['check-ignore', 'backups/travel-20261024T030000Z.sqlite'], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(out.trim()).toBe('backups/travel-20261024T030000Z.sqlite');
  });
});
