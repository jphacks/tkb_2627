/**
 * U08: screen-facing client for K11 (login), K09 (my trips, read only) and the SNS contracts K12-K17.
 *
 * Two implementations share this interface:
 * - createHttpSocialApi: the shared server through the vite proxy (`/api` -> 127.0.0.1:4310).
 *   Every success body is parsed with the @tkb/contracts schema; a mismatch becomes an error result,
 *   never a cast. Writes send the CSRF token (`x-csrf-token`) that login / me returned. The token is
 *   kept in memory only (no browser storage). Requests use `cache: 'no-store'`.
 * - createMockSocialApi (mockSocialApi.ts): in-memory, for reviewing the screens without a server.
 */
import {
  ApiError,
  CopyRequest,
  CopyResult,
  Feed,
  FeedQuery,
  Group,
  GroupCreateRequest,
  GroupInviteAccept,
  GroupInviteCreated,
  Id,
  LoginRequest,
  LikeState,
  LoginResponse,
  Membership,
  POST_IMAGE_MAX_BYTES,
  POST_IMAGE_TYPES,
  Post,
  PostCreateRequest,
  PostImage,
  PostPatchRequest,
  PostPreview,
  PostPreviewRequest,
  Trip,
  TripList,
  UserProfile,
  type ErrorCode,
  type Visibility,
} from '@tkb/contracts';
import type { z } from 'zod';

export type DataSource = 'mock' | 'server';

export type SocialResult<T> =
  | { ok: true; data: T; status: number; source: DataSource }
  | { ok: false; error: ApiError; status: number; source: DataSource };

export interface SessionUser {
  userId: string;
  displayName: string;
}

export type FeedScope = FeedQuery['scope'];

export interface SocialApi {
  readonly source: DataSource;
  /** K11 GET /api/v1/auth/me: restores the session from the cookie (401 when logged out). */
  me(): Promise<SocialResult<SessionUser>>;
  /** K11 POST /api/v1/auth/login */
  login(loginId: string, password: string): Promise<SocialResult<SessionUser>>;
  /** POST /api/v1/auth/logout (204) */
  logout(): Promise<SocialResult<null>>;
  /** K09 GET /api/v1/trips (first page, read only): the trips the user can post. */
  listMyTrips(): Promise<SocialResult<TripList>>;
  /** K09 GET /api/v1/trips/{id}: used to show a copied trip. */
  getTrip(tripId: string): Promise<SocialResult<Trip>>;
  /** K12 POST /api/v1/posts/preview */
  previewPost(req: z.input<typeof PostPreviewRequest>): Promise<SocialResult<PostPreview>>;
  /** K13 POST /api/v1/posts with confirmed: true */
  createPost(previewToken: string): Promise<SocialResult<Post>>;
  /** K14 GET /api/v1/posts */
  getFeed(scope: FeedScope, cursor?: string | null, limit?: number): Promise<SocialResult<Feed>>;
  /** K14 GET /api/v1/posts/{id} */
  getPost(postId: string): Promise<SocialResult<Post>>;
  /** K15 PATCH /api/v1/posts/{id}: visibility change (公開解除 = private). */
  changeVisibility(postId: string, expectedPostRevision: number, visibility: Visibility, groupId: string | null): Promise<SocialResult<Post>>;
  /** K15 DELETE /api/v1/posts/{id} (204): 取り下げ. */
  deletePost(postId: string): Promise<SocialResult<null>>;
  /** K15 PATCH /api/v1/posts/{id}: edit the story (own posts only). */
  editStory(postId: string, expectedPostRevision: number, story: string): Promise<SocialResult<Post>>;
  /** S07 PUT|DELETE /api/v1/posts/{id}/like (idempotent). */
  setLike(postId: string, like: boolean): Promise<SocialResult<LikeState>>;
  /** S07 GET /api/v1/me/profile: own counts. */
  getMyProfile(): Promise<SocialResult<UserProfile>>;
  /** S07 GET /api/v1/users/{id}/profile */
  getUserProfile(userId: string): Promise<SocialResult<UserProfile>>;
  /** S07 PUT|DELETE /api/v1/users/{id}/follow (idempotent); returns the followed user's profile. */
  setFollow(userId: string, follow: boolean): Promise<SocialResult<UserProfile>>;
  /** S07 POST /api/v1/post-images: raw body, Content-Type = the file type. Validate with validateImageFile first. */
  uploadImage(file: Blob): Promise<SocialResult<PostImage>>;
  /** K16 POST /api/v1/posts/{id}/copy */
  copyPost(postId: string, req: z.input<typeof CopyRequest>): Promise<SocialResult<CopyResult>>;
  /** K17 GET /api/v1/groups */
  listGroups(): Promise<SocialResult<Group[]>>;
  /** K17 POST /api/v1/groups */
  createGroup(name: string): Promise<SocialResult<Group>>;
  /** K17 POST /api/v1/groups/{id}/invites (open invite link) */
  createInvite(groupId: string): Promise<SocialResult<z.infer<typeof GroupInviteCreated>>>;
  /** K17 POST /api/v1/group-invites/accept */
  acceptInvite(token: string): Promise<SocialResult<Membership>>;
  /** K17 DELETE /api/v1/groups/{id}/members/{userId} with the own userId: leave a group. */
  leaveGroup(groupId: string, userId: string): Promise<SocialResult<null>>;
}

