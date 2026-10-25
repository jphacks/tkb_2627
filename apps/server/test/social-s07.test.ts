import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fixtureTrips } from '@tkb/fixtures';
import { createUser, insertTrip, migrate, openDatabase } from '@tkb/db';
import { buildApp } from '../src/platform/app.ts';
import { hashPassword } from '../src/platform/auth/password.ts';
import { loadConfig } from '../src/platform/config.ts';
import { detectImageType, sanitizeImage, stripJpeg, stripPng, stripWebp } from '../src/social/posts/images.ts';

const PW = 'correct horse battery';
const NOW = '2026-10-24T03:00:00Z';
const apps: ReturnType<typeof buildApp>[] = [];
let pwHash: string;
beforeAll(async () => {
  pwHash = await hashPassword(PW);
});
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});
interface Session { cookie: string; csrf: string }

// ---- tiny image builders -------------------------------------------------------------------
const seg = (marker: number, data: number[]) => [0xff, marker, (data.length + 2) >> 8, (data.length + 2) & 0xff, ...data];
const ascii = (s: string) => [...Buffer.from(s, 'latin1')];
const GPS = 'GPS-35.6812N-139.7671E';
function jpeg(): Buffer {
  return Buffer.from([
    0xff, 0xd8,
    ...seg(0xe0, [...ascii('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...seg(0xe1, [...ascii('Exif\0\0'), ...ascii(GPS)]),
    ...seg(0xe2, ascii('ICC_PROFILE')),
    ...seg(0xfe, ascii('comment-secret')),
    ...seg(0xc0, [8, 0, 20, 0, 30, 1, 1, 0x11, 0]), // 30x20, 1 component
    ...seg(0xda, [1, 1, 0, 0, 0x3f, 0]),
    0x12, 0x34, 0xff, 0x00, 0x56,
    0xff, 0xd9,
  ]);
}
const chunk = (type: string, data: number[]) => [0, 0, 0, data.length, ...ascii(type), ...data, 0, 0, 0, 0];
function png(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', [0, 0, 0, 7, 0, 0, 0, 5, 8, 2, 0, 0, 0]),
    ...chunk('tEXt', ascii(`Comment\0${GPS}`)),
    ...chunk('eXIf', ascii(GPS)),
    ...chunk('iTXt', ascii(GPS)),
    ...chunk('IDAT', [1, 2, 3]),
    ...chunk('IEND', []),
  ]);
}
const le32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
const wchunk = (type: string, data: number[]) => [...ascii(type), ...le32(data.length), ...data, ...(data.length & 1 ? [0] : [])];
function webp(): Buffer {
  const body = [
    ...ascii('WEBP'),
    ...wchunk('VP8X', [0x0c, 0, 0, 0, 39, 0, 0, 24, 0, 0]), // 40x25, EXIF+XMP flags
    ...wchunk('VP8L', [0x2f, 39, 0, 0, 0]),
    ...wchunk('EXIF', ascii(GPS)),
    ...wchunk('XMP ', ascii(`<x>${GPS}</x>`)),
  ];
  return Buffer.from([...ascii('RIFF'), ...le32(body.length), ...body]);
}

describe('image strippers (S07)', () => {
  it('JPEG: drops APP1..APP15 and COM, keeps APP0 and the image data, reads size', () => {
    const r = stripJpeg(jpeg())!;
    expect(r).toMatchObject({ contentType: 'image/jpeg', width: 30, height: 20 });
    const out = Buffer.from(r.bytes);
    expect(out.includes(Buffer.from(GPS))).toBe(false);
    expect(out.includes(Buffer.from('Exif'))).toBe(false);
    expect(out.includes(Buffer.from('ICC_PROFILE'))).toBe(false);
    expect(out.includes(Buffer.from('comment-secret'))).toBe(false);
    expect(out.includes(Buffer.from('JFIF'))).toBe(true);
    expect(out.subarray(out.length - 7).equals(Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd9]))).toBe(true);
    expect(stripJpeg(out)).not.toBeNull(); // output is itself valid
  });
  it('PNG: drops tEXt/iTXt/zTXt/eXIf, keeps IHDR/IDAT/IEND', () => {
    const r = stripPng(png())!;
    expect(r).toMatchObject({ contentType: 'image/png', width: 7, height: 5 });
    const out = Buffer.from(r.bytes);
    expect(out.includes(Buffer.from(GPS))).toBe(false);
    for (const t of ['tEXt', 'eXIf', 'iTXt']) expect(out.includes(Buffer.from(t))).toBe(false);
    for (const t of ['IHDR', 'IDAT', 'IEND']) expect(out.includes(Buffer.from(t))).toBe(true);
  });
  it('WebP: drops EXIF/XMP, clears VP8X flags, fixes RIFF size', () => {
    const r = stripWebp(webp())!;
    expect(r).toMatchObject({ contentType: 'image/webp', width: 40, height: 25 });
    const out = Buffer.from(r.bytes);
    expect(out.includes(Buffer.from(GPS))).toBe(false);
    expect(out.includes(Buffer.from('EXIF'))).toBe(false);
    expect(out.includes(Buffer.from('XMP '))).toBe(false);
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
    expect(out[20]! & 0x0c).toBe(0);
    expect(out.includes(Buffer.from('VP8L'))).toBe(true);
  });
  it('rejects truncated, mismatched and non-image bytes', () => {
    expect(stripJpeg(jpeg().subarray(0, 30))).toBeNull();
    expect(stripPng(png().subarray(0, 40))).toBeNull();
    expect(stripWebp(webp().subarray(0, 30))).toBeNull();
    expect(sanitizeImage('image/png', jpeg())).toBeNull();
    expect(sanitizeImage('image/jpeg', Buffer.from('<html>not an image</html>'))).toBeNull();
    expect(detectImageType(Buffer.from('GIF89a......'))).toBeNull();
  });
});

