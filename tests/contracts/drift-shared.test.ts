// T01 contract <-> implementation drift, shared server (buildApp on :memory:). Every route is exercised through
// HTTP and its response is parsed with the schema of docs/03_CONTRACTS.md; every error must be an ApiError whose
// status is ERROR_HTTP_STATUS[code] (K23). Not repeated here: who may see what (tests/access), leakage (tests/security).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Capabilities, CopyResult, Feed, Group, GroupInviteCreated, Health, LoginResponse, Membership, Post, PostPreview, PlanBatch,
  PlanBatchCreated, SCHEMA_VERSION, Trip, TripList, TripPatchResult, TripWriteResult,
} from '@tkb/contracts';
import { createSamplePlanBatch, domesticTrip } from '@tkb/fixtures';
import { call, closeAll, makeWorld, type World } from '../access/helpers.ts';
import { expectErr, expectOk } from './helpers.ts';

afterAll(closeAll);

describe('shared server: success responses match the contract', () => {
  let w: World;
  const owner = () => w.actors.owner!;
  beforeAll(async () => { w = await makeWorld(); });
  const batchBody = (over: Record<string, unknown> = {}) => {
    const b = createSamplePlanBatch();
    return {
      schemaVersion: SCHEMA_VERSION, baseTripId: null, baseRevision: null, generationId: `gen_${Math.random().toString(36).slice(2, 10)}`,
      candidates: b.candidates, places: b.places, constraints: domesticTrip.constraints, ...over,
    };
  };

  it('GET /api/v1/health (K22 companion) is Health with service=shared', async () => {
    const h = expectOk('health', await call(w.app, null, 'GET', '/api/v1/health'), 200, Health);
    expect(h.service).toBe('shared');
    expect(h.schemaVersion).toBe(SCHEMA_VERSION);
  });
  it('GET /api/v1/capabilities (K22): shared entry never offers personal Claude', async () => {
    const c = expectOk('capabilities', await call(w.app, null, 'GET', '/api/v1/capabilities'), 200, Capabilities);
    expect(c).toMatchObject({ entry: 'shared', aiGeneration: { available: false, runner: 'none', reason: 'SHARED_ENTRY_NO_PERSONAL_CLAUDE' }, storage: 'shared-server' });
  });
  it('POST /api/v1/auth/login (K11) and GET /auth/me return LoginResponse; me re-issues the same csrf token', async () => {
    const login = expectOk('login', await w.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { loginId: 'user-a', password: 'correct horse battery' } }), 200, LoginResponse);
    expect(login.userId).toBe('user_a');
    const me = expectOk('me', await call(w.app, owner(), 'GET', '/api/v1/auth/me'), 200, LoginResponse);
    expect(me).toMatchObject({ userId: 'user_a', csrfToken: owner().csrf });
  });
  it('trips: GET list, GET one, PATCH, apply-candidate (K07-K10)', async () => {
    const list = expectOk('trips', await call(w.app, owner(), 'GET', '/api/v1/trips'), 200, TripList);
    expect(list.items.map(i => i.tripId)).toContain('trip_acc_a');
    const one = expectOk('trip', await call(w.app, owner(), 'GET', '/api/v1/trips/trip_acc_a'), 200, Trip);
    expect(one.ownerId).toBe('user_a');

    // K07 create (201), replay with the same body (200), different body (409 IDEMPOTENCY_CONFLICT)
    const body = batchBody();
    const created = expectOk('plan-batches 201', await call(w.app, owner(), 'POST', '/api/v1/plan-batches', body), 201, PlanBatchCreated);
    expect(created.candidateIds).toEqual(body.candidates.map(c => c.candidateId));
    // The server never stores a client-claimed "valid" (K07): the batch is capped at needs_review.
    expect(created.validationState).toBe('needs_review');
    const replay = expectOk('plan-batches replay', await call(w.app, owner(), 'POST', '/api/v1/plan-batches', body), 200, PlanBatchCreated);
    expect(replay.batchId).toBe(created.batchId);
    expectErr('plan-batches generationId reuse', await call(w.app, owner(), 'POST', '/api/v1/plan-batches', { ...body, candidates: body.candidates.slice(0, 1) }), 'IDEMPOTENCY_CONFLICT');

    const batch = expectOk('plan-batch', await call(w.app, owner(), 'GET', `/api/v1/plan-batches/${created.batchId}`), 200, PlanBatch);
    expect(batch.candidates.every(c => c.validationState !== 'valid')).toBe(true);

    // K08 new trip (201) and the same candidate again (200, same trip)
    const req = { batchId: created.batchId, candidateId: created.candidateIds[0], tripId: null, expectedRevision: null };
    const first = expectOk('apply 201', await call(w.app, owner(), 'POST', '/api/v1/trips/apply-candidate', req), 201, TripWriteResult);
    expect(first.revision).toBe(1);
    const again = expectOk('apply again', await call(w.app, owner(), 'POST', '/api/v1/trips/apply-candidate', req), 200, TripWriteResult);
    expect(again.tripId).toBe(first.tripId);

    // K10 PATCH: set_title keeps validationState, bumps revision, diff is the K10 shape
    const patched = expectOk('patch', await call(w.app, owner(), 'PATCH', `/api/v1/trips/${first.tripId}`, { expectedRevision: 1, operations: [{ op: 'set_title', title: 'renamed' }] }), 200, TripPatchResult);
    expect(patched).toMatchObject({ tripId: first.tripId, revision: 2 });
    expect(patched.trip.title).toBe('renamed');
    expect(patched.diff.knownCostDelta).toEqual([]);
    // an itinerary change makes the trip needs_revalidation and adds a warning
    const removed = expectOk('patch remove', await call(w.app, owner(), 'PATCH', `/api/v1/trips/${first.tripId}`, { expectedRevision: 2, operations: [{ op: 'remove', itemId: 'fx_act_omicho' }] }), 200, TripPatchResult);
    expect(removed.trip.validationState).toBe('needs_revalidation');
    expect(removed.warnings.length).toBeGreaterThan(first.warnings.length);

    // K08 onto an existing trip needs a batch generated for it
    const forTrip = expectOk('plan-batches for trip', await call(w.app, owner(), 'POST', '/api/v1/plan-batches', batchBody({ baseTripId: first.tripId, baseRevision: 3 })), 201, PlanBatchCreated);
    const upd = expectOk('apply to trip', await call(w.app, owner(), 'POST', '/api/v1/trips/apply-candidate', { batchId: forTrip.batchId, candidateId: forTrip.candidateIds[0], tripId: first.tripId, expectedRevision: 3 }), 200, TripWriteResult);
    expect(upd.revision).toBe(4);
  });
  it('trips list paginates with an opaque cursor and the last page has nextCursor null', async () => {
    const page1 = expectOk('page 1', await call(w.app, owner(), 'GET', '/api/v1/trips?limit=1'), 200, TripList);
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = expectOk('page 2', await call(w.app, owner(), 'GET', `/api/v1/trips?limit=1&cursor=${page1.nextCursor}`), 200, TripList);
    expect(page2.items[0]!.tripId).not.toBe(page1.items[0]!.tripId);
    const all = expectOk('all', await call(w.app, owner(), 'GET', '/api/v1/trips?limit=100'), 200, TripList);
    expect(all.nextCursor).toBeNull();
  });
  it('posts: preview, create, detail, feed (three scopes), patch, delete (K12-K15)', async () => {
    const pv = expectOk('preview', await call(w.app, owner(), 'POST', '/api/v1/posts/preview', { tripId: 'trip_acc_a', sourceRevision: 1, visibility: 'public', story: 's' }), 200, PostPreview);
    expect(pv.redactedFields.length).toBeGreaterThan(0);
    const post = expectOk('create', await call(w.app, owner(), 'POST', '/api/v1/posts', { previewToken: pv.previewToken, confirmed: true }), 201, Post);
    expect(post.postRevision).toBe(1);
    expectOk('detail', await call(w.app, null, 'GET', `/api/v1/posts/${post.postId}`), 200, Post);
    for (const scope of ['public', 'groups', 'mine'] as const) {
      const f = expectOk(`feed ${scope}`, await call(w.app, owner(), 'GET', `/api/v1/posts?scope=${scope}`), 200, Feed);
      expect(f.items.length).toBeGreaterThan(0);
    }
    const f1 = expectOk('feed limit 1', await call(w.app, owner(), 'GET', '/api/v1/posts?scope=mine&limit=1'), 200, Feed);
    expect(f1.nextCursor).not.toBeNull();
    expectOk('feed page 2', await call(w.app, owner(), 'GET', `/api/v1/posts?scope=mine&limit=1&cursor=${f1.nextCursor}`), 200, Feed);
    const patched = expectOk('post patch', await call(w.app, owner(), 'PATCH', `/api/v1/posts/${post.postId}`, { expectedPostRevision: 1, story: 'edited' }), 200, Post);
    expect(patched).toMatchObject({ postRevision: 2, story: 'edited' });
    expect((await call(w.app, owner(), 'DELETE', `/api/v1/posts/${post.postId}`)).statusCode).toBe(204);
  });
  it('copy (K16) returns CopyResult revision 1, needs_revalidation, owned by the copier', async () => {
    const r = expectOk('copy', await call(w.app, w.actors.other, 'POST', `/api/v1/posts/${w.posts.public.postId}/copy`, { newStartDate: '2027-01-10', timeZone: 'Asia/Tokyo' }), 201, CopyResult);
    expect(r).toMatchObject({ ownerId: 'user_c', revision: 1, validationState: 'needs_revalidation' });
    const trip = expectOk('copied trip', await call(w.app, w.actors.other, 'GET', `/api/v1/trips/${r.tripId}`), 200, Trip);
    expect(trip.constraints.startDate).toBe('2027-01-10');
  });
  it('groups (K17): create 201, list, invite 201, accept 200, remove member 204', async () => {
    const g = expectOk('group', await call(w.app, owner(), 'POST', '/api/v1/groups', { name: 'drift' }), 201, Group);
    expect(g.role).toBe('owner');
    const list = await call(w.app, owner(), 'GET', '/api/v1/groups');
    expect(list.statusCode).toBe(200);
    for (const item of list.json() as unknown[]) Group.parse(item);
    const inv = expectOk('invite', await call(w.app, owner(), 'POST', `/api/v1/groups/${g.groupId}/invites`, { inviteeId: 'user_c' }), 201, GroupInviteCreated);
    const m = expectOk('accept', await call(w.app, w.actors.other, 'POST', '/api/v1/group-invites/accept', { token: inv.inviteUrl.split('#')[1] }), 200, Membership);
    expect(m).toMatchObject({ groupId: g.groupId, userId: 'user_c', membership: 'active' });
    expect((await call(w.app, owner(), 'DELETE', `/api/v1/groups/${g.groupId}/members/user_c`)).statusCode).toBe(204);
  });
});

