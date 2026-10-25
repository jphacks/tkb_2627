/**
 * In-memory mock of K11/K09(read)/K12-K17 for reviewing the U08 screens without a server.
 *
 * - No network and no browser storage. Two demo accounts (demo-a / demo-b, any password) so the
 *   visibility rules can be tried by switching the account.
 * - The ACL is applied inside the mock (like the server's WHERE clause): the screens never filter.
 * - Every success is parsed with the @tkb/contracts schema before it is returned.
 * - Simplified compared with the server (screens must not depend on these): the snapshot is a plain
 *   allow-list of the fixture trip (no provenance / home-place redaction), no 10-minute preview cleanup,
 *   no rate limits, no Origin check.
 */
import {
  CopyRequest,
  CopyResult,
  ERROR_HTTP_STATUS,
  Feed,
  FeedQuery,
  Group,
  GroupInviteCreated,
  LikeState,
  Membership,
  Post,
  PostAuthor,
  PostImage,
  PostPreview,
  PostPreviewRequest,
  PostSnapshot,
  PublicActivity,
  PublicTripConstraints,
  Trip,
  TripList,
  UserProfile,
  type ApiError,
  type ErrorCode,
  type PostSummary,
  type Visibility,
} from '@tkb/contracts';
import { domesticTrip, fixtureTrips, overseasTrip } from '@tkb/fixtures';
import type { z } from 'zod';
import { GroupList, registerImageSource, validateImageFile, type SessionUser, type SocialApi, type SocialResult } from './api.ts';

export type MockSocialScenario = 'normal' | 'empty' | 'error' | 'slow';

export interface MockSocialOptions {
  scenario?: MockSocialScenario;
  /** Delay before every response. Default 800 for 'slow', otherwise 0. */
  delayMs?: number;
  now?: () => Date;
  /** Logged-in user at start. Default demo-a; null = logged out. */
  initialUser?: 'demo-a' | 'demo-b' | null;
  /** Origin used in invite URLs. Default location.origin, or http://127.0.0.1:5173 outside a browser. */
  origin?: string;
}

export const MOCK_USERS: Record<string, SessionUser> = {
  'demo-a': { userId: 'fx_user_a', displayName: 'デモ利用者A' },
  'demo-b': { userId: 'fx_user_b', displayName: 'デモ利用者B' },
};

interface PostRecord {
  post: Post;
  ownerId: string;
  deleted: boolean;
  imageIds: string[];
  updatedAt: string | null;
}

/** The mock's fake image store: bytes are never kept, only who uploaded the image and where it is attached. */
interface ImageRecord {
  ownerId: string;
  attachedTo: string | null;
}

const AVATAR_COLORS = ['#1d6fb8', '#2f855a', '#b7791f', '#c05621', '#6b46c1', '#b83280'];
const colorOf = (userId: string): string => {
  let h = 0;
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
};
const placeholderSvg = (label: string, color: string): string =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420"><rect width="640" height="420" fill="${color}"/><text x="320" y="225" font-size="40" fill="#fff" text-anchor="middle" font-family="sans-serif">${label}</text></svg>`)}`;

interface PreviewRecord {
  ownerId: string;
  tripId: string;
  sourceRevision: number;
  visibility: Visibility;
  groupId: string | null;
  story: string;
  imageIds: string[];
  snapshot: PostSnapshot;
  expiresAt: number;
  used: boolean;
}

interface GroupRecord {
  group: Omit<Group, 'role'>;
  members: Map<string, Group['role']>;
}

interface InviteRecord {
  groupId: string;
  expiresAt: number;
  used: boolean;
}

const PREVIEW_TTL_MS = 10 * 60_000;
const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Allow-list snapshot of a trip (the mock's stand-in for the server's buildSnapshot). */
export function mockSnapshot(trip: Trip): { snapshot: PostSnapshot; redactedFields: string[] } {
  const removed = new Set<string>(['preciseCurrentLocation', 'privateNotes']);
  const c = trip.constraints;
  for (const k of ['budget', 'departure', 'return', 'mustVisit', 'preferences'] as const) {
    if (c[k] !== undefined && c[k] !== null) removed.add(k);
  }
  if (c.departure || c.return) removed.add('homeAddress');
  const home = new Set<string>();
  for (const e of [c.departure, c.return]) if (e?.placeId) home.add(e.placeId);
  const referenced = new Set<string>();
  const days = trip.days.map(d => ({
    date: d.date,
    timeZone: d.timeZone,
    items: d.items.flatMap((it): PostSnapshot['days'][number]['items'] => {
      if (it.type === 'activity') {
        if (it.placeId && home.has(it.placeId)) return [];
        if (it.placeId) referenced.add(it.placeId);
        return [PublicActivity.parse(it)];
      }
      if (home.has(it.fromPlaceId) || home.has(it.toPlaceId)) return [];
      referenced.add(it.fromPlaceId);
      referenced.add(it.toPlaceId);
      return [it];
    }),
  }));
  const snapshot = PostSnapshot.parse({
    schemaVersion: trip.schemaVersion,
    title: trip.title,
    constraints: PublicTripConstraints.parse(c),
    days,
    places: trip.places.filter(p => referenced.has(p.placeId)),
    redactionVersion: 1,
  });
  return { snapshot, redactedFields: [...removed] };
}