// ---- HTTP ----------------------------------------------------------------------------------
async function setup() {
  const db = openDatabase(':memory:');
  migrate(db);
  for (const [id, name] of [['user_a', 'Alice'], ['user_b', 'Bob'], ['user_c', 'Carol']] as const) {
    createUser(db, { id, loginId: id.replace('_', '-'), passwordHash: pwHash, displayName: name, createdAt: NOW });
  }
  const app = buildApp({ config: { ...loadConfig({ SESSION_SECRET: 's'.repeat(40) }), databasePath: ':memory:' }, db });
  apps.push(app);
  const login = async (loginId: string): Promise<Session> => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { loginId, password: PW } });
    return { cookie: String(res.headers['set-cookie']).split(';')[0]!, csrf: res.json().csrfToken };
  };
  const a = await login('user-a');
  const b = await login('user-b');
  const c = await login('user-c');
  const call = (s: Session | null, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url, payload: payload as object, headers: s ? { cookie: s.cookie, 'x-csrf-token': s.csrf } : {} });
  const upload = (s: Session | null, body: Buffer, type: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/post-images',
      payload: body,
      headers: { ...(s ? { cookie: s.cookie, 'x-csrf-token': s.csrf } : {}), 'content-type': type },
    });
  const gid = (await call(a, 'POST', '/api/v1/groups', { name: 'club' })).json().groupId as string;
  const inv = (await call(a, 'POST', `/api/v1/groups/${gid}/invites`, { inviteeId: 'user_b' })).json().inviteUrl as string;
  await call(b, 'POST', '/api/v1/group-invites/accept', { token: inv.split('#')[1] });
  let n = 0;
  const publish = async (s: Session, owner: string, visibility: string, groupId: string | null = null, imageIds?: string[]) => {
    const t = structuredClone(fixtureTrips[0]!);
    t.tripId = `trip_s07_${++n}`;
    insertTrip(db, owner, t, NOW);
    const pv = await call(s, 'POST', '/api/v1/posts/preview', {
      tripId: t.tripId,
      sourceRevision: 1,
      visibility,
      groupId,
      story: 's',
      ...(imageIds ? { imageIds } : {}),
    });
    if (pv.statusCode !== 200) return pv;
    return call(s, 'POST', '/api/v1/posts', { previewToken: pv.json().previewToken, confirmed: true });
  };
  return { app, db, a, b, c, gid, call, upload, publish };
}