export const GroupList = Group.array();

export const MAX_POST_IMAGES = 4;

/** Client-side image check (the server checks again). Returns a Japanese message, or null when the file is acceptable. */
export function validateImageFile(file: { type: string; size: number; name?: string }, alreadyAttached: number): string | null {
  const label = file.name ? `「${file.name}」` : 'この画像';
  if (alreadyAttached >= MAX_POST_IMAGES) return `画像は${MAX_POST_IMAGES}枚までです。`;
  if (!(POST_IMAGE_TYPES as readonly string[]).includes(file.type)) return `${label}は使えない形式です（JPEG・PNG・WebPのみ）。`;
  if (file.size <= 0) return `${label}は空のファイルです。`;
  if (file.size > POST_IMAGE_MAX_BYTES) return `${label}が大きすぎます（5MBまで）。`;
  return null;
}

/**
 * Mock mode serves images from memory, so an image `url` can be mapped to a displayable source (data URI / object URL).
 * With the shared server the url is used as it is.
 */
const imageSources = new Map<string, string>();
export const registerImageSource = (url: string, src: string): void => void imageSources.set(url, src);
export const imageSrc = (url: string): string => imageSources.get(url) ?? url;

/** Shown when a response does not match the shared contract. */
export const CONTRACT_MISMATCH = '応答が共通の契約（schema）と一致しません。';

export function clientError(code: ErrorCode, message: string, requestId: string, retryable = false): ApiError {
  return { code, message, retryable, requestId };
}

/** Error code used when the server's error body itself cannot be read. */
export function codeForStatus(status: number): ErrorCode {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'REVISION_CONFLICT';
  if (status === 410) return 'EXPIRED';
  if (status === 422) return 'VALIDATION_FAILED';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 503 || status === 502 || status === 504) return 'UNAVAILABLE';
  return 'INTERNAL';
}

/**
 * Invite token from an invite URL (`.../invite#<token>`), a bare `#<token>` or the token itself.
 * Returns null unless it satisfies the K17 accept schema.
 */
export function inviteTokenFrom(input: string): string | null {
  const text = input.trim();
  const hash = text.indexOf('#');
  const token = hash >= 0 ? text.slice(hash + 1) : text;
  return GroupInviteAccept.safeParse({ token }).success && /^[A-Za-z0-9_-]+$/.test(token) ? token : null;
}

export const CSRF_HEADER = 'x-csrf-token';

