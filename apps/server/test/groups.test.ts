import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Group, GroupInviteCreated, Membership } from '@tkb/contracts';
import { createUser, isActiveMember, migrate, openDatabase } from '@tkb/db';
import { buildApp } from '../src/platform/app.ts';
import { hashPassword } from '../src/platform/auth/password.ts';
import { loadConfig } from '../src/platform/config.ts';

const PW = 'correct horse battery';
const apps: ReturnType<typeof buildApp>[] = [];
let pwHash: string;
beforeAll(async () => {
  pwHash = await hashPassword(PW);
});
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

type App = ReturnType<typeof buildApp>;
interface Session { cookie: string; csrf: string }

function make() {
  const db = openDatabase(':memory:');
  migrate(db);
  for (const id of ['user_a', 'user_b', 'user_c']) {
    createUser(db, { id, loginId: id.replace('_', '-'), passwordHash: pwHash, displayName: id, createdAt: new Date().toISOString() });
  }
  const config = { ...loadConfig({ SESSION_SECRET: 's'.repeat(40) }), databasePath: ':memory:' };
  const app = buildApp({ config, db });
  apps.push(app);
  return { app, db };
}

async function login(app: App, loginId: string): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { loginId, password: PW } });
  expect(res.statusCode).toBe(200);
  return { cookie: String(res.headers['set-cookie']).split(';')[0]!, csrf: res.json().csrfToken };
}
const call = (app: App, s: Session, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf } });

async function groupWith(app: App) {
  const a = await login(app, 'user-a');
  const g = Group.parse((await call(app, a, 'POST', '/api/v1/groups', { name: 'Trip club' })).json());
  return { a, g };
}
const inviteToken = async (app: App, s: Session, gid: string, body: object = {}) => {
  const res = await call(app, s, 'POST', `/api/v1/groups/${gid}/invites`, body);
  expect(res.statusCode).toBe(201);
  const inv = GroupInviteCreated.parse(res.json());
  return { inv, token: inv.inviteUrl.split('#')[1]! };
};

