import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Db } from './index.ts';
import { transaction } from './repo.ts';

export type GroupRoleName = 'owner' | 'admin' | 'member';

export interface GroupRow {
  groupId: string;
  name: string;
  role: GroupRoleName;
  createdAt: string;
}

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const hashInviteToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** Creates the group and its owner membership in one transaction. */
export function createGroup(db: Db, ownerId: string, name: string, now: string): GroupRow {
  const groupId = randomUUID();
  transaction(db, () => {
    db.prepare('INSERT INTO groups (id, owner_id, name, created_at) VALUES (?, ?, ?, ?)').run(groupId, ownerId, name, now);
    db.prepare("INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)").run(groupId, ownerId, now);
  });
  return { groupId, name, role: 'owner', createdAt: now };
}

/** Current role of the user in the group, or null when not an active member. Always reads the DB. */
export function getMemberRole(db: Db, groupId: string, userId: string): GroupRoleName | null {
  const row = db.prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, userId) as
    | { role: GroupRoleName }
    | undefined;
  return row?.role ?? null;
}

/** Membership as of this instant. No caching: callers (feed ACL) must call it on every request. */
export function isActiveMember(db: Db, groupId: string, userId: string): boolean {
  return getMemberRole(db, groupId, userId) !== null;
}

export function listMemberGroupIds(db: Db, userId: string): string[] {
  return (db.prepare('SELECT group_id FROM group_members WHERE user_id = ? ORDER BY group_id').all(userId) as { group_id: string }[]).map(
    (r) => r.group_id,
  );
}

export function listGroupsForUser(db: Db, userId: string): GroupRow[] {
  const rows = db
    .prepare(
      `SELECT g.id AS groupId, g.name AS name, m.role AS role, g.created_at AS createdAt
       FROM group_members m JOIN groups g ON g.id = m.group_id
       WHERE m.user_id = ? ORDER BY g.created_at, g.id`,
    )
    .all(userId);
  return rows as unknown as GroupRow[];
}

/** Returns the plaintext token once; only its sha256 is stored. */
export function createInvite(
  db: Db,
  groupId: string,
  inviteeId: string | null,
  now: Date,
  ttlMs: number = INVITE_TTL_MS,
): { token: string; expiresAt: string } {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  db.prepare('INSERT INTO group_invites (token_hash, group_id, invitee_id, expires_at) VALUES (?, ?, ?, ?)').run(
    hashInviteToken(token),
    groupId,
    inviteeId,
    expiresAt,
  );
  return { token, expiresAt };
}

/** Pending (unconsumed, unexpired) invites allowed per group, to bound invite spam. */
export const MAX_PENDING_INVITES = 20;

export function countPendingInvites(db: Db, groupId: string, now: Date): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM group_invites WHERE group_id = ? AND consumed_at IS NULL AND expires_at > ?')
    .get(groupId, now.toISOString()) as { n: number };
  return Number(row.n);
}

export function userExists(db: Db, userId: string): boolean {
  return db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId) !== undefined;
}

export type AcceptResult =
  | { ok: true; groupId: string }
  | { ok: false; reason: 'NOT_FOUND' | 'EXPIRED' | 'CONSUMED' | 'ALREADY_MEMBER' };

/** Consumes the invite and adds the member atomically. A second use never succeeds. */
export function acceptInvite(db: Db, token: string, userId: string, now: Date): AcceptResult {
  const nowIso = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return transaction(db, (): AcceptResult => {
    const inv = db
      .prepare('SELECT group_id, invitee_id, expires_at, consumed_at FROM group_invites WHERE token_hash = ?')
      .get(hashInviteToken(token)) as
      | { group_id: string; invitee_id: string | null; expires_at: string; consumed_at: string | null }
      | undefined;
    if (!inv || (inv.invitee_id !== null && inv.invitee_id !== userId)) return { ok: false, reason: 'NOT_FOUND' };
    if (inv.consumed_at !== null) return { ok: false, reason: 'CONSUMED' };
    if (Date.parse(inv.expires_at) <= now.getTime()) return { ok: false, reason: 'EXPIRED' };
    if (isActiveMember(db, inv.group_id, userId)) return { ok: false, reason: 'ALREADY_MEMBER' };
    const upd = db
      .prepare('UPDATE group_invites SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL')
      .run(nowIso, hashInviteToken(token));
    if (Number(upd.changes) !== 1) return { ok: false, reason: 'CONSUMED' };
    db.prepare("INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)").run(
      inv.group_id,
      userId,
      nowIso,
    );
    return { ok: true, groupId: inv.group_id };
  });
}

export type RemoveResult = { ok: true } | { ok: false; reason: 'NOT_FOUND' | 'FORBIDDEN' };

/**
 * Removes a member (the row is deleted; "revoked" == no row). Rules: caller must be a member
 * (else NOT_FOUND); a member may remove themself; owner is never removable; admin/owner may remove
 * plain members; only the owner may remove an admin.
 */
export function removeMember(db: Db, groupId: string, actorId: string, targetId: string): RemoveResult {
  return transaction(db, (): RemoveResult => {
    const actor = getMemberRole(db, groupId, actorId);
    if (!actor) return { ok: false, reason: 'NOT_FOUND' };
    const target = getMemberRole(db, groupId, targetId);
    if (actorId !== targetId) {
      if (actor === 'member') return { ok: false, reason: 'FORBIDDEN' };
      if (!target) return { ok: false, reason: 'NOT_FOUND' };
      if (target === 'owner') return { ok: false, reason: 'FORBIDDEN' };
      if (target === 'admin' && actor !== 'owner') return { ok: false, reason: 'FORBIDDEN' };
    } else if (actor === 'owner') {
      return { ok: false, reason: 'FORBIDDEN' };
    }
    db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(groupId, targetId);
    // Invites addressed to the removed user must not let them rejoin (K17: removal takes effect now).
    db.prepare(
      'UPDATE group_invites SET consumed_at = ? WHERE group_id = ? AND invitee_id = ? AND consumed_at IS NULL',
    ).run(new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), groupId, targetId);
    return { ok: true };
  });
}
