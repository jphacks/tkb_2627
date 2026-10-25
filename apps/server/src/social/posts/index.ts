import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  ApiError,
  ERROR_HTTP_STATUS,
  Feed,
  FeedQuery,
  Id,
  Post,
  PostCreateRequest,
  PostPatchRequest,
  PostPreview,
  PostPreviewRequest,
  PostSummary,
  type ErrorCode,
} from '@tkb/contracts';
import {
  PREVIEW_TTL_MS,
  createPostFromPreview,
  decodeCursor,
  deletePost,
  getPostForViewer,
  getTripForOwner,
  hashPreviewToken,
  insertPreview,
  isActiveMember,
  listFeed,
  patchPost,
  type Db,
  type PostRecord,
} from '@tkb/db';
import { optionalActor, requireActor } from '../../platform/auth/index.ts';
import { buildSnapshot } from './snapshot.ts';

function fail(reply: FastifyReply, requestId: string, code: ErrorCode, message: string, retryable = false) {
  return reply.status(ERROR_HTTP_STATUS[code]).send(ApiError.parse({ code, message, retryable, requestId }));
}
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const notFound = (reply: FastifyReply, id: string) => fail(reply, id, 'NOT_FOUND', 'Not found.');
const invalid = (reply: FastifyReply, id: string) => fail(reply, id, 'VALIDATION_FAILED', 'Invalid request.');

const detail = (r: PostRecord) => Post.parse(r);

/** K12-K15. ACL lives in the SQL (packages/db posts.ts); membership is read from the DB on every request. */
export function registerPosts(app: FastifyInstance, db: Db): void {
  const authed = { preHandler: app.authenticate };
  const open = { preHandler: app.optionalAuthenticate };

  // Responses depend on the session and on live membership, so they must never be cached.
  app.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/api/v1/posts')) reply.header('cache-control', 'no-store');
  });

  app.post('/api/v1/posts/preview', authed, async (req, reply) => {
    const { userId } = requireActor(req);
    const body = PostPreviewRequest.safeParse(req.body);
    if (!body.success) return invalid(reply, req.id);
    const b = body.data;
    const trip = getTripForOwner(db, b.tripId, userId);
    if (!trip) return notFound(reply, req.id);
    // A missing group and a group the user is not in look the same (422), so existence does not leak.
    if (b.visibility === 'group' && !isActiveMember(db, b.groupId!, userId)) return invalid(reply, req.id);
    if (trip.revision !== b.sourceRevision) return fail(reply, req.id, 'REVISION_CONFLICT', 'Trip was updated.');
    const { snapshot, redactedFields } = buildSnapshot(trip);
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    const expiresAt = iso(now + PREVIEW_TTL_MS);
    const stored = insertPreview(
      db,
      {
        tokenHash: hashPreviewToken(token),
        ownerId: userId,
        tripId: trip.tripId,
        sourceRevision: trip.revision,
        visibility: b.visibility,
        groupId: b.visibility === 'group' ? b.groupId! : null,
        story: b.story,
        snapshotJson: JSON.stringify(snapshot),
        expiresAt,
      },
      iso(now),
    );
    if (!stored) return fail(reply, req.id, 'RATE_LIMITED', 'Too many pending previews.', true);
    return PostPreview.parse({ previewToken: token, snapshot, redactedFields, expiresAt });
  });

  app.post('/api/v1/posts', authed, async (req, reply) => {
    const { userId } = requireActor(req);
    const body = PostCreateRequest.safeParse(req.body);
    if (!body.success) return invalid(reply, req.id);
    const r = createPostFromPreview(db, hashPreviewToken(body.data.previewToken), userId, iso(Date.now()));
    if (!r.ok) {
      if (r.code === 'NOT_FOUND') return notFound(reply, req.id);
      if (r.code === 'EXPIRED') return fail(reply, req.id, 'EXPIRED', 'Preview expired.');
      if (r.code === 'ALREADY_COMMITTED') return fail(reply, req.id, 'ALREADY_COMMITTED', 'Preview already used.');
      return fail(reply, req.id, 'REVISION_CONFLICT', 'Trip was updated.');
    }
    return reply.status(201).send(detail(r.post));
  });

  app.get('/api/v1/posts', open, async (req, reply) => {
    const actor = optionalActor(req);
    const q = FeedQuery.safeParse(req.query);
    if (!q.success) return invalid(reply, req.id);
    if (q.data.scope !== 'public' && !actor) return fail(reply, req.id, 'UNAUTHENTICATED', 'Authentication required.');
    // S07 (#187) implements the following feed; until then it is rejected rather than silently mis-served.
    if (q.data.scope === 'following') return invalid(reply, req.id);
    let cursor;
    if (q.data.cursor !== undefined) {
      cursor = decodeCursor(q.data.cursor);
      if (!cursor) return invalid(reply, req.id);
    }
    const page = listFeed(db, { scope: q.data.scope, viewerId: actor?.userId ?? null, cursor, limit: q.data.limit });
    // A summary that fails validation (e.g. a damaged snapshot) is skipped; the rest of the page is still served.
    const items = page.items.flatMap((i) => {
      const s = PostSummary.safeParse(i);
      return s.success ? [s.data] : [];
    });
    return Feed.parse({ items, nextCursor: page.nextCursor });
  });

  app.get('/api/v1/posts/:id', open, async (req, reply) => {
    const id = Id.safeParse((req.params as { id: string }).id);
    if (!id.success) return notFound(reply, req.id);
    const post = getPostForViewer(db, id.data, optionalActor(req)?.userId ?? null);
    if (!post) return notFound(reply, req.id);
    return detail(post);
  });

  app.patch('/api/v1/posts/:id', authed, async (req, reply) => {
    const { userId } = requireActor(req);
    const id = Id.safeParse((req.params as { id: string }).id);
    if (!id.success) return notFound(reply, req.id);
    const body = PostPatchRequest.safeParse(req.body);
    if (!body.success) return invalid(reply, req.id);
    const { expectedPostRevision, ...patch } = body.data;
    const r = patchPost(db, id.data, userId, expectedPostRevision, patch, iso(Date.now()));
    if (!r.ok) {
      if (r.code === 'NOT_FOUND') return notFound(reply, req.id);
      if (r.code === 'GROUP_INVALID') return invalid(reply, req.id);
      return fail(reply, req.id, 'REVISION_CONFLICT', 'Post was updated.');
    }
    return detail(r.post);
  });

  app.delete('/api/v1/posts/:id', authed, async (req, reply) => {
    const { userId } = requireActor(req);
    const id = Id.safeParse((req.params as { id: string }).id);
    if (!id.success || !deletePost(db, id.data, userId, iso(Date.now()))) return notFound(reply, req.id);
    return reply.status(204).send();
  });
}