describe('author, isMine, likes, updatedAt in feed and detail', () => {
  it('every item carries author/isMine/likeCount/likedByMe/images', async () => {
    const { call, a, b, publish } = await setup();
    const p = (await publish(a, 'user_a', 'public')).json();
    expect(p.author).toMatchObject({ userId: 'user_a', displayName: 'Alice', avatarInitial: 'A' });
    expect(p.author.avatarColor).toMatch(/^#[0-9a-f]{6}$/i);
    expect(p).toMatchObject({ isMine: true, likeCount: 0, likedByMe: false, images: [], updatedAt: null });
    const f1 = (await call(b, 'GET', '/api/v1/posts?scope=public')).json().items[0];
    expect(f1).toMatchObject({ isMine: false, author: p.author });
    const anon = (await call(null, 'GET', '/api/v1/posts?scope=public')).json().items[0];
    expect(anon).toMatchObject({ isMine: false, likedByMe: false, likeCount: 0 });
    expect((await call(a, 'GET', `/api/v1/posts/${p.postId}`)).json().author.avatarColor).toBe(p.author.avatarColor);
  });

  it('edit: owner only, sets updatedAt; delete: owner only', async () => {
    const { call, a, b, publish } = await setup();
    const p = (await publish(a, 'user_a', 'public')).json();
    expect((await call(b, 'PATCH', `/api/v1/posts/${p.postId}`, { expectedPostRevision: 1, story: 'hack' })).statusCode).toBe(404);
    expect((await call(b, 'DELETE', `/api/v1/posts/${p.postId}`)).statusCode).toBe(404);
    const r = await call(a, 'PATCH', `/api/v1/posts/${p.postId}`, { expectedPostRevision: 1, story: 'new' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ story: 'new', postRevision: 2 });
    expect(r.json().updatedAt).toMatch(/Z$/);
  });
});

describe('likes', () => {
  it('idempotent PUT/DELETE, counts per post, 404 on a private post for others, needs login', async () => {
    const { call, a, b, publish } = await setup();
    const pub = (await publish(a, 'user_a', 'public')).json();
    const priv = (await publish(a, 'user_a', 'private')).json();
    const url = `/api/v1/posts/${pub.postId}/like`;
    expect((await call(b, 'PUT', url)).json()).toEqual({ postId: pub.postId, likeCount: 1, likedByMe: true });
    expect((await call(b, 'PUT', url)).json().likeCount).toBe(1);
    expect((await call(a, 'PUT', url)).json().likeCount).toBe(2);
    expect((await call(b, 'GET', `/api/v1/posts/${pub.postId}`)).json()).toMatchObject({ likeCount: 2, likedByMe: true });
    expect((await call(null, 'GET', `/api/v1/posts/${pub.postId}`)).json()).toMatchObject({ likeCount: 2, likedByMe: false });
    expect((await call(b, 'DELETE', url)).json()).toMatchObject({ likeCount: 1, likedByMe: false });
    expect((await call(b, 'DELETE', url)).json()).toMatchObject({ likeCount: 1, likedByMe: false });
    expect((await call(b, 'PUT', `/api/v1/posts/${priv.postId}/like`)).statusCode).toBe(404);
    expect((await call(b, 'DELETE', `/api/v1/posts/${priv.postId}/like`)).statusCode).toBe(404);
    expect((await call(a, 'PUT', `/api/v1/posts/${priv.postId}/like`)).statusCode).toBe(200);
    expect((await call(b, 'PUT', '/api/v1/posts/nope/like')).statusCode).toBe(404);
    expect((await call(null, 'PUT', url)).statusCode).toBe(401);
  });
  it('group post: member may like, non-member 404', async () => {
    const { call, a, b, c, gid, publish } = await setup();
    const g = (await publish(a, 'user_a', 'group', gid)).json();
    expect((await call(b, 'PUT', `/api/v1/posts/${g.postId}/like`)).statusCode).toBe(200);
    expect((await call(c, 'PUT', `/api/v1/posts/${g.postId}/like`)).statusCode).toBe(404);
  });
  it('requires the CSRF token', async () => {
    const { app, a, b, publish } = await setup();
    const p = (await publish(a, 'user_a', 'public')).json();
    const r = await app.inject({ method: 'PUT', url: `/api/v1/posts/${p.postId}/like`, headers: { cookie: b.cookie } });
    expect(r.statusCode).toBe(403);
  });
});

describe('follow and profile', () => {
  it('self follow 422, unknown 404, idempotent, counts, profile', async () => {
    const { call, a, b, c } = await setup();
    expect((await call(a, 'PUT', '/api/v1/users/user_a/follow')).statusCode).toBe(422);
    expect((await call(a, 'PUT', '/api/v1/users/ghost/follow')).statusCode).toBe(404);
    expect((await call(a, 'GET', '/api/v1/users/ghost/profile')).statusCode).toBe(404);
    const r = await call(b, 'PUT', '/api/v1/users/user_a/follow');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ followerCount: 1, followingCount: 0, followedByMe: true, isMe: false });
    expect((await call(b, 'PUT', '/api/v1/users/user_a/follow')).json().followerCount).toBe(1);
    await call(c, 'PUT', '/api/v1/users/user_a/follow');
    await call(a, 'PUT', '/api/v1/users/user_b/follow');
    expect((await call(a, 'GET', '/api/v1/me/profile')).json()).toMatchObject({
      followerCount: 2,
      followingCount: 1,
      followedByMe: false,
      isMe: true,
      user: { userId: 'user_a', displayName: 'Alice' },
    });
    expect((await call(c, 'GET', '/api/v1/users/user_a/profile')).json()).toMatchObject({ followerCount: 2, followedByMe: true });
    expect((await call(b, 'DELETE', '/api/v1/users/user_a/follow')).json()).toMatchObject({ followerCount: 1, followedByMe: false });
    expect((await call(b, 'DELETE', '/api/v1/users/user_a/follow')).statusCode).toBe(200);
    expect((await call(null, 'GET', '/api/v1/users/user_a/profile')).statusCode).toBe(401);
  });

  it('following feed: only followed authors, never private or non-member group posts, same paging', async () => {
    const { call, a, b, c, gid, publish } = await setup();
    const pub1 = (await publish(a, 'user_a', 'public')).json();
    const grp = (await publish(a, 'user_a', 'group', gid)).json();
    const priv = (await publish(a, 'user_a', 'private')).json();
    const pub2 = (await publish(a, 'user_a', 'public')).json();
    const other = (await publish(c, 'user_c', 'public')).json();
    await call(b, 'PUT', '/api/v1/users/user_a/follow');
    await call(c, 'PUT', '/api/v1/users/user_a/follow');
    const ids = async (s: Session) =>
      (await call(s, 'GET', '/api/v1/posts?scope=following')).json().items.map((i: { postId: string }) => i.postId).sort();
    expect(await ids(b)).toEqual([pub1.postId, grp.postId, pub2.postId].sort());
    expect(await ids(c)).toEqual([pub1.postId, pub2.postId].sort());
    expect(await ids(b)).not.toContain(priv.postId);
    expect(await ids(b)).not.toContain(other.postId);
    expect(await ids(a)).toEqual([]);
    const seen: string[] = [];
    let cursor = '';
    for (let i = 0; i < 5; i++) {
      const r = (await call(b, 'GET', `/api/v1/posts?scope=following&limit=1${cursor}`)).json();
      seen.push(...r.items.map((x: { postId: string }) => x.postId));
      if (!r.nextCursor) break;
      cursor = `&cursor=${r.nextCursor}`;
    }
    expect(seen.sort()).toEqual([pub1.postId, grp.postId, pub2.postId].sort());
    expect((await call(null, 'GET', '/api/v1/posts?scope=following')).statusCode).toBe(401);
    // Removed from the group: following does not keep the group post visible.
    await call(a, 'DELETE', `/api/v1/groups/${gid}/members/user_b`);
    expect(await ids(b)).toEqual([pub1.postId, pub2.postId].sort());
  });
});

