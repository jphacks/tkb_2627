import { createHash, randomUUID } from 'node:crypto';
import { PostSnapshot } from '@tkb/contracts';
import type { Db } from './index.ts';
import { transaction } from './repo.ts';

export type PostVisibility = 'private' | 'group' | 'public';
export type PostScope = 'public' | 'groups' | 'mine' | 'following';

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
  author?: PostAuthorRecord;
  isMine?: boolean;
  likeCount?: number;
  likedByMe?: boolean;
  images?: PostImageRecord[];
  updatedAt?: string | null;
}

export interface PostAuthorRecord {
  userId: string;
  displayName: string;
  avatarInitial: string;
  avatarColor: string;
}
export interface PostImageRecord {
  imageId: string;
  url: string;
  width: number | null;
  height: number | null;
}

/** Fixed palette; the colour is a stable function of the user id (never stored, never user-chosen). */
export const AVATAR_PALETTE = ['#e57373', '#f06292', '#ba68c8', '#7986cb', '#4fc3f7', '#4db6ac', '#81c784', '#dce775', '#ffb74d', '#a1887f'] as const;
export function authorOf(userId: string, displayName: string): PostAuthorRecord {
  const h = createHash('sha256').update(userId).digest();
  return {
    userId,
    displayName,
    avatarInitial: Array.from(displayName.trim())[0] ?? '?',
    avatarColor: AVATAR_PALETTE[h.readUInt32BE(0) % AVATAR_PALETTE.length]!,
  };
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
  imageIds?: string[];
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
      `INSERT INTO post_previews (token_hash, owner_id, trip_id, source_revision, visibility, group_id, story, snapshot_json, expires_at, image_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.tokenHash, p.ownerId, p.tripId, p.sourceRevision, p.visibility, p.groupId, p.story, p.snapshotJson, p.expiresAt, JSON.stringify(p.imageIds ?? []));
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
  updated_at: string;
}

interface SummaryRow extends Omit<PostRow, 'document_json'> {
  title: string | null;
  area: string | null;
  start_date: string | null;
}

// The feed reads three scalar fields of the snapshot in SQL instead of parsing every document,
// so one corrupt snapshot cannot break a whole page.
const J = (path: string) => `CASE WHEN json_valid(s.document_json) THEN json_extract(s.document_json, '${path}') END`;
const SELECT_SUMMARY = `SELECT p.id, p.owner_id, p.revision, u.display_name, p.story, p.visibility, p.group_id, p.created_at, p.updated_at,
  ${J('$.title')} AS title, ${J('$.constraints.area')} AS area, ${J('$.constraints.startDate')} AS start_date
  FROM posts p JOIN users u ON u.id = p.owner_id JOIN post_snapshots s ON s.id = p.snapshot_id`;

const SELECT = `SELECT p.id, p.owner_id, p.revision, u.display_name, s.document_json, p.story, p.visibility, p.group_id, p.created_at, p.updated_at
  FROM posts p JOIN users u ON u.id = p.owner_id JOIN post_snapshots s ON s.id = p.snapshot_id`;

interface Extras {
  author: PostAuthorRecord;
  isMine: boolean;
  likeCount: number;
  likedByMe: boolean;
  images: PostImageRecord[];
  updatedAt: string | null;
}

/** Batch-loads author, like and image data for a page of rows (a few queries per page, not per post). */
function extrasFor(
  db: Db,
  rows: { id: string; owner_id: string; display_name: string; revision: number; updated_at: string }[],
  viewerId: string | null,
): Map<string, Extras> {
  const out = new Map<string, Extras>();
  if (rows.length === 0) return out;
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => '?').join(',');
  const likes = new Map<string, { n: number; mine: number }>();
  for (const l of db
    .prepare(`SELECT post_id, COUNT(*) AS n, SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS mine FROM post_likes WHERE post_id IN (${marks}) GROUP BY post_id`)
    .all(viewerId, ...ids) as { post_id: string; n: number; mine: number }[]) {
    likes.set(l.post_id, { n: Number(l.n), mine: Number(l.mine) });
  }
  const images = new Map<string, PostImageRecord[]>();
  for (const i of db
    .prepare(`SELECT id, post_id, width, height FROM post_images WHERE post_id IN (${marks}) ORDER BY position, id`)
    .all(...ids) as { id: string; post_id: string; width: number | null; height: number | null }[]) {
    const list = images.get(i.post_id) ?? [];
    list.push({ imageId: i.id, url: `/api/v1/post-images/${i.id}`, width: i.width, height: i.height });
    images.set(i.post_id, list);
  }
  for (const r of rows) {
    const l = likes.get(r.id);
    out.set(r.id, {
      author: authorOf(r.owner_id, r.display_name),
      isMine: viewerId !== null && r.owner_id === viewerId,
      likeCount: l?.n ?? 0,
      likedByMe: (l?.mine ?? 0) > 0,
      images: images.get(r.id) ?? [],
      // Only an edited post carries updatedAt (creation also writes updated_at, which is not an edit).
      updatedAt: r.revision > 1 ? r.updated_at : null,
    });
  }
  return out;
}

function toRecord(r: PostRow, x: Extras): PostRecord {
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
    ...x,
    snapshot,
  };
}

function toSummary(r: SummaryRow, x: Extras): PostSummaryRecord {
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
    ...x,
  };
}

const MEMBER = 'EXISTS (SELECT 1 FROM group_members m WHERE m.group_id = p.group_id AND m.user_id = ?)';

/** True when every id is a distinct image uploaded by `ownerId` and not yet attached to a post (max 4). */
export function ownUnattachedImages(db: Db, ownerId: string, ids: string[]): boolean {
  if (ids.length > 4 || new Set(ids).size !== ids.length) return false;
  return ids.every(
    (id) => db.prepare('SELECT 1 FROM post_images WHERE id = ? AND owner_id = ? AND post_id IS NULL').get(id, ownerId) !== undefined,
  );
}

export type CreatePostResult =
  | { ok: true; post: PostRecord }
  | { ok: false; code: 'NOT_FOUND' | 'EXPIRED' | 'ALREADY_COMMITTED' | 'REVISION_CONFLICT' | 'IMAGES_INVALID' };

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
          image_ids: string;
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
    const imageIds = JSON.parse(pv.image_ids) as string[];
    if (!ownUnattachedImages(db, ownerId, imageIds)) return { ok: false, code: 'IMAGES_INVALID' };
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
    imageIds.forEach((id, i) => {
      db.prepare('UPDATE post_images SET post_id = ?, position = ? WHERE id = ?').run(postId, i, id);
    });
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
  return row ? toRecord(row, extrasFor(db, [row], viewerId).get(row.id)!) : null;
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
    } else if (q.scope === 'following') {
      // Following only narrows the list; readability is still public or a group the viewer belongs to.
      acl = `p.owner_id IN (SELECT followee_id FROM follows WHERE follower_id = ?)
        AND (p.visibility = 'public' OR (p.visibility = 'group' AND ${MEMBER}))`;
      params.push(q.viewerId, q.viewerId);
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
  const ex = extrasFor(db, page, q.viewerId);
  return {
    items: page.map((r) => toSummary(r, ex.get(r.id)!)),
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