export interface HttpSocialApiOptions {
  /** Prefix for every path. Default '' (same origin, the vite proxy forwards /api). */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export function createHttpSocialApi(options: HttpSocialApiOptions = {}): SocialApi {
  const base = options.baseUrl ?? '';
  const doFetch = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  /** CSRF token of the current session, memory only. */
  let csrf: string | null = null;
  const source = 'server' as const;

  const fail = <T>(error: ApiError, status: number): SocialResult<T> => ({ ok: false, error, status, source });
  const invalidInput = <T>(): SocialResult<T> =>
    fail(clientError('VALIDATION_FAILED', '入力内容が契約の形式に合いません。', 'client_validation'), 0);

  async function request<T>(method: string, path: string, schema: z.ZodType<T> | null, body?: unknown, raw?: Blob): Promise<SocialResult<T>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (raw) headers['content-type'] = raw.type;
    if (method !== 'GET' && csrf) headers[CSRF_HEADER] = csrf;
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        ...(raw ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      return fail(clientError('UNAVAILABLE', 'サーバーに接続できません。', 'client_network', true), 0);
    }
    if (!res.ok) {
      if (res.status === 401) csrf = null;
      let parsed: ApiError | null = null;
      try {
        const e = ApiError.safeParse(await res.json());
        if (e.success) parsed = e.data;
      } catch {
        parsed = null;
      }
      return fail(parsed ?? clientError(codeForStatus(res.status), `HTTP ${res.status}`, 'client_http', res.status >= 500), res.status);
    }
    if (schema === null) return { ok: true, data: null as T, status: res.status, source };
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return fail(clientError('INTERNAL', CONTRACT_MISMATCH, 'client_contract'), res.status);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) return fail(clientError('INTERNAL', CONTRACT_MISMATCH, 'client_contract'), res.status);
    return { ok: true, data: parsed.data, status: res.status, source };
  }

  const idPath = (id: string): string | null => (Id.safeParse(id).success ? encodeURIComponent(id) : null);

  async function session(r: Promise<SocialResult<LoginResponse>>): Promise<SocialResult<SessionUser>> {
    const result = await r;
    if (!result.ok) return result;
    csrf = result.data.csrfToken;
    return { ...result, data: { userId: result.data.userId, displayName: result.data.displayName } };
  }

  return {
    source,
    me: () => session(request('GET', '/api/v1/auth/me', LoginResponse)),
    login(loginId, password) {
      const body = LoginRequest.safeParse({ loginId, password });
      if (!body.success) return Promise.resolve(invalidInput());
      return session(request('POST', '/api/v1/auth/login', LoginResponse, body.data));
    },
    async logout() {
      const r = await request<null>('POST', '/api/v1/auth/logout', null);
      csrf = null;
      return r;
    },
    listMyTrips: () => request('GET', '/api/v1/trips?limit=20', TripList),
    getTrip(tripId) {
      const id = idPath(tripId);
      return id ? request('GET', `/api/v1/trips/${id}`, Trip) : Promise.resolve(invalidInput());
    },
    previewPost(req) {
      const body = PostPreviewRequest.safeParse(req);
      if (!body.success) return Promise.resolve(invalidInput());
      return request('POST', '/api/v1/posts/preview', PostPreview, body.data);
    },
    createPost(previewToken) {
      const body = PostCreateRequest.safeParse({ previewToken, confirmed: true });
      if (!body.success) return Promise.resolve(invalidInput());
      return request('POST', '/api/v1/posts', Post, body.data);
    },
    getFeed(scope, cursor, limit = 20) {
      const q = FeedQuery.safeParse({ scope, limit, ...(cursor ? { cursor } : {}) });
      if (!q.success) return Promise.resolve(invalidInput());
      const params = new URLSearchParams({ scope: q.data.scope, limit: String(q.data.limit) });
      if (q.data.cursor) params.set('cursor', q.data.cursor);
      return request('GET', `/api/v1/posts?${params.toString()}`, Feed);
    },
    getPost(postId) {
      const id = idPath(postId);
      return id ? request('GET', `/api/v1/posts/${id}`, Post) : Promise.resolve(invalidInput());
    },
    changeVisibility(postId, expectedPostRevision, visibility, groupId) {
      const id = idPath(postId);
      const body = PostPatchRequest.safeParse({ expectedPostRevision, visibility, groupId: visibility === 'group' ? groupId : null });
      if (!id || !body.success) return Promise.resolve(invalidInput());
      return request('PATCH', `/api/v1/posts/${id}`, Post, body.data);
    },
    deletePost(postId) {
      const id = idPath(postId);
      return id ? request<null>('DELETE', `/api/v1/posts/${id}`, null) : Promise.resolve(invalidInput());
    },
    editStory(postId, expectedPostRevision, story) {
      const id = idPath(postId);
      const body = PostPatchRequest.safeParse({ expectedPostRevision, story });
      if (!id || !body.success) return Promise.resolve(invalidInput());
      return request('PATCH', `/api/v1/posts/${id}`, Post, body.data);
    },
    setLike(postId, like) {
      const id = idPath(postId);
      return id ? request(like ? 'PUT' : 'DELETE', `/api/v1/posts/${id}/like`, LikeState) : Promise.resolve(invalidInput());
    },
    getMyProfile: () => request('GET', '/api/v1/me/profile', UserProfile),
    getUserProfile(userId) {
      const id = idPath(userId);
      return id ? request('GET', `/api/v1/users/${id}/profile`, UserProfile) : Promise.resolve(invalidInput());
    },
    setFollow(userId, follow) {
      const id = idPath(userId);
      return id ? request(follow ? 'PUT' : 'DELETE', `/api/v1/users/${id}/follow`, UserProfile) : Promise.resolve(invalidInput());
    },
    uploadImage(file) {
      if (validateImageFile(file, 0) !== null) return Promise.resolve(invalidInput());
      return request('POST', '/api/v1/post-images', PostImage, undefined, file);
    },
    copyPost(postId, req) {
      const id = idPath(postId);
      const body = CopyRequest.safeParse(req);
      if (!id || !body.success) return Promise.resolve(invalidInput());
      return request('POST', `/api/v1/posts/${id}/copy`, CopyResult, body.data);
    },
    listGroups: () => request('GET', '/api/v1/groups', GroupList),
    createGroup(name) {
      const body = GroupCreateRequest.safeParse({ name });
      if (!body.success) return Promise.resolve(invalidInput());
      return request('POST', '/api/v1/groups', Group, body.data);
    },
    createInvite(groupId) {
      const id = idPath(groupId);
      return id ? request('POST', `/api/v1/groups/${id}/invites`, GroupInviteCreated, {}) : Promise.resolve(invalidInput());
    },
    acceptInvite(token) {
      const body = GroupInviteAccept.safeParse({ token });
      if (!body.success) return Promise.resolve(invalidInput());
      return request('POST', '/api/v1/group-invites/accept', Membership, body.data);
    },
    leaveGroup(groupId, userId) {
      const g = idPath(groupId);
      const u = idPath(userId);
      return g && u ? request<null>('DELETE', `/api/v1/groups/${g}/members/${u}`, null) : Promise.resolve(invalidInput());
    },
  };
}
