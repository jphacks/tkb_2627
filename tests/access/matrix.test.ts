// T03 access matrix (R20 R21 R22 R25 R26 R30). Written from model/visibility.json, docs/03_CONTRACTS.md
// and docs/07_TESTS.md scenarios 2/4/5, not from the implementation. Do not weaken expectations.
// Actors: anon, owner(A), member(B), other(C), removed(D, was a member, removed over HTTP).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACTORS, VIS, call, callNoCsrf, canRead, closeAll, login, makeWorld, stripReq, LEAKS,
  type Actor, type Vis, type World,
} from './helpers.ts';

afterAll(closeAll);
const cells = ACTORS.flatMap((who) => VIS.map((v) => [who, v] as [Actor, Vis]));
const denyStatus = (who: Actor) => (who === 'anon' ? 401 : 404);
/** Posts each actor may see per feed scope (owner A published private, group and public posts). */
const expectIds = (who: Actor, scope: 'public' | 'groups' | 'mine'): Vis[] => {
  if (scope === 'public') return ['public'];
  if (who === 'anon') return [];
  if (scope === 'mine') return who === 'owner' ? ['public', 'group', 'private'] : [];
  return who === 'owner' || who === 'member' ? ['group'] : [];
};
const srcTrip = (w: World) => JSON.stringify([
  w.db.prepare('SELECT * FROM trips WHERE id = ?').all('trip_acc_a'),
  w.db.prepare('SELECT * FROM trip_versions WHERE trip_id = ?').all('trip_acc_a'),
]);
const dump = (w: World) => JSON.stringify([
  w.db.prepare('SELECT * FROM posts ORDER BY id').all(),
  w.db.prepare('SELECT * FROM post_snapshots ORDER BY 1').all(),
  w.db.prepare('SELECT * FROM trips ORDER BY id').all(),
  w.db.prepare('SELECT * FROM trip_versions ORDER BY 1,2').all(),
  w.db.prepare('SELECT * FROM group_members ORDER BY 1,2').all(),
  w.db.prepare('SELECT * FROM groups ORDER BY 1').all(),
  w.db.prepare('SELECT * FROM group_invites ORDER BY 1').all(),
  w.db.prepare('SELECT * FROM post_previews ORDER BY 1').all(),
  w.db.prepare('SELECT * FROM plan_batches ORDER BY 1').all(),
]);

