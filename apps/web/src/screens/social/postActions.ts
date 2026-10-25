/**
 * U09 post actions shared by the feed and the detail screen. Pure logic around the typed client, so it can be
 * tested without a browser: optimistic like with rollback, follow with count refresh.
 */
import type { ApiError, PostSummary, UserProfile } from '@tkb/contracts';
import type { SocialApi } from './api.ts';

export interface LikePatch { likedByMe: boolean; likeCount: number }

/**
 * Heart toggle. `apply` is called immediately with the expected state (optimistic), again with the server's
 * LikeState on success, or with the previous state when the request fails (rollback). Returns the error, or null.
 */
export async function toggleLike(
  api: SocialApi,
  post: Pick<PostSummary, 'postId' | 'likedByMe' | 'likeCount'>,
  apply: (patch: LikePatch) => void,
): Promise<ApiError | null> {
  const prev: LikePatch = { likedByMe: post.likedByMe ?? false, likeCount: post.likeCount ?? 0 };
  const next = !prev.likedByMe;
  apply({ likedByMe: next, likeCount: Math.max(0, prev.likeCount + (next ? 1 : -1)) });
  const r = await api.setLike(post.postId, next);
  if (!r.ok) {
    apply(prev);
    return r.error;
  }
  apply({ likedByMe: r.data.likedByMe, likeCount: r.data.likeCount });
  return null;
}

/** Follow / unfollow an author. Returns the author's new profile, or the error. */
export async function toggleFollow(
  api: SocialApi,
  userId: string,
  follow: boolean,
): Promise<{ profile: UserProfile; error: null } | { profile: null; error: ApiError }> {
  const r = await api.setFollow(userId, follow);
  return r.ok ? { profile: r.data, error: null } : { profile: null, error: r.error };
}

/** Time shown on a card: a short local date and time. */
export function postTimeLabel(createdAt: string): string {
  const d = new Date(createdAt);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
