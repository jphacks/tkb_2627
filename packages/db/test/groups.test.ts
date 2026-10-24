import { describe, expect, it } from 'vitest';
import {
  acceptInvite,
  createGroup,
  createInvite,
  createUser,
  hashInviteToken,
  isActiveMember,
  listMemberGroupIds,
  migrate,
  openDatabase,
  countPendingInvites,
  removeMember,
} from '../src/index.ts';

function setup() {
  const db = openDatabase(':memory:');
  migrate(db);
  for (const id of ['u1', 'u2', 'u3']) {
    createUser(db, { id, loginId: id, passwordHash: 'x', displayName: id, createdAt: '2026-01-01T00:00:00Z' });
  }
  return db;
}

describe('groups repository', () => {
  it('membership is read live and revoked on removal', () => {
    const db = setup();
    const g = createGroup(db, 'u1', 'G', '2026-01-01T00:00:00Z');
    const { token } = createInvite(db, g.groupId, null, new Date());
    expect(acceptInvite(db, token, 'u2', new Date()).ok).toBe(true);
    expect(isActiveMember(db, g.groupId, 'u2')).toBe(true);
    expect(listMemberGroupIds(db, 'u2')).toEqual([g.groupId]);
    expect(removeMember(db, g.groupId, 'u1', 'u2').ok).toBe(true);
    expect(isActiveMember(db, g.groupId, 'u2')).toBe(false);
    expect(listMemberGroupIds(db, 'u2')).toEqual([]);
    expect(acceptInvite(db, token, 'u2', new Date())).toEqual({ ok: false, reason: 'CONSUMED' });
  });

  it('stores only the token hash and rejects expired invites', () => {
    const db = setup();
    const g = createGroup(db, 'u1', 'G', '2026-01-01T00:00:00Z');
    const { token } = createInvite(db, g.groupId, null, new Date(Date.now() - 10_000), 1000);
    const rows = db.prepare('SELECT token_hash FROM group_invites').all() as { token_hash: string }[];
    expect(rows[0]!.token_hash).toBe(hashInviteToken(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(acceptInvite(db, token, 'u2', new Date())).toEqual({ ok: false, reason: 'EXPIRED' });
  });

  it('owner cannot be removed; admin cannot remove admin', () => {
    const db = setup();
    const g = createGroup(db, 'u1', 'G', '2026-01-01T00:00:00Z');
    db.prepare("INSERT INTO group_members VALUES (?, 'u2', 'admin', 'x')").run(g.groupId);
    db.prepare("INSERT INTO group_members VALUES (?, 'u3', 'admin', 'x')").run(g.groupId);
    expect(removeMember(db, g.groupId, 'u2', 'u1')).toEqual({ ok: false, reason: 'FORBIDDEN' });
    expect(removeMember(db, g.groupId, 'u2', 'u3')).toEqual({ ok: false, reason: 'FORBIDDEN' });
    expect(removeMember(db, g.groupId, 'u1', 'u3').ok).toBe(true);
  });

  it('removal invalidates pending invites addressed to the removed user', () => {
    const db = setup();
    const g = createGroup(db, 'u1', 'G', '2026-01-01T00:00:00Z');
    const t1 = createInvite(db, g.groupId, 'u2', new Date()).token;
    const t2 = createInvite(db, g.groupId, 'u2', new Date()).token;
    expect(acceptInvite(db, t1, 'u2', new Date()).ok).toBe(true);
    expect(removeMember(db, g.groupId, 'u1', 'u2').ok).toBe(true);
    expect(acceptInvite(db, t2, 'u2', new Date())).toEqual({ ok: false, reason: 'CONSUMED' });
    expect(isActiveMember(db, g.groupId, 'u2')).toBe(false);
    expect(countPendingInvites(db, g.groupId, new Date())).toBe(0);
  });
});