describe('read-only matrix on one shared world', () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  describe('post detail GET: actor x visibility', () => {
    it.each(cells)('%s reads %s post', async (who, v) => {
      const res = await call(w.app, w.actors[who], 'GET', `/api/v1/posts/${w.posts[v].postId}`);
      if (canRead(v, who)) {
        expect(res.statusCode).toBe(200);
        expect(res.json().story).toBe(w.posts[v].story);
        expect(res.headers['cache-control']).toBe('no-store');
        // Even the owner's own snapshot must not carry the stripped fields.
        for (const bad of LEAKS('A')) expect(res.body).not.toContain(bad);
      } else {
        // Not visible == not found, also for anonymous (K14); body carries nothing of the post.
        expect(res.statusCode).toBe(404);
        expect(res.headers['cache-control']).toBe('no-store');
        for (const bad of ['STORY-', 'TITLE-A', ...LEAKS('A')]) expect(res.body).not.toContain(bad);
        const ghost = await call(w.app, w.actors[who], 'GET', '/api/v1/posts/post_does_not_exist');
        expect(stripReq(res)).toEqual(stripReq(ghost));
      }
    });
  });

  describe('feed: actor x scope never lists posts the actor cannot read', () => {
    it.each(ACTORS.flatMap((who) => (['public', 'groups', 'mine'] as const).map((s) => [who, s] as const)))(
      '%s scope=%s',
      async (who, scope) => {
        const res = await call(w.app, w.actors[who], 'GET', `/api/v1/posts?scope=${scope}`);
        if (who === 'anon' && scope !== 'public') {
          expect(res.statusCode).toBe(401);
          return;
        }
        expect(res.statusCode).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
        const got = (res.json().items as { postId: string }[]).map((i) => i.postId).sort();
        expect(got).toEqual(expectIds(who, scope).map((v) => w.posts[v].postId).sort());
        for (const v of VIS) {
          if (!expectIds(who, scope).includes(v)) expect(res.body).not.toContain(w.posts[v].story);
        }
        for (const bad of LEAKS('A')) expect(res.body).not.toContain(bad);
        expect(res.json().nextCursor).toBeNull();
      },
    );
    it.each(ACTORS.map((x) => [x]))('%s: limit=1 paging over every scope exposes only readable posts', async (who) => {
      for (const scope of ['public', 'groups', 'mine']) {
        if (who === 'anon' && scope !== 'public') continue;
        const seen: string[] = [];
        let cursor: string | null = null;
        for (let i = 0; i < 6; i++) {
          const res = await call(w.app, w.actors[who], 'GET', `/api/v1/posts?scope=${scope}&limit=1${cursor ? `&cursor=${cursor}` : ''}`);
          expect(res.statusCode).toBe(200);
          for (const it of res.json().items as { postId: string }[]) seen.push(it.postId);
          cursor = res.json().nextCursor;
          if (!cursor) break;
          // A cursor must not be a side channel: it never embeds an unreadable post's story.
          expect(Buffer.from(cursor, 'base64url').toString('utf8')).not.toContain('STORY-');
        }
        expect(seen.sort(), `${who} ${scope}`).toEqual(expectIds(who, scope as 'public' | 'groups' | 'mine').map((v) => w.posts[v].postId).sort());
      }
    });
  });

  describe('trips (own only, R20/R30): actor x operation', () => {
    const tid = () => w.tripA.tripId;
    it.each(ACTORS.map((x) => [x]))('%s GET /trips/:id', async (who) => {
      const res = await call(w.app, w.actors[who], 'GET', `/api/v1/trips/${tid()}`);
      if (who === 'owner') {
        expect(res.statusCode).toBe(200);
        expect(res.json().title).toBe('TITLE-A');
        return;
      }
      expect(res.statusCode).toBe(denyStatus(who));
      for (const bad of ['TITLE-A', ...LEAKS('A')]) expect(res.body).not.toContain(bad);
      if (who !== 'anon') {
        expect(stripReq(res)).toEqual(stripReq(await call(w.app, w.actors[who], 'GET', '/api/v1/trips/trip_nope')));
      }
    });
    it.each(ACTORS.map((x) => [x]))('%s GET /trips lists only own trips', async (who) => {
      const res = await call(w.app, w.actors[who], 'GET', '/api/v1/trips');
      if (who === 'anon') return expect(res.statusCode).toBe(401);
      expect(res.statusCode).toBe(200);
      const ids = (res.json().items as { tripId: string }[]).map((i) => i.tripId);
      expect(ids).toEqual(who === 'owner' ? [w.tripA.tripId] : who === 'other' ? [w.tripC.tripId] : []);
      expect(res.json().nextCursor).toBeNull();
      if (who !== 'owner') for (const bad of ['TITLE-A', ...LEAKS('A')]) expect(res.body).not.toContain(bad);
    });
  });

  describe('missing routes (E02 pending): PDF / photo delivery do not exist yet', () => {
    // When E02 lands these become real, permission-checked routes; replace this block then (see FINDINGS.md).
    it.each([
      ['GET', '/api/v1/trips/trip_acc_a/pdf'],
      ['GET', '/api/v1/trips/trip_acc_a/export'],
      ['GET', '/api/v1/posts/POST/pdf'],
      ['GET', '/api/v1/photos/anything'],
    ] as const)('%s %s is 404 for every actor', async (method, url) => {
      for (const who of ACTORS) {
        const u = url.replace('POST', w.posts.private.postId);
        const res = await call(w.app, w.actors[who], method, u);
        expect(res.statusCode, `${who} ${u}`).toBe(404);
      }
    });
  });

  it('plan-batches GET is owner-only (K07)', async () => {
    const batch = {
      schemaVersion: 1, baseTripId: null, baseRevision: null, generationId: 'gen_acc_1',
      candidates: [{ candidateId: 'c1', title: 'BATCH-SECRET', days: [{ date: '2026-11-01', timeZone: 'Asia/Tokyo', items: [] }], reasons: [], warnings: [], excludedPlaceIds: [], totalKnownCost: [], hasUnknownCost: false, validationState: 'needs_review' }],
      places: [], constraints: { area: 'Kyoto', startDate: '2026-11-01', endDate: '2026-11-01', timeZone: 'Asia/Tokyo', transportMode: 'transit' },
    };
    const made = await call(w.app, w.actors.owner, 'POST', '/api/v1/plan-batches', batch);
    expect(made.statusCode).toBe(201);
    const url = `/api/v1/plan-batches/${made.json().batchId}`;
    for (const who of ACTORS) {
      const res = await call(w.app, w.actors[who], 'GET', url);
      if (who === 'owner') { expect(res.statusCode).toBe(200); continue; }
      expect(res.statusCode, who).toBe(denyStatus(who));
      expect(res.body).not.toContain('BATCH-SECRET');
      if (who !== 'anon') expect(stripReq(res)).toEqual(stripReq(await call(w.app, w.actors[who], 'GET', '/api/v1/plan-batches/nope')));
    }
    // Applying someone else's batch is also 404 and creates nothing.
    const before = dump(w);
    for (const who of ['member', 'other', 'removed'] as const) {
      const r = await call(w.app, w.actors[who], 'POST', '/api/v1/trips/apply-candidate', { batchId: made.json().batchId, candidateId: 'c1', tripId: null, expectedRevision: null });
      expect(r.statusCode, who).toBe(404);
    }
    expect((await call(w.app, null, 'POST', '/api/v1/trips/apply-candidate', { batchId: made.json().batchId, candidateId: 'c1', tripId: null, expectedRevision: null })).statusCode).toBe(401);
    expect(dump(w)).toBe(before);
  });
});