describe('shared server: every error is an ApiError with the K23 status', () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });
  const sample = () => createSamplePlanBatch();
  const goodBatch = (over: Record<string, unknown> = {}) => ({
    schemaVersion: 1, baseTripId: null, baseRevision: null, generationId: `gen_${Math.random().toString(36).slice(2, 10)}`,
    candidates: sample().candidates, places: sample().places, constraints: domesticTrip.constraints, ...over,
  });
  type Row = [label: string, run: () => Promise<Parameters<typeof expectErr>[1]>, code: Parameters<typeof expectErr>[2]];
  const rows = (): Row[] => {
    const o = w.actors.owner, c = w.actors.other, a = w.app;
    const apply = { batchId: 'nope', candidateId: 'x', tripId: null, expectedRevision: null };
    return [
      ['anon trips', () => call(a, null, 'GET', '/api/v1/trips'), 'UNAUTHENTICATED'],
      ['anon me', () => call(a, null, 'GET', '/api/v1/auth/me'), 'UNAUTHENTICATED'],
      ['anon feed groups', () => call(a, null, 'GET', '/api/v1/posts?scope=groups'), 'UNAUTHENTICATED'],
      ['bad login', () => a.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { loginId: 'user-a', password: 'wrong' } }), 'UNAUTHENTICATED'],
      ['login unknown key', () => a.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { loginId: 'user-a', password: 'x', extra: 1 } }), 'VALIDATION_FAILED'],
      ['no csrf', () => a.inject({ method: 'POST', url: '/api/v1/groups', payload: { name: 'x' }, headers: { cookie: o!.cookie } }), 'FORBIDDEN'],
      ['unknown route', () => call(a, o, 'GET', '/api/v1/nope'), 'NOT_FOUND'],
      ['wrong method', () => a.inject({ method: 'PUT', url: '/api/v1/trips', payload: {}, headers: { cookie: o!.cookie, 'x-csrf-token': o!.csrf } }), 'NOT_FOUND'],
      ['trip of another user', () => call(a, c, 'GET', `/api/v1/trips/${w.tripA.tripId}`), 'NOT_FOUND'],
      ['id over 128 chars', () => call(a, o, 'GET', `/api/v1/trips/${'x'.repeat(200)}`), 'NOT_FOUND'],
      ['bad list limit', () => call(a, o, 'GET', '/api/v1/trips?limit=0'), 'VALIDATION_FAILED'],
      ['bad list cursor', () => call(a, o, 'GET', '/api/v1/trips?cursor=%%%'), 'VALIDATION_FAILED'],
      ['unknown list query', () => call(a, o, 'GET', '/api/v1/trips?x=1'), 'VALIDATION_FAILED'],
      ['plan-batches invalid body', () => call(a, o, 'POST', '/api/v1/plan-batches', { schemaVersion: 2 }), 'VALIDATION_FAILED'],
      ['plan-batches schemaVersion 2', () => call(a, o, 'POST', '/api/v1/plan-batches', goodBatch({ schemaVersion: 2 })), 'VALIDATION_FAILED'],
      ['plan-batches duplicate candidateId', () => { const cs = sample().candidates; return call(a, o, 'POST', '/api/v1/plan-batches', goodBatch({ candidates: [cs[0], cs[0]] })); }, 'VALIDATION_FAILED'],
      ['plan-batches base of another user', () => call(a, c, 'POST', '/api/v1/plan-batches', goodBatch({ baseTripId: w.tripA.tripId, baseRevision: 1 })), 'NOT_FOUND'],
      ['plan-batches stale base', () => call(a, o, 'POST', '/api/v1/plan-batches', goodBatch({ baseTripId: w.tripA.tripId, baseRevision: 9 })), 'REVISION_CONFLICT'],
      ['plan-batches no base but revision', () => call(a, o, 'POST', '/api/v1/plan-batches', goodBatch({ baseRevision: 1 })), 'VALIDATION_FAILED'],
      ['plan-batch missing', () => call(a, o, 'GET', '/api/v1/plan-batches/nope'), 'NOT_FOUND'],
      ['apply unknown batch', () => call(a, o, 'POST', '/api/v1/trips/apply-candidate', apply), 'NOT_FOUND'],
      ['apply unknown key', () => call(a, o, 'POST', '/api/v1/trips/apply-candidate', { ...apply, ownerId: 'x' }), 'VALIDATION_FAILED'],
      ['patch missing trip', () => call(a, o, 'PATCH', '/api/v1/trips/nope', { expectedRevision: 1, operations: [{ op: 'set_title', title: 't' }] }), 'NOT_FOUND'],
      ['patch stale revision', () => call(a, o, 'PATCH', `/api/v1/trips/${w.tripA.tripId}`, { expectedRevision: 9, operations: [{ op: 'set_title', title: 't' }] }), 'REVISION_CONFLICT'],
      ['patch empty operations', () => call(a, o, 'PATCH', `/api/v1/trips/${w.tripA.tripId}`, { expectedRevision: 1, operations: [] }), 'VALIDATION_FAILED'],
      ['patch unsatisfiable op', () => call(a, o, 'PATCH', `/api/v1/trips/${w.tripA.tripId}`, { expectedRevision: 1, operations: [{ op: 'remove', itemId: 'nope' }] }), 'CONSTRAINT_UNSATISFIED'],
      ['preview of another user trip', () => call(a, c, 'POST', '/api/v1/posts/preview', { tripId: w.tripA.tripId, sourceRevision: 1, visibility: 'public', story: 's' }), 'NOT_FOUND'],
      ['preview stale revision', () => call(a, o, 'POST', '/api/v1/posts/preview', { tripId: w.tripA.tripId, sourceRevision: 9, visibility: 'public', story: 's' }), 'REVISION_CONFLICT'],
      ['preview group without groupId', () => call(a, o, 'POST', '/api/v1/posts/preview', { tripId: w.tripA.tripId, sourceRevision: 1, visibility: 'group', story: 's' }), 'VALIDATION_FAILED'],
      ['create with unknown token', () => call(a, o, 'POST', '/api/v1/posts', { previewToken: 'x'.repeat(24), confirmed: true }), 'NOT_FOUND'],
      ['create not confirmed', () => call(a, o, 'POST', '/api/v1/posts', { previewToken: 'x'.repeat(24), confirmed: false }), 'VALIDATION_FAILED'],
      ['feed bad scope', () => call(a, o, 'GET', '/api/v1/posts?scope=all'), 'VALIDATION_FAILED'],
      ['feed bad limit', () => call(a, o, 'GET', '/api/v1/posts?scope=public&limit=21'), 'VALIDATION_FAILED'],
      ['feed bad cursor', () => call(a, o, 'GET', '/api/v1/posts?scope=public&cursor=zzz'), 'VALIDATION_FAILED'],
      ['hidden post (private, other user)', () => call(a, c, 'GET', `/api/v1/posts/${w.posts.private.postId}`), 'NOT_FOUND'],
      ['post patch stale revision', () => call(a, o, 'PATCH', `/api/v1/posts/${w.posts.public.postId}`, { expectedPostRevision: 9, story: 'x' }), 'REVISION_CONFLICT'],
      ['post patch group without groupId', () => call(a, o, 'PATCH', `/api/v1/posts/${w.posts.public.postId}`, { expectedPostRevision: 1, visibility: 'group' }), 'VALIDATION_FAILED'],
      ['copy of hidden post', () => call(a, c, 'POST', `/api/v1/posts/${w.posts.private.postId}/copy`, { newStartDate: '2027-01-10', timeZone: 'Asia/Tokyo' }), 'NOT_FOUND'],
      ['copy impossible date', () => call(a, c, 'POST', `/api/v1/posts/${w.posts.public.postId}/copy`, { newStartDate: '2027-02-30', timeZone: 'Asia/Tokyo' }), 'VALIDATION_FAILED'],
      ['copy bad time zone', () => call(a, c, 'POST', `/api/v1/posts/${w.posts.public.postId}/copy`, { newStartDate: '2027-01-10', timeZone: '+09:00' }), 'VALIDATION_FAILED'],
      ['group invite by non-member', () => call(a, c, 'POST', `/api/v1/groups/${w.gid}/invites`, {}), 'NOT_FOUND'],
      ['group invite by plain member', () => call(a, w.actors.member, 'POST', `/api/v1/groups/${w.gid}/invites`, {}), 'FORBIDDEN'],
      ['accept unknown token', () => call(a, c, 'POST', '/api/v1/group-invites/accept', { token: 'x'.repeat(24) }), 'NOT_FOUND'],
      ['group name blank', () => call(a, o, 'POST', '/api/v1/groups', { name: '   ' }), 'VALIDATION_FAILED'],
      ['remove member as plain member', () => call(a, w.actors.member, 'DELETE', `/api/v1/groups/${w.gid}/members/user_a`), 'FORBIDDEN'],
    ];
  };
  it('table', async () => {
    for (const [label, run, code] of rows()) expectErr(label, await run(), code);
  });
  it('malformed JSON and wrong content type give VALIDATION_FAILED, not a framework body', async () => {
    const o = w.actors.owner!;
    const bad = await w.app.inject({ method: 'POST', url: '/api/v1/groups', payload: '{"name":', headers: { cookie: o.cookie, 'x-csrf-token': o.csrf, 'content-type': 'application/json' } });
    expectErr('malformed json', bad, 'VALIDATION_FAILED');
    const text = await w.app.inject({ method: 'POST', url: '/api/v1/groups', payload: 'name=x', headers: { cookie: o.cookie, 'x-csrf-token': o.csrf, 'content-type': 'text/plain' } });
    expect(text.statusCode).toBeGreaterThanOrEqual(400);
    expectErr('text/plain', text, 'VALIDATION_FAILED');
    expect(text.statusCode).toBe(422);
  });
  it('error bodies never contain stack traces, SQL or file paths', async () => {
    for (const [label, run] of rows()) {
      const res = await run();
      expect(res.body, label).not.toMatch(/\bat \S+ \(|SELECT |INSERT |node_modules|\/Users\/|\.ts:\d+/);
    }
  });
  it('REVISION_CONFLICT details carry numeric expectedRevision and currentRevision (K10)', async () => {
    const res = await call(w.app, w.actors.owner, 'PATCH', `/api/v1/trips/${w.tripA.tripId}`, { expectedRevision: 9, operations: [{ op: 'set_title', title: 't' }] });
    const e = expectErr('conflict', res, 'REVISION_CONFLICT');
    expect(e.details).toEqual({ expectedRevision: 9, currentRevision: 1 });
  });
  it('CONSTRAINT_UNSATISFIED from PATCH names the operation index and a reason (K10)', async () => {
    const res = await call(w.app, w.actors.owner, 'PATCH', `/api/v1/trips/${w.tripA.tripId}`, { expectedRevision: 1, operations: [{ op: 'set_title', title: 'ok' }, { op: 'remove', itemId: 'nope' }] });
    const e = expectErr('unsatisfied', res, 'CONSTRAINT_UNSATISFIED');
    expect(e.details).toMatchObject({ operationIndex: 1 });
    expect(typeof e.details?.reason).toBe('string');
  });
});
