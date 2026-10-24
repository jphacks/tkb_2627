import { createHash, randomUUID } from 'node:crypto';
import { PostSnapshot } from '@tkb/contracts';
import type { Db } from './index.ts';
import { transaction } from './repo.ts';

export type PostVisibility = 'private' | 'group' | 'public';
export type PostScope = 'public' | 'groups' | 'mine';

export const PREVIEW_TTL_MS = 10 * 60 * 1000;
export const hashPreviewToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export interface PostSummaryRecord {
  postId: string;
  postRevision: number;
  authorDisplayName: string;
  title: string;
  story: string;
  visibility: PostVisibility;
  groupId: string | null;
  area: string;
  startDate: string;
  createdAt: string;
}

export interface PostRecord extends PostSummaryRecord {
  snapshot: PostSnapshot;
}

export interface NewPreview {
  tokenHash: string;
  ownerId: string;
  tripId: string;
  sourceRevision: number;
  visibility: PostVisibility;
  groupId: string | null;
  story: string;
  snapshotJson: string;
  expiresAt: string;
}

/** At most this many unconsumed, unexpired previews per user. */
export const MAX_ACTIVE_PREVIEWS = 30;

/**
 * Stores the preview and drops previews that expired more than a day ago.
 * Returns false (nothing stored) when the owner already has MAX_ACTIVE_PREVIEWS live previews.
 */
