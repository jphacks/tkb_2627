import type { Db } from './index.ts';

export interface UserRow {
  id: string;
  loginId: string;
  passwordHash: string;
  displayName: string;
}

interface RawUser {
  id: string;
  login_id: string;
  password_hash: string;
  display_name: string;
}

const toUser = (r: RawUser | undefined): UserRow | null =>
  r ? { id: r.id, loginId: r.login_id, passwordHash: r.password_hash, displayName: r.display_name } : null;

export function getUserByLoginId(db: Db, loginId: string): UserRow | null {
  return toUser(db.prepare('SELECT * FROM users WHERE login_id = ?').get(loginId) as RawUser | undefined);
}

export function getUserById(db: Db, id: string): UserRow | null {
  return toUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id) as RawUser | undefined);
}

/** `idHash` is sha256(token); the raw session token is never stored (K11). */
export function createSession(db: Db, s: { idHash: string; userId: string; expiresAt: string }): void {
  db.prepare('INSERT INTO sessions (id_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    s.idHash,
    s.userId,
    s.expiresAt,
  );
}

/** Returns the owner of a live (not revoked, not expired) session, else null. */
export function findActiveSessionUser(db: Db, idHash: string, nowIso: string): UserRow | null {
  const r = db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
    )
    .get(idHash, nowIso) as RawUser | undefined;
  return toUser(r);
}

export function revokeSession(db: Db, idHash: string, nowIso: string): void {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL').run(nowIso, idHash);
}