describe('post images', () => {
  it('upload checks: type, magic bytes, size, auth, empty', async () => {
    const { upload, a } = await setup();
    expect((await upload(null, jpeg(), 'image/jpeg')).statusCode).toBe(401);
    expect((await upload(a, jpeg(), 'image/gif')).statusCode).toBe(422);
    expect((await upload(a, jpeg(), 'text/plain')).statusCode).toBe(422);
    expect((await upload(a, png(), 'image/jpeg')).statusCode).toBe(422); // header lies
    expect((await upload(a, Buffer.from('<script>alert(1)</script>'), 'image/png')).statusCode).toBe(422);
    expect((await upload(a, Buffer.alloc(0), 'image/png')).statusCode).toBe(422);
    const big = Buffer.concat([png(), Buffer.alloc(5 * 1024 * 1024 + 1)]);
    expect((await upload(a, big, 'image/png')).statusCode).toBe(422);
    const ok = await upload(a, jpeg(), 'image/jpeg');
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ width: 30, height: 20, url: expect.stringMatching(/^\/api\/v1\/post-images\//) });
    expect((await upload(a, png(), 'image/png')).statusCode).toBe(201);
    expect((await upload(a, webp(), 'image/webp')).statusCode).toBe(201);
  });

  it('upload requires CSRF', async () => {
    const { app, a } = await setup();
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/post-images',
      payload: jpeg(),
      headers: { cookie: a.cookie, 'content-type': 'image/jpeg' },
    });
    expect(r.statusCode).toBe(403);
  });

  it('stored and served bytes have no EXIF/GPS; headers are safe', async () => {
    const { upload, call, db, a } = await setup();
    for (const [buf, type] of [[jpeg(), 'image/jpeg'], [png(), 'image/png'], [webp(), 'image/webp']] as const) {
      const up = (await upload(a, buf, type)).json();
      const got = await call(a, 'GET', up.url);
      expect(got.statusCode).toBe(200);
      expect(got.headers['content-type']).toBe(type);
      expect(got.headers['x-content-type-options']).toBe('nosniff');
      expect(got.headers['cache-control']).toBe('private, no-store');
      expect(got.rawPayload.includes(Buffer.from(GPS))).toBe(false);
    }
    const rows = db.prepare('SELECT bytes FROM post_images').all() as { bytes: Uint8Array }[];
    for (const r of rows) expect(Buffer.from(r.bytes).includes(Buffer.from(GPS))).toBe(false);
  });

  it('ACL: unattached owner-only; attached follows post visibility; deleted post 404', async () => {
    const { upload, call, publish, a, b, c, gid } = await setup();
    const up = async () => (await upload(a, jpeg(), 'image/jpeg')).json().imageId as string;
    const loose = await up();
    expect((await call(a, 'GET', `/api/v1/post-images/${loose}`)).statusCode).toBe(200);
    for (const s of [b, null]) expect((await call(s, 'GET', `/api/v1/post-images/${loose}`)).statusCode).toBe(404);
    expect((await call(a, 'GET', '/api/v1/post-images/unknown')).statusCode).toBe(404);

    const mk = async (vis: string, groupId: string | null) => {
      const id = await up();
      const p = await publish(a, 'user_a', vis, groupId, [id]);
      expect(p.statusCode).toBe(201);
      expect(p.json().images).toEqual([{ imageId: id, url: `/api/v1/post-images/${id}`, width: 30, height: 20 }]);
      return { id, postId: p.json().postId as string };
    };
    const pub = await mk('public', null);
    const grp = await mk('group', gid);
    const priv = await mk('private', null);
    const status = async (s: Session | null, id: string) => (await call(s, 'GET', `/api/v1/post-images/${id}`)).statusCode;
    expect([await status(null, pub.id), await status(c, pub.id), await status(b, pub.id)]).toEqual([200, 200, 200]);
    expect([await status(a, grp.id), await status(b, grp.id), await status(c, grp.id), await status(null, grp.id)]).toEqual([200, 200, 404, 404]);
    expect([await status(a, priv.id), await status(b, priv.id), await status(null, priv.id)]).toEqual([200, 404, 404]);
    expect((await call(c, 'GET', '/api/v1/posts?scope=public')).json().items[0].images[0].imageId).toBe(pub.id);
    expect((await call(a, 'DELETE', `/api/v1/posts/${pub.postId}`)).statusCode).toBe(204);
    expect([await status(a, pub.id), await status(null, pub.id)]).toEqual([404, 404]);
  });

  it("imageIds must be the actor's own, unattached, distinct, max 4", async () => {
    const { upload, publish, a, b } = await setup();
    const up = async (s: Session) => (await upload(s, jpeg(), 'image/jpeg')).json().imageId as string;
    const mine = await up(a);
    const theirs = await up(b);
    expect((await publish(a, 'user_a', 'public', null, [theirs])).statusCode).toBe(422);
    expect((await publish(a, 'user_a', 'public', null, ['missing'])).statusCode).toBe(422);
    expect((await publish(a, 'user_a', 'public', null, [mine, mine])).statusCode).toBe(422);
    expect((await publish(a, 'user_a', 'public', null, [mine, 'a', 'b', 'c', 'd'])).statusCode).toBe(422);
    expect((await publish(a, 'user_a', 'public', null, [mine])).statusCode).toBe(201);
    expect((await publish(a, 'user_a', 'public', null, [mine])).statusCode).toBe(422); // already attached
    const four = [await up(a), await up(a), await up(a), await up(a)];
    const ok = await publish(a, 'user_a', 'public', null, four);
    expect(ok.statusCode).toBe(201);
    expect(ok.json().images.map((i: { imageId: string }) => i.imageId)).toEqual(four);
  });

  it('a second preview holding the same image fails at confirm', async () => {
    const { upload, call, db, a } = await setup();
    const id = (await upload(a, jpeg(), 'image/jpeg')).json().imageId as string;
    const previews: string[] = [];
    for (let i = 0; i < 2; i++) {
      const t = structuredClone(fixtureTrips[0]!);
      t.tripId = `trip_dup_${i}`;
      insertTrip(db, 'user_a', t, NOW);
      const pv = await call(a, 'POST', '/api/v1/posts/preview', { tripId: t.tripId, sourceRevision: 1, visibility: 'public', story: 's', imageIds: [id] });
      previews.push(pv.json().previewToken);
    }
    const c1 = await call(a, 'POST', '/api/v1/posts', { previewToken: previews[0], confirmed: true });
    const c2 = await call(a, 'POST', '/api/v1/posts', { previewToken: previews[1], confirmed: true });
    expect([c1.statusCode, c2.statusCode]).toEqual([201, 422]);
  });
});