export function insertPreview(db: Db, p: NewPreview, now: string): boolean {
  const cutoff = new Date(Date.parse(now) - 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return transaction(db, () => {
    db.prepare('DELETE FROM post_previews WHERE expires_at < ?').run(cutoff);
    const live = db
      .prepare('SELECT COUNT(*) AS n FROM post_previews WHERE owner_id = ? AND consumed_at IS NULL AND expires_at > ?')
      .get(p.ownerId, now) as { n: number };
    if (live.n >= MAX_ACTIVE_PREVIEWS) return false;
    db.prepare(
      `INSERT INTO post_previews (token_hash, owner_id, trip_id, source_revision, visibility, group_id, story, snapshot_json, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.tokenHash, p.ownerId, p.tripId, p.sourceRevision, p.visibility, p.groupId, p.story, p.snapshotJson, p.expiresAt);
    return true;
  });
}

interface PostRow {
  id: string;
  owner_id: string;
  revision: number;
  display_name: string;
  document_json: string;
  story: string;
  visibility: PostVisibility;
  group_id: string | null;
  created_at: string;
}

interface SummaryRow extends Omit<PostRow, 'document_json'> {
  title: string | null;
  area: string | null;
  start_date: string | null;
}

// The feed reads three scalar fields of the snapshot in SQL instead of parsing every document,
// so one corrupt snapshot cannot break a whole page.
const J = (path: string) => `CASE WHEN json_valid(s.document_json) THEN json_extract(s.document_json, '${path}') END`;
const SELECT_SUMMARY = `SELECT p.id, p.owner_id, p.revision, u.display_name, p.story, p.visibility, p.group_id, p.created_at,
  ${J('$.title')} AS title, ${J('$.constraints.area')} AS area, ${J('$.constraints.startDate')} AS start_date
  FROM posts p JOIN users u ON u.id = p.owner_id JOIN post_snapshots s ON s.id = p.snapshot_id`;

const SELECT = `SELECT p.id, p.owner_id, p.revision, u.display_name, s.document_json, p.story, p.visibility, p.group_id, p.created_at
  FROM posts p JOIN users u ON u.id = p.owner_id JOIN post_snapshots s ON s.id = p.snapshot_id`;

function toRecord(r: PostRow): PostRecord {
  const snapshot = PostSnapshot.parse(JSON.parse(r.document_json));
  return {
    postId: r.id,
    postRevision: r.revision,
    authorDisplayName: r.display_name,
    title: snapshot.title,
    story: r.story,
    visibility: r.visibility,
    groupId: r.group_id,
    area: snapshot.constraints.area,
    startDate: snapshot.constraints.startDate,
    createdAt: r.created_at,
    snapshot,
  };
}

function toSummary(r: SummaryRow): PostSummaryRecord {
  return {
    postId: r.id,
    postRevision: r.revision,
    authorDisplayName: r.display_name,
    title: r.title ?? '',
    story: r.story,
    visibility: r.visibility,
    groupId: r.group_id,
    area: r.area ?? '',
    startDate: r.start_date ?? '',
    createdAt: r.created_at,
  };
}

const MEMBER = 'EXISTS (SELECT 1 FROM group_members m WHERE m.group_id = p.group_id AND m.user_id = ?)';

export type CreatePostResult =
  | { ok: true; post: PostRecord }
  | { ok: false; code: 'NOT_FOUND' | 'EXPIRED' | 'ALREADY_COMMITTED' | 'REVISION_CONFLICT' };

/**
 * K13: re-checks owner, expiry, single use, the source trip's current revision and group membership,
 * then stores snapshot + post and consumes the preview, all in one transaction.
 */
export function createPostFromPreview(db: Db, tokenHash: string, ownerId: string, now: string): CreatePostResult {
  const res = transaction(db, (): CreatePostResult | { ok: 'created'; id: string } => {
    const pv = db.prepare('SELECT * FROM post_previews WHERE token_hash = ?').get(tokenHash) as
      | {
          owner_id: string;
          trip_id: string;
          source_revision: number;
          visibility: PostVisibility;
          group_id: string | null;
          story: string;
          snapshot_json: string;
          expires_at: string;
          consumed_at: string | null;
        }
      | undefined;
    if (!pv || pv.owner_id !== ownerId) return { ok: false, code: 'NOT_FOUND' };
    if (pv.consumed_at) return { ok: false, code: 'ALREADY_COMMITTED' };
    if (pv.expires_at <= now) return { ok: false, code: 'EXPIRED' };
    const trip = db
      .prepare('SELECT revision FROM trips WHERE id = ? AND owner_id = ? AND deleted_at IS NULL')
      .get(pv.trip_id, ownerId) as { revision: number } | undefined;
    if (!trip) return { ok: false, code: 'NOT_FOUND' };
    if (trip.revision !== pv.source_revision) return { ok: false, code: 'REVISION_CONFLICT' };
    if (pv.visibility === 'group') {
      const m = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(pv.group_id, ownerId);
      if (!m) return { ok: false, code: 'NOT_FOUND' };
    }
    const snapshotId = randomUUID();
    const postId = randomUUID();
    db.prepare('INSERT INTO post_snapshots (id, document_json, redaction_version, created_at) VALUES (?, ?, ?, ?)').run(
      snapshotId,
      pv.snapshot_json,
      (JSON.parse(pv.snapshot_json) as { redactionVersion: number }).redactionVersion,
      now,
    );
    db.prepare(
      `INSERT INTO posts (id, owner_id, source_trip_id, source_revision, snapshot_id, visibility, group_id, revision, story, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    ).run(postId, ownerId, pv.trip_id, pv.source_revision, snapshotId, pv.visibility, pv.group_id, pv.story, now, now);
    db.prepare('UPDATE post_previews SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL').run(now, tokenHash);
    return { ok: 'created', id: postId };
  });
  if (res.ok !== 'created') return res as CreatePostResult;
  return { ok: true, post: getPostForViewer(db, res.id, ownerId)! };
}

/** ACL is part of the WHERE clause: null when missing, deleted or not visible to this viewer (viewer null = anonymous). */
export function getPostForViewer(db: Db, postId: string, viewerId: string | null): PostRecord | null {
  const row = db
    .prepare(
      `${SELECT} WHERE p.id = ? AND p.deleted_at IS NULL
       AND (p.visibility = 'public' OR p.owner_id = ? OR (p.visibility = 'group' AND ${MEMBER}))`,
    )
    .get(postId, viewerId, viewerId) as PostRow | undefined;
  return row ? toRecord(row) : null;
}

export const encodeCursor = (createdAt: string, id: string): string =>
  Buffer.from(JSON.stringify([createdAt, id])).toString('base64url');

export function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string') {
      return { createdAt: v[0], id: v[1] };
    }
  } catch {
    /* fallthrough */
  }
  return null;
}

/**
 * K14 feed. ACL (scope + membership read live from group_members) is applied in WHERE before
 * ORDER BY and LIMIT. `scope` groups/mine need a viewer; anonymous gets nothing for them.
 */