describe('groups', () => {
  it('creator is owner and sees the group; non-members get 404', async () => {
    const { app } = make();
    const { a, g } = await groupWith(app);
    expect(g.role).toBe('owner');
    const list = await call(app, a, 'GET', '/api/v1/groups');
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.json()).toHaveLength(1);
    const b = await login(app, 'user-b');
    expect((await call(app, b, 'GET', '/api/v1/groups')).json()).toEqual([]);
    expect((await call(app, b, 'POST', `/api/v1/groups/${g.groupId}/invites`, {})).statusCode).toBe(404);
    expect((await call(app, b, 'POST', '/api/v1/groups/nope/invites', {})).statusCode).toBe(404);
  });

  it('requires login and CSRF', async () => {
    const { app } = make();
    expect((await app.inject({ method: 'GET', url: '/api/v1/groups' })).statusCode).toBe(401);
    const a = await login(app, 'user-a');
    const res = await app.inject({ method: 'POST', url: '/api/v1/groups', payload: { name: 'x' }, headers: { cookie: a.cookie } });
    expect(res.statusCode).toBe(403);
  });

  it('invite: url uses fragment, plain member gets 403, token not stored, accept then reuse 409', async () => {
    const { app, db } = make();
    const { a, g } = await groupWith(app);
    const { inv, token } = await inviteToken(app, a, g.groupId);
    expect(inv.inviteUrl).toBe(`http://127.0.0.1:5173/invite#${token}`);
    expect(JSON.stringify(db.prepare('SELECT * FROM group_invites').all())).not.toContain(token);
    const b = await login(app, 'user-b');
    const ok = await call(app, b, 'POST', '/api/v1/group-invites/accept', { token });
    expect(ok.statusCode).toBe(200);
    expect(Membership.parse(ok.json()).membership).toBe('active');
    expect((await call(app, b, 'POST', `/api/v1/groups/${g.groupId}/invites`, {})).statusCode).toBe(403);
    const c = await login(app, 'user-c');
    expect((await call(app, c, 'POST', '/api/v1/group-invites/accept', { token })).statusCode).toBe(409);
    expect((await call(app, b, 'POST', '/api/v1/group-invites/accept', { token })).statusCode).toBe(409);
  });

  it('expired invite is 410; invitee mismatch is 404', async () => {
    const { app, db } = make();
    const { a, g } = await groupWith(app);
    const { token } = await inviteToken(app, a, g.groupId);
    db.prepare("UPDATE group_invites SET expires_at = '2020-01-01T00:00:00Z'").run();
    const b = await login(app, 'user-b');
    expect((await call(app, b, 'POST', '/api/v1/group-invites/accept', { token })).statusCode).toBe(410);
    const t2 = await inviteToken(app, a, g.groupId, { inviteeId: 'user_b' });
    const c = await login(app, 'user-c');
    expect((await call(app, c, 'POST', '/api/v1/group-invites/accept', { token: t2.token })).statusCode).toBe(404);
    expect((await call(app, b, 'POST', '/api/v1/group-invites/accept', { token: t2.token })).statusCode).toBe(200);
  });

  it('parallel accepts of one invite: exactly one succeeds', async () => {
    const { app } = make();
    const { a, g } = await groupWith(app);
    const { token } = await inviteToken(app, a, g.groupId);
    const b = await login(app, 'user-b');
    const c = await login(app, 'user-c');
    const rs = await Promise.all([
      call(app, b, 'POST', '/api/v1/group-invites/accept', { token }),
      call(app, c, 'POST', '/api/v1/group-invites/accept', { token }),
    ]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  });

  it('removal ends access immediately and rejoin needs a new invite', async () => {
    const { app, db } = make();
    const { a, g } = await groupWith(app);
    const { token } = await inviteToken(app, a, g.groupId);
    const b = await login(app, 'user-b');
    await call(app, b, 'POST', '/api/v1/group-invites/accept', { token });
    expect(isActiveMember(db, g.groupId, 'user_b')).toBe(true);
    expect((await call(app, a, 'DELETE', `/api/v1/groups/${g.groupId}/members/user_b`)).statusCode).toBe(204);
    expect(isActiveMember(db, g.groupId, 'user_b')).toBe(false);
    expect((await call(app, b, 'GET', '/api/v1/groups')).json()).toEqual([]);
    expect((await call(app, b, 'POST', '/api/v1/group-invites/accept', { token })).statusCode).toBe(409);
    const t2 = await inviteToken(app, a, g.groupId);
    expect((await call(app, b, 'POST', '/api/v1/group-invites/accept', { token: t2.token })).statusCode).toBe(200);
  });

  it('owner cannot be removed, members cannot remove others, self-leave works', async () => {
    const { app } = make();
    const { a, g } = await groupWith(app);
    const b = await login(app, 'user-b');
    const c = await login(app, 'user-c');
    for (const s of [b, c]) {
      const { token } = await inviteToken(app, a, g.groupId);
      await call(app, s, 'POST', '/api/v1/group-invites/accept', { token });
    }
    expect((await call(app, a, 'DELETE', `/api/v1/groups/${g.groupId}/members/user_a`)).statusCode).toBe(403);
    expect((await call(app, b, 'DELETE', `/api/v1/groups/${g.groupId}/members/user_a`)).statusCode).toBe(403);
    expect((await call(app, b, 'DELETE', `/api/v1/groups/${g.groupId}/members/user_c`)).statusCode).toBe(403);
    expect((await call(app, b, 'DELETE', `/api/v1/groups/${g.groupId}/members/user_b`)).statusCode).toBe(204);
    expect((await call(app, b, 'DELETE', `/api/v1/groups/${g.groupId}/members/user_c`)).statusCode).toBe(404);
  });
});
