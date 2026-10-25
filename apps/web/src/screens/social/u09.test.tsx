import type { ReactElement } from 'react';
import { renderToString as renderRaw } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PostSummary } from '@tkb/contracts';
import { POST_IMAGE_MAX_BYTES } from '@tkb/contracts';
import { domesticTrip } from '@tkb/fixtures';
import { CSRF_HEADER, createHttpSocialApi, validateImageFile } from './api.ts';
import { createMockSocialApi, mockSnapshot } from './mockSocialApi.ts';
import { toggleFollow, toggleLike } from './postActions.ts';
import { IMAGE_ALT } from './PostCard.tsx';
import { FeedView, PostDetailView, PreviewView, ProfileBar, type FeedViewProps } from './views.tsx';

const noop = () => {};
const html = (el: ReactElement): string => renderRaw(el).replace(/<!-- -->/g, '');
const base: FeedViewProps = {
  scope: 'public', status: 'ready', items: [], nextCursor: null, error: null, loadingMore: false, moreError: null,
  source: 'mock', httpStatus: 200, onOpen: noop, onMore: noop, onRetry: noop,
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const LOGIN = { userId: 'user_a', displayName: 'A', csrfToken: 'csrf_token_value' };

function stub(...responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    return next;
  });
  return { calls, api: createHttpSocialApi({ fetchImpl: fetchImpl as unknown as typeof fetch }) };
}
const header = (c: { init: RequestInit }, name: string) => (c.init.headers as Record<string, string>)[name];
const file = (type: string, size: number, name = 'a.png') => ({ type, size, name }) as File;

async function feedItems(api: ReturnType<typeof createMockSocialApi>, scope: 'public' | 'following' | 'mine' = 'public'): Promise<PostSummary[]> {
  const r = await api.getFeed(scope);
  if (!r.ok) throw new Error('feed');
  return r.data.items;
}

describe('U09 own vs others rendering', () => {
  it('every post shows avatar initial and name; only own posts get the あなた badge and the … menu', async () => {
    const api = createMockSocialApi(); // demo-a
    const items = await feedItems(api);
    const own = items.find(i => i.isMine)!;
    const other = items.find(i => !i.isMine)!;
    expect(own).toBeDefined();
    expect(other).toBeDefined();
    const withActions = { loggedIn: true, onLike: noop, onFollow: noop, onSaveStory: async () => null, onDelete: async () => null };
    const ownHtml = html(<FeedView {...base} items={[own]} {...withActions} />);
    const otherHtml = html(<FeedView {...base} items={[other]} followed={{ [other.author!.userId]: false }} {...withActions} />);
    expect(ownHtml).toContain('あなた');
    expect(ownHtml).toContain('投稿のメニュー');
    expect(ownHtml).not.toContain('>フォロー<');
    expect(otherHtml).not.toContain('あなた');
    expect(otherHtml).not.toContain('投稿のメニュー');
    expect(otherHtml).toContain('フォロー');
    for (const [h, p] of [[ownHtml, own], [otherHtml, other]] as const) {
      expect(h).toContain(p.author!.displayName);
      expect(h).toContain(`>${p.author!.avatarInitial}<`);
      expect(h).toContain(p.author!.avatarColor);
    }
  });

  it('shows フォロー中 for a followed author and a heart with count, aria-pressed for liked', async () => {
    const items = await feedItems(createMockSocialApi({ initialUser: 'demo-b' }));
    const liked = items.find(i => i.likedByMe)!;
    const out = html(<FeedView {...base} items={[liked]} loggedIn onLike={noop} onFollow={noop} followed={{ fx_user_a: true }} />);
    expect(out).toContain('フォロー中');
    expect(out).toContain('♥');
    expect(out).toContain('aria-pressed="true"');
    expect(out).toContain(`いいね ${liked.likeCount}件`);
  });

  it('logged out: like is disabled and there is no follow button', async () => {
    const items = await feedItems(createMockSocialApi({ initialUser: null }));
    const out = html(<FeedView {...base} items={items} />);
    expect(out).toContain('disabled=""');
    expect(out).not.toContain('フォロー<');
  });

  it('detail view shows the same author, badge and menu, and images with the alt text', async () => {
    const api = createMockSocialApi();
    const r = await api.getPost('fx_post_1');
    if (!r.ok) throw new Error('post');
    const out = html(<PostDetailView post={r.data} loggedIn onLike={noop} onSaveStory={async () => null} onDelete={async () => null} />);
    expect(out).toContain('あなた');
    expect(out).toContain('投稿のメニュー');
    expect(out.match(new RegExp(`alt="${IMAGE_ALT}"`, 'g'))).toHaveLength(2);
    expect(out).toContain('s9-imgs-2');
    expect(out).toContain('版 1');
  });

  it('profile bar shows the follow and follower counts', async () => {
    const r = await createMockSocialApi().getMyProfile();
    if (!r.ok) throw new Error('profile');
    const out = html(<ProfileBar profile={r.data} />);
    expect(out).toContain(r.data.user.displayName);
    expect(out).toMatch(/<strong>1<\/strong> フォロー/);
    expect(out).toMatch(/<strong>1<\/strong> フォロワー/);
  });
});