export function listFeed(
  db: Db,
  q: { scope: PostScope; viewerId: string | null; cursor?: { createdAt: string; id: string }; limit: number },
): { items: PostSummaryRecord[]; nextCursor: string | null } {
  const params: (string | number | null)[] = [];
  let acl: string;
  if (q.scope === 'public') {
    acl = "p.visibility = 'public'";
  } else {
    if (!q.viewerId) return { items: [], nextCursor: null };
    if (q.scope === 'mine') {
      acl = 'p.owner_id = ?';
      params.push(q.viewerId);
    } else {
      acl = `p.visibility = 'group' AND ${MEMBER}`;
      params.push(q.viewerId);
    }
  }
  let where = `p.deleted_at IS NULL AND ${acl}`;
  if (q.cursor) {
    where += ' AND (p.created_at < ? OR (p.created_at = ? AND p.id < ?))';
    params.push(q.cursor.createdAt, q.cursor.createdAt, q.cursor.id);
  }
  params.push(q.limit + 1);
  const rows = db
    .prepare(`${SELECT_SUMMARY} WHERE ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT ?`)
    .all(...params) as unknown as SummaryRow[];
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toSummary),
    nextCursor: rows.length > q.limit && last ? encodeCursor(last.created_at, last.id) : null,
  };
}

export type PatchPostResult =
  | { ok: true; post: PostRecord }
  | { ok: false; code: 'NOT_FOUND' | 'REVISION_CONFLICT' | 'GROUP_INVALID' };

/** K15 owner-only optimistic update. Membership is re-checked only when the patch switches visibility to group (GROUP_INVALID for a missing or foreign group). */
export function patchPost(
  db: Db,
  postId: string,
  ownerId: string,
  expectedRevision: number,
  patch: { visibility?: PostVisibility; groupId?: string | null; story?: string },
  now: string,
): PatchPostResult {
  const r = transaction(db, (): { ok: boolean; code?: 'NOT_FOUND' | 'REVISION_CONFLICT' | 'GROUP_INVALID' } => {
    const cur = db
      .prepare('SELECT revision, visibility, group_id, story FROM posts WHERE id = ? AND owner_id = ? AND deleted_at IS NULL')
      .get(postId, ownerId) as { revision: number; visibility: PostVisibility; group_id: string | null; story: string } | undefined;
    if (!cur) return { ok: false, code: 'NOT_FOUND' };
    if (cur.revision !== expectedRevision) return { ok: false, code: 'REVISION_CONFLICT' };
    const visibility = patch.visibility ?? cur.visibility;
    const groupId = patch.visibility === undefined ? cur.group_id : visibility === 'group' ? (patch.groupId ?? null) : null;
    if (patch.visibility === 'group') {
      const m = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, ownerId);
      if (!m) return { ok: false, code: 'GROUP_INVALID' };
    }
    db.prepare('UPDATE posts SET visibility = ?, group_id = ?, story = ?, revision = revision + 1, updated_at = ? WHERE id = ?').run(
      visibility,
      groupId,
      patch.story ?? cur.story,
      now,
      postId,
    );
    return { ok: true };
  });
  if (!r.ok) return { ok: false, code: r.code! };
  return { ok: true, post: getPostForViewer(db, postId, ownerId)! };
}

/** K15 soft delete (owner only). Returns false when missing, already deleted or not the owner's. */
export function deletePost(db: Db, postId: string, ownerId: string, now: string): boolean {
  const res = db
    .prepare('UPDATE posts SET deleted_at = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL')
    .run(now, now, postId, ownerId);
  return Number(res.changes) > 0;
}

/**
 * Call when a source trip is deleted (S04): its live posts become private and their revision bumps.
 * Returns the number of posts changed.
 */
export function hidePostsForTrip(db: Db, tripId: string, ownerId: string, now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')): number {
  const res = db
    .prepare(
      `UPDATE posts SET visibility = 'private', group_id = NULL, revision = revision + 1, updated_at = ?
       WHERE source_trip_id = ? AND owner_id = ? AND deleted_at IS NULL AND visibility <> 'private'`,
    )
    .run(now, tripId, ownerId);
  return Number(res.changes);
}
