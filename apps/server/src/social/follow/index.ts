import type { FastifyInstance, FastifyReply } from 'fastify';
import { ApiError, ERROR_HTTP_STATUS, Id, LikeState, UserProfile, type ErrorCode } from '@tkb/contracts';
import { getProfile, setFollow, setLike, type Db } from '@tkb/db';
import { requireActor } from '../../platform/auth/index.ts';

function fail(reply: FastifyReply, requestId: string, code: ErrorCode, message: string) {
  return reply.status(ERROR_HTTP_STATUS[code]).send(ApiError.parse({ code, message, retryable: false, requestId }));
}
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

/** S07: likes, follows and profiles. Counts only; no liker or follower lists are exposed. */
export function registerFollowLike(app: FastifyInstance, db: Db): void {
  const authed = { preHandler: app.authenticate };

  app.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/api/v1/users/') || req.url.startsWith('/api/v1/me/') || /^\/api\/v1\/posts\/[^/]+\/like/.test(req.url)) {
      reply.header('cache-control', 'no-store');
    }
  });

  const likeHandler = (liked: boolean) => async (req: Parameters<typeof requireActor>[0], reply: FastifyReply) => {
    const { userId } = requireActor(req);
    const id = Id.safeParse((req.params as { id: string }).id);
    if (!id.success) return fail(reply, req.id, 'NOT_FOUND', 'Not found.');
    const state = setLike(db, id.data, userId, liked, nowIso());
    if (!state) return fail(reply, req.id, 'NOT_FOUND', 'Not found.');
    return LikeState.parse(state);
  };
  app.put('/api/v1/posts/:id/like', authed, likeHandler(true));
  app.delete('/api/v1/posts/:id/like', authed, likeHandler(false));

  const followHandler = (follow: boolean) => async (req: Parameters<typeof requireActor>[0], reply: FastifyReply) => {
    const { userId } = requireActor(req);
    const id = Id.safeParse((req.params as { id: string }).id);
    if (!id.success) return fail(reply, req.id, 'NOT_FOUND', 'Not found.');
    const r = setFollow(db, userId, id.data, follow, nowIso());
    if (r === 'SELF') return fail(reply, req.id, 'VALIDATION_FAILED', 'You cannot follow yourself.');
    if (r === 'NOT_FOUND') return fail(reply, req.id, 'NOT_FOUND', 'Not found.');
    return UserProfile.parse(getProfile(db, id.data, userId));
  };
  app.put('/api/v1/users/:id/follow', authed, followHandler(true));
  app.delete('/api/v1/users/:id/follow', authed, followHandler(false));

  app.get('/api/v1/users/:id/profile', authed, async (req, reply) => {
    const { userId } = requireActor(req);
    const id = Id.safeParse((req.params as { id: string }).id);
    const p = id.success ? getProfile(db, id.data, userId) : null;
    if (!p) return fail(reply, req.id, 'NOT_FOUND', 'Not found.');
    return UserProfile.parse(p);
  });

  app.get('/api/v1/me/profile', authed, async (req, reply) => {
    const { userId } = requireActor(req);
    const p = getProfile(db, userId, userId);
    if (!p) return fail(reply, req.id, 'NOT_FOUND', 'Not found.');
    return UserProfile.parse(p);
  });
}