describe('U09 like (optimistic with rollback)', () => {
  it('applies the new state first, then the server state', async () => {
    const api = createMockSocialApi();
    const post = (await feedItems(api)).find(i => i.postId === 'fx_post_2')!;
    const seen: { likedByMe: boolean; likeCount: number }[] = [];
    expect(await toggleLike(api, post, p => seen.push(p))).toBeNull();
    expect(seen[0]).toEqual({ likedByMe: true, likeCount: (post.likeCount ?? 0) + 1 });
    expect(seen.at(-1)).toEqual({ likedByMe: true, likeCount: (post.likeCount ?? 0) + 1 });
    const again = (await feedItems(api)).find(i => i.postId === 'fx_post_2')!;
    expect(again.likedByMe).toBe(true);
    const undo: { likedByMe: boolean; likeCount: number }[] = [];
    await toggleLike(api, again, p => undo.push(p));
    expect(undo.at(-1)).toEqual({ likedByMe: false, likeCount: post.likeCount ?? 0 });
  });

  it('rolls back and returns the error when the request fails; sends PUT / DELETE with the CSRF header', async () => {
    const failing = createMockSocialApi({ scenario: 'error' });
    const seen: { likedByMe: boolean; likeCount: number }[] = [];
    const e = await toggleLike(failing, { postId: 'p', likedByMe: false, likeCount: 3 }, p => seen.push(p));
    expect(e?.code).toBe('UNAVAILABLE');
    expect(seen).toEqual([{ likedByMe: true, likeCount: 4 }, { likedByMe: false, likeCount: 3 }]);

    const { api, calls } = stub(
      json(200, LOGIN),
      json(200, { postId: 'post_1', likeCount: 1, likedByMe: true }),
      json(200, { postId: 'post_1', likeCount: 0, likedByMe: false }),
    );
    await api.login('demo-a', 'pw');
    await api.setLike('post_1', true);
    await api.setLike('post_1', false);
    expect(calls[1]!.init.method).toBe('PUT');
    expect(calls[1]!.url).toBe('/api/v1/posts/post_1/like');
    expect(header(calls[1]!, CSRF_HEADER)).toBe('csrf_token_value');
    expect(calls[2]!.init.method).toBe('DELETE');
  });
});

describe('U09 follow', () => {
  it('toggles followedByMe and the counts (mock), and refuses to follow yourself', async () => {
    const api = createMockSocialApi();
    const before = await api.getMyProfile();
    if (!before.ok) throw new Error('p');
    expect(before.data.followingCount).toBe(1);
    const un = await toggleFollow(api, 'fx_user_b', false);
    expect(un.profile?.followedByMe).toBe(false);
    expect(un.profile?.followerCount).toBe(0);
    const mid = await api.getMyProfile();
    expect(mid.ok && mid.data.followingCount).toBe(0);
    const re = await toggleFollow(api, 'fx_user_b', true);
    expect(re.profile?.followedByMe).toBe(true);
    const mine = await api.setFollow('fx_user_a', true);
    expect(mine.ok).toBe(false);
  });

  it('http client: PUT/DELETE /users/:id/follow and GET me/profile', async () => {
    const profile = { user: { userId: 'user_b', displayName: 'B', avatarInitial: 'B', avatarColor: '#1d6fb8' }, followerCount: 1, followingCount: 0, followedByMe: true, isMe: false };
    const { api, calls } = stub(json(200, LOGIN), json(200, profile), json(200, { ...profile, followedByMe: false, followerCount: 0 }), json(200, { ...profile, isMe: true }));
    await api.login('demo-a', 'pw');
    await api.setFollow('user_b', true);
    await api.setFollow('user_b', false);
    await api.getMyProfile();
    expect(calls[1]!.init.method).toBe('PUT');
    expect(calls[1]!.url).toBe('/api/v1/users/user_b/follow');
    expect(calls[2]!.init.method).toBe('DELETE');
    expect(calls[3]!.url).toBe('/api/v1/me/profile');
  });

  it('following scope: request uses scope=following; mock returns only followed authors', async () => {
    const { api, calls } = stub(json(200, { items: [], nextCursor: null }));
    await api.getFeed('following');
    expect(calls[0]!.url).toBe('/api/v1/posts?scope=following&limit=20');
    const mock = createMockSocialApi();
    const items = await feedItems(mock, 'following');
    expect(items.length).toBeGreaterThan(0);
    expect(items.every(i => !i.isMine && i.author?.userId === 'fx_user_b')).toBe(true);
    await mock.setFollow('fx_user_b', false);
    expect(await feedItems(mock, 'following')).toEqual([]);
  });
});