export function createMockSocialApi(options: MockSocialOptions = {}): SocialApi {
  const scenario = options.scenario ?? 'normal';
  const delayMs = options.delayMs ?? (scenario === 'slow' ? 800 : 0);
  const now = options.now ?? (() => new Date());
  const origin = options.origin ?? (typeof location !== 'undefined' ? location.origin : 'http://127.0.0.1:5173');
  const source = 'mock' as const;

  let viewer: SessionUser | null =
    options.initialUser === null ? null : MOCK_USERS[options.initialUser ?? 'demo-a'] ?? null;
  const trips = new Map<string, Trip>();
  const posts = new Map<string, PostRecord>();
  const follows = new Map<string, Set<string>>();
  const likes = new Map<string, Set<string>>();
  const images = new Map<string, ImageRecord>();
  const previews = new Map<string, PreviewRecord>();
  const groups = new Map<string, GroupRecord>();
  const invites = new Map<string, InviteRecord>();
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}_${(counter += 1)}`;
  const token = (prefix: string) => `${prefix}_${(counter += 1)}_${Math.random().toString(36).slice(2, 12).padEnd(10, '0')}xxxxxxxx`;

  const nameOf = (userId: string) => Object.values(MOCK_USERS).find(u => u.userId === userId)?.displayName ?? userId;
  const knownUser = (userId: string) => Object.values(MOCK_USERS).some(u => u.userId === userId);
  const authorOf = (userId: string): PostAuthor => ({
    userId,
    displayName: nameOf(userId),
    avatarInitial: [...nameOf(userId)][0] ?? '?',
    avatarColor: colorOf(userId),
  });
  const imageUrl = (id: string) => `/api/v1/post-images/${id}`;
  const followingOf = (userId: string) => follows.get(userId) ?? new Set<string>();
  const followerCount = (userId: string) => [...follows.values()].filter(f => f.has(userId)).length;
  const profileOf = (userId: string, viewerId: string): z.infer<typeof UserProfile> => ({
    user: authorOf(userId),
    followerCount: followerCount(userId),
    followingCount: followingOf(userId).size,
    followedByMe: followingOf(viewerId).has(userId),
    isMe: userId === viewerId,
  });

  function seed(): void {
    if (scenario === 'empty') return;
    for (const t of structuredClone(fixtureTrips)) trips.set(t.tripId, { ...t, ownerId: 'fx_user_a' });
    groups.set('fx_group_1', {
      group: { groupId: 'fx_group_1', name: '金沢旅行の仲間（モック）', createdAt: '2026-10-20T00:00:00Z' },
      members: new Map([['fx_user_a', 'owner']]),
    });
    const add = (postId: string, ownerId: string, trip: Trip, visibility: Visibility, groupId: string | null, story: string, createdAt: string, imageCount = 0) => {
      const imageIds: string[] = [];
      for (let i = 0; i < imageCount; i += 1) {
        const id = `${postId}_img${i + 1}`;
        images.set(id, { ownerId, attachedTo: postId });
        registerImageSource(imageUrl(id), placeholderSvg(`写真 ${i + 1}（モック）`, AVATAR_COLORS[(i + postId.length) % AVATAR_COLORS.length]!));
        imageIds.push(id);
      }
      const { snapshot } = mockSnapshot(trip);
      posts.set(postId, {
        ownerId,
        deleted: false,
        imageIds,
        updatedAt: null,
        post: Post.parse({
          postId,
          postRevision: 1,
          authorDisplayName: nameOf(ownerId),
          title: trip.title,
          story,
          visibility,
          groupId,
          area: trip.constraints.area,
          startDate: trip.constraints.startDate,
          createdAt,
          snapshot,
        }),
      });
    };
    add('fx_post_1', 'fx_user_a', domesticTrip, 'public', null, '金沢の旅行記録（モック）', '2026-10-24T00:00:00Z', 2);
    add('fx_post_2', 'fx_user_b', overseasTrip, 'public', null, 'パリの旅行記録（モック）', '2026-10-24T01:00:00Z', 1);
    add('fx_post_private', 'fx_user_a', domesticTrip, 'private', null, 'Aだけが見られる下書きメモ（モック）', '2026-10-24T02:00:00Z');
    follows.set('fx_user_a', new Set(['fx_user_b']));
    follows.set('fx_user_b', new Set(['fx_user_a']));
    likes.set('fx_post_1', new Set(['fx_user_b']));
    add('fx_post_group', 'fx_user_a', domesticTrip, 'group', 'fx_group_1', 'グループ内だけの記録（モック）', '2026-10-24T03:00:00Z');
  }
  seed();

  const pause = () => (delayMs > 0 ? new Promise<void>(r => setTimeout(r, delayMs)) : Promise.resolve());
  const ok = <T>(schema: z.ZodType<T>, data: unknown, status = 200): SocialResult<T> => ({
    ok: true,
    data: schema.parse(data),
    status,
    source,
  });
  const empty = (status = 204): SocialResult<null> => ({ ok: true, data: null, status, source });
  const fail = <T>(code: ErrorCode, message: string, retryable = false): SocialResult<T> => {
    const error: ApiError = { code, message, retryable, requestId: nextId('mock_req') };
    return { ok: false, error, status: ERROR_HTTP_STATUS[code], source };
  };
  const notFound = <T>() => fail<T>('NOT_FOUND', 'Not found.');
  const invalid = <T>() => fail<T>('VALIDATION_FAILED', 'Invalid request.');
  const unauth = <T>() => fail<T>('UNAUTHENTICATED', 'Authentication required.');

  /** Runs `body` after the delay; 'error' turns every call into 503. */
  async function call<T>(body: () => SocialResult<T>): Promise<SocialResult<T>> {
    await pause();
    if (scenario === 'error') return fail('UNAVAILABLE', 'Mock scenario: server unavailable.', true);
    return body();
  }

  const isMember = (groupId: string, userId: string) => groups.get(groupId)?.members.has(userId) ?? false;
  /** The ACL, applied before anything is returned (K14). */
  function visible(r: PostRecord, viewerId: string | null): boolean {
    if (r.deleted) return false;
    if (r.post.visibility === 'public') return true;
    if (!viewerId) return false;
    if (r.ownerId === viewerId) return true;
    return r.post.visibility === 'group' && r.post.groupId !== null && isMember(r.post.groupId, viewerId);
  }
  /** The post as the viewer sees it: author, isMine, likes and images are filled in per viewer, like the server's SELECT. */
  const present = (r: PostRecord, viewerId: string | null): Post => {
    const liked = likes.get(r.post.postId) ?? new Set<string>();
    return Post.parse({
      ...r.post,
      author: authorOf(r.ownerId),
      isMine: viewerId !== null && r.ownerId === viewerId,
      likeCount: liked.size,
      likedByMe: viewerId !== null && liked.has(viewerId),
      images: r.imageIds.map(id => PostImage.parse({ imageId: id, url: imageUrl(id), width: null, height: null })),
      updatedAt: r.updatedAt,
    });
  };
  const summary = (p: Post): PostSummary => {
    const { snapshot: _snapshot, ...rest } = p;
    return rest;
  };

  return {
    source,
    me: () => call(() => (viewer ? { ok: true, data: viewer, status: 200, source } : unauth())),
    login: (loginId, password) =>
      call(() => {
        const user = MOCK_USERS[loginId.trim().toLowerCase()];
        if (!user || password === '') return fail('UNAUTHENTICATED', 'Invalid loginId or password.');
        viewer = user;
        return { ok: true, data: user, status: 200, source };
      }),
    logout: () =>
      call(() => {
        if (!viewer) return unauth();
        viewer = null;
        return empty();
      }),
    listMyTrips: () =>
      call(() => {
        if (!viewer) return unauth();
        const me = viewer.userId;
        const items = [...trips.values()]
          .filter(t => t.ownerId === me)
          .map(t => ({
            tripId: t.tripId,
            title: t.title,
            revision: t.revision,
            validationState: t.validationState,
            updatedAt: t.updatedAt,
            area: t.constraints.area,
            startDate: t.constraints.startDate,
            endDate: t.constraints.endDate,
          }));
        return ok(TripList, { items, nextCursor: null });
      }),
    getTrip: tripId =>
      call(() => {
        if (!viewer) return unauth();
        const t = trips.get(tripId);
        return t && t.ownerId === viewer.userId ? ok(Trip, t) : notFound();
      }),
    previewPost: req =>
      call(() => {
        if (!viewer) return unauth();
        const body = PostPreviewRequest.safeParse(req);
        if (!body.success) return invalid();
        const b = body.data;
        const trip = trips.get(b.tripId);
        if (!trip || trip.ownerId !== viewer.userId) return notFound();
        if (b.visibility === 'group' && !isMember(b.groupId!, viewer.userId)) return invalid();
        if (trip.revision !== b.sourceRevision) return fail('REVISION_CONFLICT', 'Trip was updated.');
        const imageIds = b.imageIds ?? [];
        if (new Set(imageIds).size !== imageIds.length) return invalid();
        for (const id of imageIds) {
          const img = images.get(id);
          if (!img || img.ownerId !== viewer.userId || img.attachedTo !== null) return invalid();
        }
        const { snapshot, redactedFields } = mockSnapshot(trip);
        const previewToken = token('mock_preview');
        const expiresAt = now().getTime() + PREVIEW_TTL_MS;
        previews.set(previewToken, {
          ownerId: viewer.userId,
          tripId: trip.tripId,
          sourceRevision: trip.revision,
          visibility: b.visibility,
          groupId: b.visibility === 'group' ? b.groupId! : null,
          story: b.story,
          imageIds,
          snapshot,
          expiresAt,
          used: false,
        });
        return ok(PostPreview, { previewToken, snapshot, redactedFields, expiresAt: iso(new Date(expiresAt)) });
      }),
    createPost: previewToken =>
      call(() => {
        if (!viewer) return unauth();
        const p = previews.get(previewToken);
        if (!p || p.ownerId !== viewer.userId) return notFound();
        if (p.used) return fail('ALREADY_COMMITTED', 'Preview already used.');
        if (now().getTime() > p.expiresAt) return fail('EXPIRED', 'Preview expired.');
        const trip = trips.get(p.tripId);
        if (!trip || trip.revision !== p.sourceRevision) return fail('REVISION_CONFLICT', 'Trip was updated.');
        if (p.groupId && !isMember(p.groupId, viewer.userId)) return notFound();
        for (const id of p.imageIds) if (images.get(id)?.attachedTo) return invalid();
        p.used = true;
        const post = Post.parse({
          postId: nextId('mock_post'),
          postRevision: 1,
          authorDisplayName: viewer.displayName,
          title: p.snapshot.title,
          story: p.story,
          visibility: p.visibility,
          groupId: p.groupId,
          area: p.snapshot.constraints.area,
          startDate: p.snapshot.constraints.startDate,
          createdAt: iso(now()),
          snapshot: p.snapshot,
        });
        for (const id of p.imageIds) images.get(id)!.attachedTo = post.postId;
        const record: PostRecord = { post, ownerId: viewer.userId, deleted: false, imageIds: p.imageIds, updatedAt: null };
        posts.set(post.postId, record);
        return ok(Post, present(record, viewer.userId), 201);
      }),
    getFeed: (scope, cursor, limit = 20) =>
      call(() => {
        const q = FeedQuery.safeParse({ scope, limit, ...(cursor ? { cursor } : {}) });
        if (!q.success) return invalid();
        if (q.data.scope !== 'public' && !viewer) return unauth();
        const me = viewer?.userId ?? null;
        let offset = 0;
        if (q.data.cursor !== undefined) {
          if (!/^\d+$/.test(q.data.cursor)) return invalid();
          offset = Number(q.data.cursor);
        }
        const pool = [...posts.values()]
          .filter(r => visible(r, me))
          .filter(r =>
            q.data.scope === 'public'
              ? r.post.visibility === 'public'
              : q.data.scope === 'mine'
                ? r.ownerId === me
                : q.data.scope === 'following'
                  ? r.ownerId !== me && followingOf(me!).has(r.ownerId) && r.post.visibility !== 'private'
                  : r.post.visibility === 'group',
          )
          .map(r => present(r, me))
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.postId < b.postId ? 1 : -1));
        const page = pool.slice(offset, offset + q.data.limit).map(summary);
        const nextCursor = offset + q.data.limit < pool.length ? String(offset + q.data.limit) : null;
        return ok(Feed, { items: page, nextCursor });
      }),
    getPost: postId =>
      call(() => {
        const r = posts.get(postId);
        return r && visible(r, viewer?.userId ?? null) ? ok(Post, present(r, viewer?.userId ?? null)) : notFound();
      }),
    changeVisibility: (postId, expectedPostRevision, visibility, groupId) =>
      call(() => {
        if (!viewer) return unauth();
        const r = posts.get(postId);
        if (!r || r.deleted || r.ownerId !== viewer.userId) return notFound();
        if ((visibility === 'group') !== Boolean(groupId)) return invalid();
        if (r.post.postRevision !== expectedPostRevision) return fail('REVISION_CONFLICT', 'Post was updated.');
        if (visibility === 'group' && !isMember(groupId!, viewer.userId)) return invalid();
        r.post = Post.parse({
          ...r.post,
          visibility,
          groupId: visibility === 'group' ? groupId : null,
          postRevision: r.post.postRevision + 1,
        });
        r.updatedAt = iso(now());
        return ok(Post, present(r, viewer.userId));
      }),
    editStory: (postId, expectedPostRevision, story) =>
      call(() => {
        if (!viewer) return unauth();
        const r = posts.get(postId);
        if (!r || r.deleted || r.ownerId !== viewer.userId) return notFound();
        if (story.length > 5000) return invalid();
        if (r.post.postRevision !== expectedPostRevision) return fail('REVISION_CONFLICT', 'Post was updated.');
        r.post = Post.parse({ ...r.post, story, postRevision: r.post.postRevision + 1 });
        r.updatedAt = iso(now());
        return ok(Post, present(r, viewer.userId));
      }),
    setLike: (postId, like) =>
      call(() => {
        if (!viewer) return unauth();
        const r = posts.get(postId);
        if (!r || !visible(r, viewer.userId)) return notFound();
        const set = likes.get(postId) ?? new Set<string>();
        if (like) set.add(viewer.userId);
        else set.delete(viewer.userId);
        likes.set(postId, set);
        return ok(LikeState, { postId, likeCount: set.size, likedByMe: set.has(viewer.userId) });
      }),
    getMyProfile: () => call(() => (viewer ? ok(UserProfile, profileOf(viewer.userId, viewer.userId)) : unauth())),
    getUserProfile: userId =>
      call(() => {
        if (!viewer) return unauth();
        return knownUser(userId) ? ok(UserProfile, profileOf(userId, viewer.userId)) : notFound();
      }),
    setFollow: (userId, follow) =>
      call(() => {
        if (!viewer) return unauth();
        if (userId === viewer.userId) return invalid();
        if (!knownUser(userId)) return notFound();
        const set = follows.get(viewer.userId) ?? new Set<string>();
        if (follow) set.add(userId);
        else set.delete(userId);
        follows.set(viewer.userId, set);
        return ok(UserProfile, profileOf(userId, viewer.userId));
      }),
    uploadImage: file =>
      call(() => {
        if (!viewer) return unauth();
        if (validateImageFile(file, 0) !== null) return invalid();
        const mine = [...images.values()].filter(i => i.ownerId === viewer!.userId && i.attachedTo === null).length;
        if (mine >= 20) return fail('RATE_LIMITED', 'Too many unused images.');
        const id = nextId('mock_img');
        images.set(id, { ownerId: viewer.userId, attachedTo: null });
        const url = imageUrl(id);
        const canObjectUrl = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
        registerImageSource(url, canObjectUrl ? URL.createObjectURL(file) : placeholderSvg('アップロード画像（モック）', '#4a5568'));
        return ok(PostImage, { imageId: id, url, width: null, height: null }, 201);
      }),
    deletePost: postId =>
      call(() => {
        if (!viewer) return unauth();
        const r = posts.get(postId);
        if (!r || r.deleted || r.ownerId !== viewer.userId) return notFound();
        r.deleted = true;
        return empty();
      }),
    copyPost: (postId, req) =>
      call(() => {
        if (!viewer) return unauth();
        const r = posts.get(postId);
        if (!r || !visible(r, viewer.userId)) return notFound();
        const body = CopyRequest.safeParse(req);
        if (!body.success) return invalid();
        const s = r.post.snapshot;
        const start = body.data.newStartDate;
        const addDays = (n: number) => {
          const d = new Date(`${start}T00:00:00Z`);
          d.setUTCDate(d.getUTCDate() + n);
          return d.toISOString().slice(0, 10);
        };
        const known = new Set(s.places.map(p => p.placeId));
        const stamp = iso(now());
        const trip = Trip.parse({
          schemaVersion: s.schemaVersion,
          tripId: nextId('mock_trip_copy'),
          ownerId: viewer.userId,
          title: body.data.title ?? `${s.title}（コピー）`.slice(0, 200),
          revision: 1,
          constraints: {
            area: s.constraints.area,
            startDate: start,
            endDate: addDays(Math.max(s.days.length, 1) - 1),
            timeZone: body.data.timeZone,
            transportMode: s.constraints.transportMode,
          },
          days: s.days.map((d, i) => ({
            date: addDays(i),
            timeZone: body.data.timeZone,
            items: d.items.flatMap((it): unknown[] =>
              it.type === 'activity'
                ? [{ ...it, activityId: nextId('act'), start: null, end: null, fixed: false, cost: null, costStatus: 'unknown', status: 'planned', privateNotes: null }]
                : known.has(it.fromPlaceId) && known.has(it.toPlaceId)
                  ? [{ ...it, legId: nextId('leg'), departure: null, arrival: null, durationSeconds: null, lineName: null, platform: null, transfers: null, fare: null, dataStatus: 'unknown', provenance: null }]
                  : [],
            ),
          })),
          places: s.places,
          validationState: 'needs_revalidation',
          warnings: [
            '他の人の投稿からコピーした旅程です。新しい日付で再検証が必要です。',
            '時刻・運賃・乗換は引き継いでいません。費用・営業時間・交通は新しい日付で再確認してください。',
          ],
          createdAt: stamp,
          updatedAt: stamp,
        });
        trips.set(trip.tripId, trip);
        return ok(CopyResult, { tripId: trip.tripId, ownerId: trip.ownerId, revision: 1, validationState: trip.validationState }, 201);
      }),
    listGroups: () =>
      call(() => {
        if (!viewer) return unauth();
        const me = viewer.userId;
        const list = [...groups.values()]
          .filter(g => g.members.has(me))
          .map(g => ({ ...g.group, role: g.members.get(me)! }));
        return ok(GroupList, list);
      }),
    createGroup: name =>
      call(() => {
        if (!viewer) return unauth();
        const trimmed = name.trim();
        if (trimmed === '' || trimmed.length > 100) return invalid();
        const groupId = nextId('mock_group');
        groups.set(groupId, { group: { groupId, name: trimmed, createdAt: iso(now()) }, members: new Map([[viewer.userId, 'owner']]) });
        return ok(Group, { groupId, name: trimmed, role: 'owner', createdAt: iso(now()) }, 201);
      }),
    createInvite: groupId =>
      call(() => {
        if (!viewer) return unauth();
        const g = groups.get(groupId);
        const role = g?.members.get(viewer.userId);
        if (!role) return notFound();
        if (role === 'member') return fail('FORBIDDEN', 'Forbidden.');
        const t = token('mock_invite');
        const expiresAt = now().getTime() + INVITE_TTL_MS;
        invites.set(t, { groupId, expiresAt, used: false });
        return ok(GroupInviteCreated, { inviteUrl: `${origin}/invite#${t}`, expiresAt: iso(new Date(expiresAt)) }, 201);
      }),
    acceptInvite: t =>
      call(() => {
        if (!viewer) return unauth();
        const inv = invites.get(t);
        const g = groups.get(inv?.groupId ?? '');
        if (!inv || !g) return notFound();
        if (inv.used) return fail('ALREADY_COMMITTED', 'Invite cannot be used.');
        if (now().getTime() >= inv.expiresAt) return fail('EXPIRED', 'Invite expired.');
        if (g.members.has(viewer.userId)) return fail('ALREADY_COMMITTED', 'Invite cannot be used.');
        inv.used = true;
        g.members.set(viewer.userId, 'member');
        return ok(Membership, { groupId: inv.groupId, userId: viewer.userId, membership: 'active' });
      }),
    leaveGroup: (groupId, userId) =>
      call(() => {
        if (!viewer) return unauth();
        const g = groups.get(groupId);
        const role = g?.members.get(viewer.userId);
        if (!g || !role) return notFound();
        if (userId !== viewer.userId) return fail('FORBIDDEN', 'Forbidden.');
        if (role === 'owner') return fail('FORBIDDEN', 'Forbidden.');
        g.members.delete(userId);
        return empty();
      }),
  };
}
