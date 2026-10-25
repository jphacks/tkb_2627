/**
 * U09: wires PostCard callbacks to the API for a list or a single post. The screen owns the posts; this hook owns
 * the follow state of the authors, the viewer's own counts and the last action error.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiError, PostSummary, UserProfile } from '@tkb/contracts';
import type { SessionUser, SocialApi } from './api.ts';
import { toggleFollow, toggleLike, type LikePatch } from './postActions.ts';

export interface CardActionsOptions {
  api: SocialApi;
  user: SessionUser | null;
  /** userIds of the authors on screen (the viewer's own id is ignored). */
  authorIds: readonly string[];
  /** Apply a change to the post held by the screen. */
  patch: (postId: string, change: Partial<PostSummary>) => void;
  /** Remove the post from the screen (after a delete). */
  remove: (postId: string) => void;
  /** Load the viewer's own profile (counts) too. */
  withProfile?: boolean;
}

export function useCardActions({ api, user, authorIds, patch, remove, withProfile = false }: CardActionsOptions) {
  const [followed, setFollowed] = useState<Record<string, boolean>>({});
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [notice, setNotice] = useState<{ title: string; error: ApiError } | null>(null);
  const asked = useRef(new Set<string>());
  const me = user?.userId ?? null;

  const refreshProfile = useCallback(async () => {
    if (!withProfile || !me) return;
    const r = await api.getMyProfile();
    if (r.ok) setProfile(r.data);
  }, [api, me, withProfile]);

  useEffect(() => {
    void refreshProfile();
  }, [refreshProfile]);

  const ids = [...new Set(authorIds.filter(id => id !== me))].sort().join(',');
  useEffect(() => {
    if (!me) return;
    let live = true;
    for (const id of ids.split(',').filter(Boolean)) {
      if (asked.current.has(id)) continue;
      asked.current.add(id);
      void api.getUserProfile(id).then(r => {
        if (live && r.ok) setFollowed(f => ({ ...f, [id]: r.data.followedByMe }));
      });
    }
    return () => {
      live = false;
    };
  }, [api, me, ids]);

  const onLike = useCallback(
    (post: PostSummary) => {
      setNotice(null);
      void toggleLike(api, post, (change: LikePatch) => patch(post.postId, change)).then(e => {
        if (e) setNotice({ title: 'いいねできませんでした', error: e });
      });
    },
    [api, patch],
  );

  const onFollow = useCallback(
    (userId: string, follow: boolean) => {
      setNotice(null);
      void toggleFollow(api, userId, follow).then(r => {
        if (r.error) return setNotice({ title: follow ? 'フォローできませんでした' : 'フォローを解除できませんでした', error: r.error });
        setFollowed(f => ({ ...f, [userId]: r.profile.followedByMe }));
        void refreshProfile();
      });
    },
    [api, refreshProfile],
  );

  const onSaveStory = useCallback(
    async (post: PostSummary, story: string): Promise<ApiError | null> => {
      const r = await api.editStory(post.postId, post.postRevision, story);
      if (!r.ok) return r.error;
      patch(post.postId, { story: r.data.story, postRevision: r.data.postRevision, updatedAt: r.data.updatedAt ?? null });
      return null;
    },
    [api, patch],
  );

  const onDelete = useCallback(
    async (post: PostSummary): Promise<ApiError | null> => {
      const r = await api.deletePost(post.postId);
      if (!r.ok) return r.error;
      remove(post.postId);
      return null;
    },
    [api, remove],
  );

  return { followed, profile, notice, onLike, onFollow, onSaveStory, onDelete };
}
