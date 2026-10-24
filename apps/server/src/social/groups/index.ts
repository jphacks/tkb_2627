import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  ApiError,
  ERROR_HTTP_STATUS,
  Group,
  GroupCreateRequest,
  GroupInviteAccept,
  GroupInviteCreate,
  GroupInviteCreated,
  Id,
  Membership,
  type ErrorCode,
} from '@tkb/contracts';
import {
  acceptInvite,
  createGroup,
  createInvite,
  getMemberRole,
  listGroupsForUser,
  removeMember,
  type Db,
  countPendingInvites,
  MAX_PENDING_INVITES,
  userExists,
} from '@tkb/db';
import { requireActor } from '../../platform/auth/index.ts';
import type { SharedConfig } from '../../platform/config.ts';

function fail(reply: FastifyReply, requestId: string, code: ErrorCode, message: string, retryable = false) {
  return reply
    .status(ERROR_HTTP_STATUS[code])
    .send(ApiError.parse({ code, message, retryable, requestId }));
}

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

/** K17. Membership is read from the DB on every request; nothing is cached. */
export function registerGroups(app: FastifyInstance, db: Db, config: SharedConfig): void {
  const pre = { preHandler: app.authenticate };
  const origin = config.publicOrigin || 'http://127.0.0.1:5173';

  app.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/api/v1/group')) reply.header('cache-control', 'no-store');
  });

  app.post('/api/v1/groups', pre, async (req, reply) => {
    const { userId } = requireActor(req);
    const body = GroupCreateRequest.safeParse(req.body);
    if (!body.success) return fail(reply, req.id, 'VALIDATION_FAILED', 'Invalid request.');
    const g = createGroup(db, userId, body.data.name, nowIso());
    return reply.status(201).send(Group.parse(g));
  });

  app.get('/api/v1/groups', pre, async (req) => {
    const { userId } = requireActor(req);
    return listGroupsForUser(db, userId).map((g) => Group.parse(g));
  });

  app.post('/api/v1/groups/:id/invites', pre, async (req, reply) => {
    const { userId } = requireActor(req);
    const groupId = Id.safeParse((req.params as { id: string }).id);
    const role = groupId.success ? getMemberRole(db, groupId.data, userId) : null;
    if (!groupId.success || !role) return fail(reply, req.id, 'NOT_FOUND', 'Not found.');
    if (role === 'member') return fail(reply, req.id, 'FORBIDDEN', 'Forbidden.');
    const parsed = GroupInviteCreate.safeParse(req.body ?? {});
    if (!parsed.success) return fail(reply, req.id, 'VALIDATION_FAILED', 'Invalid request.');
    let inviteeId: string | null = null;
    if (parsed.data.inviteeId) {
      if (!userExists(db, parsed.data.inviteeId)) return fail(reply, req.id, 'VALIDATION_FAILED', 'Invalid request.');
      inviteeId = parsed.data.inviteeId;
    }
    if (countPendingInvites(db, groupId.data, new Date()) >= MAX_PENDING_INVITES) {
      return fail(reply, req.id, 'RATE_LIMITED', 'Too many pending invites.', true);
    }
    const { token, expiresAt } = createInvite(db, groupId.data, inviteeId, new Date());
    return reply
      .status(201)
      .send(GroupInviteCreated.parse({ inviteUrl: `${origin}/invite#${token}`, expiresAt }));
  });

  app.post('/api/v1/group-invites/accept', pre, async (req, reply) => {
    const { userId } = requireActor(req);
    const body = GroupInviteAccept.safeParse(req.body);
    if (!body.success) return fail(reply, req.id, 'VALIDATION_FAILED', 'Invalid request.');
    const r = acceptInvite(db, body.data.token, userId, new Date());
    if (!r.ok) {
      if (r.reason === 'NOT_FOUND') return fail(reply, req.id, 'NOT_FOUND', 'Not found.');
      if (r.reason === 'EXPIRED') return fail(reply, req.id, 'EXPIRED', 'Invite expired.');
      return fail(reply, req.id, 'ALREADY_COMMITTED', 'Invite cannot be used.');
    }
    return Membership.parse({ groupId: r.groupId, userId, membership: 'active' });
  });

  app.delete('/api/v1/groups/:id/members/:userId', pre, async (req, reply) => {
    const { userId } = requireActor(req);
    const p = req.params as { id: string; userId: string };
    const gid = Id.safeParse(p.id);
    const tid = Id.safeParse(p.userId);
    if (!gid.success || !tid.success) return fail(reply, req.id, 'NOT_FOUND', 'Not found.');
    const r = removeMember(db, gid.data, userId, tid.data);
    if (!r.ok) {
      return r.reason === 'FORBIDDEN'
        ? fail(reply, req.id, 'FORBIDDEN', 'Forbidden.')
        : fail(reply, req.id, 'NOT_FOUND', 'Not found.');
    }
    return reply.status(204).send();
  });
}
