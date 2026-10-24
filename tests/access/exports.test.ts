// T03 addendum for E02 / K18 PDF export (owner only). Written from docs/03_CONTRACTS.md K18, not from the implementation.
// Actors as in matrix.test.ts: anon, owner(A), member(B), other(C), removed(D). Exports are never shared:
// groups and posts do not widen access, so every non-owner (and anon) is denied exactly like a missing id.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertTrip } from '@tkb/db';
import { ACTORS, call, callNoCsrf, closeAll, makeWorld, secretTrip, stripReq, type Actor, type Session, type World } from './helpers.ts';

afterAll(closeAll);
const denyStatus = (who: Actor) => (who === 'anon' ? 401 : 404);
const BODY = { expectedRevision: 1, format: 'pdf' };
const NOW = '2026-10-24T03:00:00Z';
const pdfPath = (id: string) => `/api/v1/exports/${id}`;

/** Polls until the export is a PDF (the real renderer runs; no fake). */
async function ready(w: World, s: Session, id: string) {
  for (let i = 0; i < 200; i++) {
    const res = await call(w.app, s, 'GET', pdfPath(id));
    if (res.headers['content-type'] === 'application/pdf') return res;
    expect(res.json().status, JSON.stringify(res.json())).toBe('queued');
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('export never became ready');
}
async function mk(w: World, s: Session, tripId: string) {
  const res = await call(w.app, s, 'POST', `/api/v1/trips/${tripId}/exports`, BODY);
  expect(res.statusCode, res.body).toBe(202);
  return res.json().exportId as string;
}
const addTrip = (w: World, owner: string, id: string) => insertTrip(w.db, owner, secretTrip(id, 'X'), NOW);
const dropTrip = (w: World, id: string) => {
  w.db.prepare('DELETE FROM trip_versions WHERE trip_id = ?').run(id);
  w.db.prepare('DELETE FROM trips WHERE id = ?').run(id);
};

describe('PDF export access (K18): actor x operation', () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it('owner can create, fetch and delete an export (control)', async () => {
    const id = await mk(w, w.actors.owner!, w.tripA.tripId);
    const res = await ready(w, w.actors.owner!, id);
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    expect(res.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect((await call(w.app, w.actors.owner, 'DELETE', pdfPath(id))).statusCode).toBe(204);
  });

  describe.each(ACTORS.filter((a) => a !== 'owner').map((a) => [a]))('%s', (who) => {
    it('cannot create an export for the owner trip (404 same as a missing trip; anonymous 401)', async () => {
      const res = await call(w.app, w.actors[who], 'POST', `/api/v1/trips/${w.tripA.tripId}/exports`, BODY);
      expect(res.statusCode).toBe(denyStatus(who));
      for (const bad of ['TITLE-A', 'NOTE-A', 'HOME-A', 'attachment']) expect(res.body).not.toContain(bad);
      if (who !== 'anon') {
        expect(stripReq(res)).toEqual(stripReq(await call(w.app, w.actors[who], 'POST', '/api/v1/trips/trip_nope/exports', BODY)));
      }
    });
    it('cannot GET or DELETE the owner export (404 same as a missing export; anonymous 401) and it survives', async () => {
      const id = await mk(w, w.actors.owner!, w.tripA.tripId);
      await ready(w, w.actors.owner!, id);
      for (const method of ['GET', 'DELETE'] as const) {
        const res = await call(w.app, w.actors[who], method, pdfPath(id));
        expect(res.statusCode, method).toBe(denyStatus(who));
        expect(res.headers['content-type']).not.toBe('application/pdf');
        expect(res.headers['content-disposition']).toBeUndefined();
        if (who !== 'anon') {
          expect(stripReq(res), method).toEqual(stripReq(await call(w.app, w.actors[who], method, pdfPath('export_nope'))));
        }
      }
      // A failed DELETE by the other party must not have removed it.
      expect((await call(w.app, w.actors.owner, 'GET', pdfPath(id))).headers['content-type']).toBe('application/pdf');
      expect((await call(w.app, w.actors.owner, 'DELETE', pdfPath(id))).statusCode).toBe(204);
    });
  });

  it('a group member and a post viewer cannot export the owner trip although posts of it are visible to them', async () => {
    // makeWorld published A's trip as private/group/public posts; their readers get no export right.
    for (const who of ['member', 'other', 'removed'] as const) {
      const res = await call(w.app, w.actors[who], 'POST', `/api/v1/trips/${w.tripA.tripId}/exports`, BODY);
      expect(res.statusCode, who).toBe(404);
    }
    expect((await call(w.app, w.actors.member, 'GET', `/api/v1/posts/${w.posts.group.postId}`)).statusCode).toBe(200);
    expect((await call(w.app, w.actors.other, 'GET', `/api/v1/posts/${w.posts.public.postId}`)).statusCode).toBe(200);
    // A post id or a group id is not a trip id, not even for the owner.
    for (const id of [w.posts.public.postId, w.posts.group.postId, w.gid]) {
      for (const who of ['owner', 'member'] as const) {
        expect((await call(w.app, w.actors[who], 'POST', `/api/v1/trips/${id}/exports`, BODY)).statusCode, id).toBe(404);
      }
    }
    // An export id of the owner is not readable by those viewers.
    const id = await mk(w, w.actors.owner!, w.tripA.tripId);
    await ready(w, w.actors.owner!, id);
    for (const who of ['member', 'other', 'removed'] as const) {
      expect((await call(w.app, w.actors[who], 'GET', pdfPath(id))).statusCode, who).toBe(404);
    }
    await call(w.app, w.actors.owner, 'DELETE', pdfPath(id));
  });

  it("each user's export is theirs only", async () => {
    const idC = await mk(w, w.actors.other!, w.tripC.tripId);
    await ready(w, w.actors.other!, idC);
    expect((await call(w.app, w.actors.owner, 'GET', pdfPath(idC))).statusCode).toBe(404);
    expect((await call(w.app, w.actors.owner, 'DELETE', pdfPath(idC))).statusCode).toBe(404);
    expect((await call(w.app, w.actors.other, 'POST', `/api/v1/trips/${w.tripA.tripId}/exports`, BODY)).statusCode).toBe(404);
    expect((await call(w.app, w.actors.other, 'GET', pdfPath(idC))).headers['content-type']).toBe('application/pdf');
    await call(w.app, w.actors.other, 'DELETE', pdfPath(idC));
  });

  it('anonymous requests get 401 without any state change; a missing CSRF header is 403 for a signed-in user', async () => {
    const id = await mk(w, w.actors.owner!, w.tripA.tripId);
    await ready(w, w.actors.owner!, id);
    expect((await call(w.app, null, 'GET', pdfPath(id))).statusCode).toBe(401);
    expect((await call(w.app, null, 'DELETE', pdfPath(id))).statusCode).toBe(401);
    expect((await callNoCsrf(w.app, w.actors.owner!, 'DELETE', pdfPath(id))).statusCode).toBe(403);
    expect((await callNoCsrf(w.app, w.actors.owner!, 'POST', `/api/v1/trips/${w.tripA.tripId}/exports`, BODY)).statusCode).toBe(403);
    expect((await call(w.app, w.actors.owner, 'GET', pdfPath(id))).headers['content-type']).toBe('application/pdf');
    await call(w.app, w.actors.owner, 'DELETE', pdfPath(id));
  });

  it('after the owner deletes the export it is 404 for everyone, including the owner', async () => {
    const id = await mk(w, w.actors.owner!, w.tripA.tripId);
    await ready(w, w.actors.owner!, id);
    expect((await call(w.app, w.actors.owner, 'DELETE', pdfPath(id))).statusCode).toBe(204);
    for (const who of ACTORS) {
      for (const method of ['GET', 'DELETE'] as const) {
        expect((await call(w.app, w.actors[who], method, pdfPath(id))).statusCode, `${who} ${method}`).toBe(denyStatus(who));
      }
    }
  });

  it('after the trip is deleted its exports are 404 for the owner and nobody can create a new one', async () => {
    addTrip(w, 'user_a', 'trip_acc_gone');
    const id = await mk(w, w.actors.owner!, 'trip_acc_gone');
    await ready(w, w.actors.owner!, id);
    dropTrip(w, 'trip_acc_gone');
    expect((await call(w.app, w.actors.owner, 'GET', pdfPath(id))).statusCode).toBe(404);
    expect((await call(w.app, w.actors.owner, 'GET', pdfPath(id))).statusCode).toBe(404); // forgotten, not just hidden once
    expect((await call(w.app, w.actors.owner, 'DELETE', pdfPath(id))).statusCode).toBe(404);
    for (const who of ['owner', 'member', 'other'] as const) {
      expect((await call(w.app, w.actors[who], 'POST', '/api/v1/trips/trip_acc_gone/exports', BODY)).statusCode, who).toBe(404);
    }
  });

  it('leaving or being removed from a group changes nothing for exports (owner-only)', async () => {
    addTrip(w, 'user_b', 'trip_acc_b');
    const idB = await mk(w, w.actors.member!, 'trip_acc_b');
    await ready(w, w.actors.member!, idB);
    const idA = await mk(w, w.actors.owner!, w.tripA.tripId);
    await ready(w, w.actors.owner!, idA);
    expect((await call(w.app, w.actors.member, 'GET', pdfPath(idA))).statusCode).toBe(404);

    expect((await call(w.app, w.actors.member, 'DELETE', `/api/v1/groups/${w.gid}/members/user_b`)).statusCode).toBe(204); // B leaves
    // B keeps their own export; A's export is still not B's and still A's.
    expect((await call(w.app, w.actors.member, 'GET', pdfPath(idB))).headers['content-type']).toBe('application/pdf');
    expect((await call(w.app, w.actors.member, 'GET', pdfPath(idA))).statusCode).toBe(404);
    expect((await call(w.app, w.actors.member, 'POST', `/api/v1/trips/${w.tripA.tripId}/exports`, BODY)).statusCode).toBe(404);
    expect((await call(w.app, w.actors.owner, 'GET', pdfPath(idA))).headers['content-type']).toBe('application/pdf');
    expect((await call(w.app, w.actors.removed, 'GET', pdfPath(idA))).statusCode).toBe(404);
    await call(w.app, w.actors.member, 'DELETE', pdfPath(idB));
    await call(w.app, w.actors.owner, 'DELETE', pdfPath(idA));
  });
});