describe('mutating matrix, fresh world per cell (state must be unchanged on every denial)', () => {
  const patchBody = (v: Vis, w: World) => ({ expectedPostRevision: w.posts[v].postRevision, story: 'HIJACKED' });

  describe('PATCH /posts/:id (edit / unpublish)', () => {
    it.each(cells)('%s edits %s post', async (who, v) => {
      const w = await makeWorld();
      const before = dump(w);
      const url = `/api/v1/posts/${w.posts[v].postId}`;
      const res = await call(w.app, w.actors[who], 'PATCH', url, patchBody(v, w));
      if (who === 'owner') {
        expect(res.statusCode).toBe(200);
        expect(res.json().story).toBe('HIJACKED');
        return;
      }
      expect(res.statusCode).toBe(denyStatus(who));
      expect(dump(w)).toBe(before);
      // Unpublishing (visibility change) is equally owner-only.
      if (who !== 'anon') {
        const un = await call(w.app, w.actors[who], 'PATCH', url, { expectedPostRevision: w.posts[v].postRevision, visibility: 'private', groupId: null });
        expect(un.statusCode).toBe(404);
        expect(dump(w)).toBe(before);
      }
    });
  });

  describe('DELETE /posts/:id', () => {
    it.each(cells)('%s deletes %s post', async (who, v) => {
      const w = await makeWorld();
      const before = dump(w);
      const url = `/api/v1/posts/${w.posts[v].postId}`;
      const res = await call(w.app, w.actors[who], 'DELETE', url);
      if (who === 'owner') {
        expect(res.statusCode).toBe(204);
        expect((await call(w.app, w.actors.owner, 'GET', url)).statusCode).toBe(404);
        expect((await call(w.app, null, 'GET', url)).statusCode).toBe(404);
        return;
      }
      expect(res.statusCode).toBe(denyStatus(who));
      expect(dump(w)).toBe(before);
      expect((await call(w.app, w.actors.owner, 'GET', url)).statusCode).toBe(200);
    });
  });

  describe('POST /posts/:id/copy (R26: only readable posts, new owner = actor)', () => {
    const REQ = { newStartDate: '2027-03-10', timeZone: 'Asia/Tokyo' };
    it.each(cells)('%s copies %s post', async (who, v) => {
      const w = await makeWorld();
      const before = dump(w);
      const srcBefore = srcTrip(w);
      const res = await call(w.app, w.actors[who], 'POST', `/api/v1/posts/${w.posts[v].postId}/copy`, REQ);
      if (who === 'anon') {
        expect(res.statusCode).toBe(401);
      } else if (canRead(v, who)) {
        expect(res.statusCode).toBe(201);
        expect(res.json().ownerId).toBe(`user_${{ owner: 'a', member: 'b', other: 'c', removed: 'd' }[who]}`);
        expect(res.json().revision).toBe(1);
        expect(res.json().validationState).toBe('needs_revalidation');
        // The source trip (rows and versions) is byte-identical after the copy.
        expect(srcTrip(w)).toBe(srcBefore);
        // The copy is visible to its new owner and to nobody else.
        const copied = await call(w.app, w.actors[who], 'GET', `/api/v1/trips/${res.json().tripId}`);
        expect(copied.statusCode).toBe(200);
        for (const bad of LEAKS('A')) expect(copied.body).not.toContain(bad);
        const peer = who === 'owner' ? w.actors.member : w.actors.owner;
        expect((await call(w.app, peer, 'GET', `/api/v1/trips/${res.json().tripId}`)).statusCode).toBe(404);
        return;
      } else {
        expect(res.statusCode).toBe(404);
        for (const bad of ['TITLE-A', ...LEAKS('A')]) expect(res.body).not.toContain(bad);
      }
      expect(dump(w)).toBe(before);
    });
  });

  describe('trips PATCH (R20/R30)', () => {
    it.each(ACTORS.map((x) => [x]))('%s PATCHes the owner\'s trip', async (who) => {
      const w = await makeWorld();
      const before = dump(w);
      const res = await call(w.app, w.actors[who], 'PATCH', `/api/v1/trips/${w.tripA.tripId}`, { expectedRevision: 1, operations: [{ op: 'set_title', title: 'HIJACKED' }] });
      if (who === 'owner') return expect(res.statusCode).toBe(200);
      expect(res.statusCode).toBe(denyStatus(who));
      expect(dump(w)).toBe(before);
    });

    it('apply-candidate into another user\'s trip is 404 and leaves that trip untouched', async () => {
      const w = await makeWorld();
      const batchBody = {
        schemaVersion: 1, baseTripId: w.tripA.tripId, baseRevision: 1, generationId: 'gen_acc_x',
        candidates: [{ candidateId: 'c1', title: 'EVIL', days: [{ date: '2026-11-01', timeZone: 'Asia/Tokyo', items: [] }], reasons: [], warnings: [], excludedPlaceIds: [], totalKnownCost: [], hasUnknownCost: false, validationState: 'needs_review' }],
        places: [], constraints: { area: 'Kyoto', startDate: '2026-11-01', endDate: '2026-11-01', timeZone: 'Asia/Tokyo', transportMode: 'transit' },
      };
      for (const who of ['member', 'other', 'removed'] as const) {
        const made = await call(w.app, w.actors[who], 'POST', '/api/v1/plan-batches', batchBody);
        const before = dump(w);
        // Pointing a batch at somebody else's trip is refused up front (404, indistinguishable from a missing trip),
        // so a foreign trip can never be reached through apply-candidate.
        expect(made.statusCode, who).toBe(404);
        const ghost = await call(w.app, w.actors[who], 'POST', '/api/v1/plan-batches', { ...batchBody, baseTripId: 'trip_nope', generationId: 'gen_acc_y' });
        expect(stripReq(made)).toEqual(stripReq(ghost));
        expect(dump(w), who).toBe(before);
        expect(JSON.stringify((await call(w.app, w.actors.owner, 'GET', `/api/v1/trips/${w.tripA.tripId}`)).json())).not.toContain('EVIL');
      }
    });
  });

  describe('POST /posts/preview and /posts (publish)', () => {
    it.each(ACTORS.map((x) => [x]))('%s previews the owner\'s trip', async (who) => {
      const w = await makeWorld();
      const before = dump(w);
      const res = await call(w.app, w.actors[who], 'POST', '/api/v1/posts/preview', { tripId: w.tripA.tripId, sourceRevision: 1, visibility: 'public', groupId: null, story: 'x' });
      if (who === 'owner') return expect(res.statusCode).toBe(200);
      expect(res.statusCode).toBe(denyStatus(who));
      expect(dump(w)).toBe(before);
    });
    it.each(['member', 'other', 'removed'] as const)('%s cannot consume the owner\'s preview token', async (who) => {
      const w = await makeWorld();
      const pv = await call(w.app, w.actors.owner, 'POST', '/api/v1/posts/preview', { tripId: w.tripA.tripId, sourceRevision: 1, visibility: 'public', groupId: null, story: 'x' });
      const before = dump(w);
      const res = await call(w.app, w.actors[who], 'POST', '/api/v1/posts', { previewToken: pv.json().previewToken, confirmed: true });
      expect(res.statusCode).toBe(404);
      expect(dump(w)).toBe(before);
    });
    it('group visibility needs current membership: other/removed get 422 without learning whether the group exists', async () => {
      const w = await makeWorld();
      const ask = (who: Actor, groupId: string) => call(w.app, w.actors[who], 'POST', '/api/v1/posts/preview', { tripId: w.tripC.tripId, sourceRevision: 1, visibility: 'group', groupId, story: 'x' });
      const real = await ask('other', w.gid);
      const ghost = await ask('other', 'grp_nonexistent');
      expect(real.statusCode).toBe(422);
      expect(stripReq(real)).toEqual(stripReq(ghost));
      expect((await call(w.app, w.actors.removed, 'POST', '/api/v1/posts/preview', { tripId: w.tripA.tripId, sourceRevision: 1, visibility: 'group', groupId: w.gid, story: 'x' })).statusCode).toBe(404);
    });
  });

  describe('group invite / accept / remove (R22/R25, K17)', () => {
    it.each(ACTORS.map((x) => [x]))('%s creates an invite', async (who) => {
      const w = await makeWorld();
      const before = dump(w);
      const res = await call(w.app, w.actors[who], 'POST', `/api/v1/groups/${w.gid}/invites`, { inviteeId: 'user_c' });
      const want = who === 'owner' ? 201 : who === 'member' ? 403 : who === 'anon' ? 401 : 404;
      expect(res.statusCode).toBe(want);
      if (want !== 201) {
        expect(res.body).not.toContain('invite#');
        expect(dump(w)).toBe(before);
      }
    });
    it('invite addressed to C cannot be accepted by anybody else; anonymous gets 401; state unchanged until C accepts', async () => {
      const w = await makeWorld();
      const inv = await call(w.app, w.actors.owner, 'POST', `/api/v1/groups/${w.gid}/invites`, { inviteeId: 'user_c' });
      const token = (inv.json().inviteUrl as string).split('#')[1];
      const before = dump(w);
      expect((await call(w.app, w.actors.removed, 'POST', '/api/v1/group-invites/accept', { token })).statusCode).toBe(404);
      expect((await call(w.app, w.actors.member, 'POST', '/api/v1/group-invites/accept', { token })).statusCode).toBe(404);
      expect((await call(w.app, null, 'POST', '/api/v1/group-invites/accept', { token })).statusCode).toBe(401);
      expect(dump(w)).toBe(before);
      // Meanwhile C still cannot read group posts until the intended accept happens.
      expect((await call(w.app, w.actors.other, 'GET', `/api/v1/posts/${w.posts.group.postId}`)).statusCode).toBe(404);
      expect((await call(w.app, w.actors.other, 'POST', '/api/v1/group-invites/accept', { token })).statusCode).toBe(200);
      expect((await call(w.app, w.actors.other, 'GET', `/api/v1/posts/${w.posts.group.postId}`)).statusCode).toBe(200);
    });
    it('a removed member cannot rejoin with an invite that was addressed to them', async () => {
      const w = await makeWorld();
      const inv = await call(w.app, w.actors.owner, 'POST', `/api/v1/groups/${w.gid}/invites`, { inviteeId: 'user_b' });
      const token = (inv.json().inviteUrl as string).split('#')[1];
      expect((await call(w.app, w.actors.owner, 'DELETE', `/api/v1/groups/${w.gid}/members/user_b`)).statusCode).toBe(204);
      const res = await call(w.app, w.actors.member, 'POST', '/api/v1/group-invites/accept', { token });
      // The invite was voided at removal time (consumed): ALREADY_COMMITTED (409); the user stays out.
      expect(res.statusCode).toBe(409);
      expect((await call(w.app, w.actors.member, 'GET', `/api/v1/posts/${w.posts.group.postId}`)).statusCode).toBe(404);
    });
    it.each(ACTORS.map((x) => [x]))('%s removes member B', async (who) => {
      const w = await makeWorld();
      const res = await call(w.app, w.actors[who], 'DELETE', `/api/v1/groups/${w.gid}/members/user_b`);
      const want = who === 'owner' ? 204 : who === 'member' ? 204 /* self-leave */ : who === 'anon' ? 401 : 404;
      expect(res.statusCode).toBe(want);
      const stillIn = (await call(w.app, w.actors.member, 'GET', `/api/v1/posts/${w.posts.group.postId}`)).statusCode === 200;
      expect(stillIn).toBe(!(who === 'owner' || who === 'member'));
    });
    it('a plain member cannot remove another member (403) and nothing changes', async () => {
      const w = await makeWorld();
      const inv = await call(w.app, w.actors.owner, 'POST', `/api/v1/groups/${w.gid}/invites`, { inviteeId: 'user_c' });
      await call(w.app, w.actors.other, 'POST', '/api/v1/group-invites/accept', { token: (inv.json().inviteUrl as string).split('#')[1] });
      const before = dump(w);
      expect((await call(w.app, w.actors.member, 'DELETE', `/api/v1/groups/${w.gid}/members/user_c`)).statusCode).toBe(403);
      expect((await call(w.app, w.actors.member, 'DELETE', `/api/v1/groups/${w.gid}/members/user_a`)).statusCode).toBe(403);
      expect(dump(w)).toBe(before);
    });
  });

  describe('removal takes effect on the very next request (R22, scenario 4)', () => {
    it('member B loses detail, feed, copy and PATCH on the same URLs right after removal; public stays readable', async () => {
      const w = await makeWorld();
      const gUrl = `/api/v1/posts/${w.posts.group.postId}`;
      expect((await call(w.app, w.actors.member, 'GET', gUrl)).statusCode).toBe(200);
      expect((await call(w.app, w.actors.member, 'GET', '/api/v1/posts?scope=groups')).json().items).toHaveLength(1);
      expect((await call(w.app, w.actors.owner, 'DELETE', `/api/v1/groups/${w.gid}/members/user_b`)).statusCode).toBe(204);
      const after = await call(w.app, w.actors.member, 'GET', gUrl);
      expect(after.statusCode).toBe(404);
      expect(after.body).not.toContain('STORY-group');
      const feed = await call(w.app, w.actors.member, 'GET', '/api/v1/posts?scope=groups');
      expect(feed.json().items).toEqual([]);
      expect(feed.body).not.toContain('STORY-group');
      expect((await call(w.app, w.actors.member, 'POST', `${gUrl}/copy`, { newStartDate: '2027-03-10', timeZone: 'Asia/Tokyo' })).statusCode).toBe(404);
      expect((await call(w.app, w.actors.member, 'PATCH', gUrl, { expectedPostRevision: 1, story: 'x' })).statusCode).toBe(404);
      expect((await call(w.app, w.actors.member, 'GET', `/api/v1/posts/${w.posts.public.postId}`)).statusCode).toBe(200);
      expect((await call(w.app, w.actors.member, 'GET', `/api/v1/posts/${w.posts.private.postId}`)).statusCode).toBe(404);
    });
    it('owner turning a post private hides it from members at once, and re-sharing restores it', async () => {
      const w = await makeWorld();
      const url = `/api/v1/posts/${w.posts.group.postId}`;
      const r = await call(w.app, w.actors.owner, 'PATCH', url, { expectedPostRevision: 1, visibility: 'private', groupId: null });
      expect(r.statusCode).toBe(200);
      expect((await call(w.app, w.actors.member, 'GET', url)).statusCode).toBe(404);
      expect((await call(w.app, w.actors.member, 'GET', '/api/v1/posts?scope=groups')).json().items).toEqual([]);
      const back = await call(w.app, w.actors.owner, 'PATCH', url, { expectedPostRevision: 2, visibility: 'group', groupId: w.gid });
      expect(back.statusCode).toBe(200);
      expect((await call(w.app, w.actors.member, 'GET', url)).statusCode).toBe(200);
      expect((await call(w.app, w.actors.removed, 'GET', url)).statusCode).toBe(404);
    });
  });

  describe('group listing and logout', () => {
    it('GET /groups shows the group only to current members', async () => {
      const w = await makeWorld();
      for (const who of ['owner', 'member'] as const) {
        const res = await call(w.app, w.actors[who], 'GET', '/api/v1/groups');
        expect((res.json() as { groupId: string }[]).map((g) => g.groupId)).toContain(w.gid);
      }
      for (const who of ['other', 'removed'] as const) {
        const res = await call(w.app, w.actors[who], 'GET', '/api/v1/groups');
        expect(res.statusCode).toBe(200);
        expect(res.body).not.toContain(w.gid);
      }
    });
    it('after logout the old session is 401 everywhere and group posts are no longer readable with it', async () => {
      const w = await makeWorld();
      const b = w.actors.member!;
      expect((await call(w.app, b, 'POST', '/api/v1/auth/logout')).statusCode).toBe(204);
      expect((await call(w.app, b, 'GET', '/api/v1/trips')).statusCode).toBe(401);
      expect((await call(w.app, b, 'GET', '/api/v1/posts?scope=groups')).statusCode).toBe(401);
      expect((await call(w.app, b, 'GET', `/api/v1/posts/${w.posts.group.postId}`)).statusCode).toBe(404);
      expect((await call(w.app, b, 'POST', `/api/v1/posts/${w.posts.public.postId}/copy`, { newStartDate: '2027-03-10', timeZone: 'Asia/Tokyo' })).statusCode).toBe(401);
    });
  });

  describe('CSRF: valid session cookie without the token is 403 on every state-changing route', () => {
    it('every mutating route rejects and changes nothing', async () => {
      const w = await makeWorld();
      const before = dump(w);
      const a = w.actors.owner!;
      const rid = w.posts.public.postId;
      const calls: [Parameters<typeof callNoCsrf>[2], string, unknown][] = [
        ['POST', '/api/v1/plan-batches', {}],
        ['POST', '/api/v1/trips/apply-candidate', {}],
        ['PATCH', `/api/v1/trips/${w.tripA.tripId}`, { expectedRevision: 1, operations: [{ op: 'set_title', title: 'X' }] }],
        ['POST', '/api/v1/posts/preview', { tripId: w.tripA.tripId, sourceRevision: 1, visibility: 'public', groupId: null, story: 'x' }],
        ['POST', '/api/v1/posts', { previewToken: 'x'.repeat(32), confirmed: true }],
        ['PATCH', `/api/v1/posts/${rid}`, { expectedPostRevision: 1, story: 'X' }],
        ['DELETE', `/api/v1/posts/${rid}`, undefined],
        ['POST', `/api/v1/posts/${rid}/copy`, { newStartDate: '2027-03-10', timeZone: 'Asia/Tokyo' }],
        ['POST', '/api/v1/groups', { name: 'x' }],
        ['POST', `/api/v1/groups/${w.gid}/invites`, {}],
        ['POST', '/api/v1/group-invites/accept', { token: 'x' }],
        ['DELETE', `/api/v1/groups/${w.gid}/members/user_b`, undefined],
      ];
      for (const [m, url, body] of calls) {
        const res = await callNoCsrf(w.app, a, m, url, body);
        expect(res.statusCode, `${m} ${url}`).toBe(403);
      }
      expect(dump(w)).toBe(before);
    });
  });

  describe('anonymous: every authenticated route is 401, only public reads are open', () => {
    it('no route answers an anonymous caller with data', async () => {
      const w = await makeWorld();
      const rid = w.posts.public.postId;
      const calls: [Parameters<typeof call>[2], string, unknown][] = [
        ['GET', '/api/v1/trips', undefined],
        ['GET', `/api/v1/trips/${w.tripA.tripId}`, undefined],
        ['GET', '/api/v1/plan-batches/x', undefined],
        ['POST', '/api/v1/plan-batches', {}],
        ['POST', '/api/v1/trips/apply-candidate', {}],
        ['PATCH', `/api/v1/trips/${w.tripA.tripId}`, {}],
        ['POST', '/api/v1/posts/preview', {}],
        ['POST', '/api/v1/posts', {}],
        ['PATCH', `/api/v1/posts/${rid}`, {}],
        ['DELETE', `/api/v1/posts/${rid}`, undefined],
        ['POST', `/api/v1/posts/${rid}/copy`, {}],
        ['GET', '/api/v1/groups', undefined],
        ['POST', '/api/v1/groups', {}],
        ['POST', `/api/v1/groups/${w.gid}/invites`, {}],
        ['POST', '/api/v1/group-invites/accept', {}],
        ['DELETE', `/api/v1/groups/${w.gid}/members/user_b`, undefined],
        ['GET', '/api/v1/auth/me', undefined],
      ];
      for (const [m, url, body] of calls) {
        const res = await call(w.app, null, m, url, body);
        expect(res.statusCode, `${m} ${url}`).toBe(401);
        for (const bad of ['TITLE-A', 'STORY-', ...LEAKS('A')]) expect(res.body).not.toContain(bad);
      }
      expect((await call(w.app, null, 'GET', '/api/v1/posts?scope=public')).statusCode).toBe(200);
      expect((await call(w.app, null, 'GET', `/api/v1/posts/${rid}`)).statusCode).toBe(200);
    });
  });
});