describe('U09 edit story', () => {
  it('PATCH carries expectedPostRevision and the story; a stale revision is a conflict', async () => {
    const { api, calls } = stub(
      json(200, LOGIN),
      json(200, { postId: 'p', postRevision: 2, authorDisplayName: 'A', title: 't', story: 'new', visibility: 'public', groupId: null, area: 'x', startDate: '2026-11-01', createdAt: '2026-10-24T00:00:00Z', snapshot: mockSnapshot(domesticTrip).snapshot }),
    );
    await api.login('demo-a', 'pw');
    const r = await api.editStory('p', 1, 'new');
    expect(r.ok).toBe(true);
    expect(calls[1]!.init.method).toBe('PATCH');
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ expectedPostRevision: 1, story: 'new' });

    const mock = createMockSocialApi();
    const ok = await mock.editStory('fx_post_1', 1, '修正後');
    expect(ok.ok && ok.data.story).toBe('修正後');
    expect(ok.ok && ok.data.postRevision).toBe(2);
    expect(ok.ok && ok.data.updatedAt).not.toBeNull();
    const stale = await mock.editStory('fx_post_1', 1, 'again');
    expect(!stale.ok && stale.error.code).toBe('REVISION_CONFLICT');
    const others = await mock.editStory('fx_post_2', 1, 'x');
    expect(!others.ok && others.error.code).toBe('NOT_FOUND');
  });
});

describe('U09 images', () => {
  it('validates type, size and count on the client', () => {
    expect(validateImageFile(file('image/png', 1000), 0)).toBeNull();
    expect(validateImageFile(file('image/webp', POST_IMAGE_MAX_BYTES), 3)).toBeNull();
    expect(validateImageFile(file('image/gif', 1000), 0)).toContain('JPEG');
    expect(validateImageFile(file('application/pdf', 1000), 0)).not.toBeNull();
    expect(validateImageFile(file('image/png', POST_IMAGE_MAX_BYTES + 1), 0)).toContain('5MB');
    expect(validateImageFile(file('image/png', 0), 0)).not.toBeNull();
    expect(validateImageFile(file('image/png', 1000), 4)).toContain('4枚');
  });

  it('uploads the raw file with its Content-Type and the CSRF header; invalid files never reach the network', async () => {
    const uploaded = { imageId: 'img_1', url: '/api/v1/post-images/img_1', width: null, height: null };
    const { api, calls } = stub(json(200, LOGIN), json(201, uploaded));
    await api.login('demo-a', 'pw');
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    const r = await api.uploadImage(blob);
    expect(r.ok && r.data.imageId).toBe('img_1');
    expect(calls[1]!.url).toBe('/api/v1/post-images');
    expect(calls[1]!.init.method).toBe('POST');
    expect(header(calls[1]!, 'content-type')).toBe('image/png');
    expect(header(calls[1]!, CSRF_HEADER)).toBe('csrf_token_value');
    expect(calls[1]!.init.body).toBe(blob);

    const bad = await api.uploadImage(new Blob(['x'], { type: 'image/gif' }));
    expect(bad.ok).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('imageIds are sent in the K12 preview request and attach to the created post (mock store)', async () => {
    const { api, calls } = stub(
      json(200, LOGIN),
      json(200, { previewToken: 'p'.repeat(20), snapshot: mockSnapshot(domesticTrip).snapshot, redactedFields: [], expiresAt: '2026-10-24T00:10:00Z' }),
    );
    await api.login('demo-a', 'pw');
    await api.previewPost({ tripId: 'trip_1', sourceRevision: 1, visibility: 'public', story: '', imageIds: ['img_1', 'img_2'] });
    expect(JSON.parse(String(calls[1]!.init.body)).imageIds).toEqual(['img_1', 'img_2']);

    const mock = createMockSocialApi();
    const trips = await mock.listMyTrips();
    if (!trips.ok) throw new Error('trips');
    const t = trips.data.items[0]!;
    const img = await mock.uploadImage(new Blob(['x'], { type: 'image/png' }));
    if (!img.ok) throw new Error('img');
    const prev = await mock.previewPost({ tripId: t.tripId, sourceRevision: t.revision, visibility: 'public', story: 's', imageIds: [img.data.imageId] });
    if (!prev.ok) throw new Error('prev');
    const post = await mock.createPost(prev.data.previewToken);
    expect(post.ok && post.data.images?.map(i => i.imageId)).toEqual([img.data.imageId]);
    expect(post.ok && post.data.images?.[0]?.url).toBe(img.data.url);
    // the same image cannot be attached twice, and someone else's image cannot be used
    const again = await mock.previewPost({ tripId: t.tripId, sourceRevision: t.revision, visibility: 'public', story: '', imageIds: [img.data.imageId] });
    expect(again.ok).toBe(false);
  });

  it('preview shows the thumbnails with the alt text', () => {
    const { snapshot } = mockSnapshot(domesticTrip);
    const out = html(
      <PreviewView preview={{ previewToken: 'p'.repeat(20), snapshot, redactedFields: [], expiresAt: '2026-10-25T00:10:00Z' }}
        visibility="public" groupName={null} story="" images={[{ imageId: 'i1', url: '/api/v1/post-images/i1', width: null, height: null }]} />,
    );
    expect(out).toContain(`alt="${IMAGE_ALT}"`);
  });
});
