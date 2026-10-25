import { randomUUID } from 'node:crypto';
import type { Db } from './index.ts';
import { authorOf, type PostAuthorRecord } from './posts.ts';

/** A post the viewer may read (same rule as getPostForViewer, without loading the snapshot). */
const READABLE = `p.id = ? AND p.deleted_at IS NULL
  AND (p.visibility = 'public' OR p.owner_id = ? OR (p.visibility = 'group'
    AND EXISTS (SELECT 1 FROM group_members m WHERE m.group_id = p.group_id AND m.user_id = ?)))`;

export interface LikeStateRecord {
  postId: string;
  likeCount: number;
  likedByMe: boolean;
}

/** Idempotent like / unlike. null when the viewer cannot read the post (never reveals existence). */
export function setLike(db: Db, postId: string, userId: string, liked: boolean, now: string): LikeStateRecord | null {
  const ok = db.prepare(`SELECT 1 FROM posts p WHERE ${READABLE}`).get(postId, userId, userId);
  if (!ok) return null;
  if (liked) db.prepare('INSERT OR IGNORE INTO post_likes (post_id, user_id, created_at) VALUES (?, ?, ?)').run(postId, userId, now);
  else db.prepare('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?').run(postId, userId);
  const n = db.prepare('SELECT COUNT(*) AS n FROM post_likes WHERE post_id = ?').get(postId) as { n: number };
  return { postId, likeCount: Number(n.n), likedByMe: liked };
}

export interface UserProfileRecord {
  user: PostAuthorRecord;
  followerCount: number;
  followingCount: number;
  followedByMe: boolean;
  isMe: boolean;
}

export function getProfile(db: Db, userId: string, viewerId: string): UserProfileRecord | null {
  const u = db.prepare('SELECT id, display_name FROM users WHERE id = ?').get(userId) as
    | { id: string; display_name: string }
    | undefined;
  if (!u) return null;
  const count = (col: 'followee_id' | 'follower_id') =>
    Number((db.prepare(`SELECT COUNT(*) AS n FROM follows WHERE ${col} = ?`).get(userId) as { n: number }).n);
  return {
    user: authorOf(u.id, u.display_name),
    followerCount: count('followee_id'),
    followingCount: count('follower_id'),
    followedByMe: db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(viewerId, userId) !== undefined,
    isMe: userId === viewerId,
  };
}

/** Idempotent follow / unfollow. 'SELF' for yourself, 'NOT_FOUND' for an unknown user. */
export function setFollow(db: Db, followerId: string, followeeId: string, follow: boolean, now: string): 'OK' | 'SELF' | 'NOT_FOUND' {
  if (followerId === followeeId) return 'SELF';
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(followeeId)) return 'NOT_FOUND';
  if (follow) db.prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)').run(followerId, followeeId, now);
  else db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(followerId, followeeId);
  return 'OK';
}

/** Unattached uploads per user are capped so the table cannot be filled without posting. */
export const MAX_UNATTACHED_IMAGES = 20;

export interface NewImage {
  ownerId: string;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  bytes: Uint8Array;
  width: number | null;
  height: number | null;
  now: string;
}

/** Returns the new id, or null when the owner already holds MAX_UNATTACHED_IMAGES unattached uploads. */
export function insertImage(db: Db, img: NewImage): string | null {
  const n = db.prepare('SELECT COUNT(*) AS n FROM post_images WHERE owner_id = ? AND post_id IS NULL').get(img.ownerId) as { n: number };
  if (Number(n.n) >= MAX_UNATTACHED_IMAGES) return null;
  const id = randomUUID();
  db.prepare('INSERT INTO post_images (id, owner_id, content_type, bytes, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    img.ownerId,
    img.contentType,
    img.bytes,
    img.width,
    img.height,
    img.now,
  );
  return id;
}

/**
 * Bytes of an image the viewer may see: unattached -> uploader only; attached -> whoever can read the post
 * (a deleted post hides its images). viewer null = anonymous.
 */
export function getImageForViewer(db: Db, imageId: string, viewerId: string | null): { contentType: string; bytes: Uint8Array } | null {
  const r = db
    .prepare(
      `SELECT i.content_type, i.bytes FROM post_images i LEFT JOIN posts p ON p.id = i.post_id
       WHERE i.id = ? AND (
         (i.post_id IS NULL AND i.owner_id = ?)
         OR (p.id IS NOT NULL AND p.deleted_at IS NULL AND (p.visibility = 'public' OR p.owner_id = ?
           OR (p.visibility = 'group' AND EXISTS (SELECT 1 FROM group_members m WHERE m.group_id = p.group_id AND m.user_id = ?)))))`,
    )
    .get(imageId, viewerId, viewerId, viewerId) as { content_type: string; bytes: Uint8Array } | undefined;
  return r ? { contentType: r.content_type, bytes: r.bytes } : null;
}