describe('two sessions of one user conflict on the same trip (acceptance scenario 2)', () => {
  it('second PATCH at the stale revision is 409, and the winner\'s data is untouched', async () => {
    const w = await makeWorld();
    const { app, tripA } = w;
    const s1 = w.actors.owner!;
    const s2 = await login(app, 'user-a');
    const url = `/api/v1/trips/${tripA.tripId}`;
    const r1 = await call(app, s1, 'PATCH', url, { expectedRevision: 1, operations: [{ op: 'set_title', title: 'FROM-SESSION-1' }] });
    expect(r1.statusCode).toBe(200);
    const mid = JSON.stringify((await call(app, s1, 'GET', url)).json());
    const r2 = await call(app, s2, 'PATCH', url, { expectedRevision: 1, operations: [{ op: 'set_title', title: 'FROM-SESSION-2' }] });
    expect(r2.statusCode).toBe(409);
    expect(r2.json()).toMatchObject({ code: 'REVISION_CONFLICT', details: { expectedRevision: 1, currentRevision: 2 } });
    const now = (await call(app, s2, 'GET', url)).json();
    expect(JSON.stringify(now)).toBe(mid);
    expect(now.title).toBe('FROM-SESSION-1');
    expect(now.revision).toBe(2);
    expect(r2.body).not.toContain('FROM-SESSION-2');
  });

  it('applying a candidate generated for revision 1 after the other session saved is 409 and leaves the trip as is', async () => {
    const w = await makeWorld();
    const { app, tripA } = w;
    const s1 = w.actors.owner!;
    const s2 = await login(app, 'user-a');
    const url = `/api/v1/trips/${tripA.tripId}`;
    const mk = await call(app, s2, 'POST', '/api/v1/plan-batches', {
      schemaVersion: 1, baseTripId: tripA.tripId, baseRevision: 1, generationId: 'gen_acc_conflict',
      candidates: [{ candidateId: 'c1', title: 'FROM-CANDIDATE', days: [{ date: '2026-11-01', timeZone: 'Asia/Tokyo', items: [] }], reasons: [], warnings: [], excludedPlaceIds: [], totalKnownCost: [], hasUnknownCost: false, validationState: 'needs_review' }],
      places: [], constraints: { area: 'Kyoto', startDate: '2026-11-01', endDate: '2026-11-01', timeZone: 'Asia/Tokyo', transportMode: 'transit' },
    });
    expect(mk.statusCode).toBe(201);
    expect((await call(app, s1, 'PATCH', url, { expectedRevision: 1, operations: [{ op: 'set_title', title: 'FROM-SESSION-1' }] })).statusCode).toBe(200);
    const mid = JSON.stringify((await call(app, s1, 'GET', url)).json());
    const rows = dump(w);
    const res = await call(app, s2, 'POST', '/api/v1/trips/apply-candidate', { batchId: mk.json().batchId, candidateId: 'c1', tripId: tripA.tripId, expectedRevision: 1 });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(JSON.stringify((await call(app, s2, 'GET', url)).json())).toBe(mid);
    expect(dump(w)).toBe(rows);
  });
});
