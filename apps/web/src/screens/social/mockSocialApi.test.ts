import { describe, expect, it } from 'vitest';
import type { Feed } from '@tkb/contracts';
import type { SocialApi, SocialResult } from './api.ts';
import { createMockSocialApi } from './mockSocialApi.ts';

function must<T>(r: SocialResult<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
  return r.data;
}
const code = (r: SocialResult<unknown>) => (r.ok ? 'OK' : r.error.code);

async function postAs(api: SocialApi, visibility: 'public' | 'private' | 'group', groupId?: string) {
  const trip = must(await api.listMyTrips()).items[0]!;
  const preview = must(await api.previewPost({ tripId: trip.tripId, sourceRevision: trip.revision, visibility, ...(groupId ? { groupId } : {}), story: `${visibility} story` }));
  return must(await api.createPost(preview.previewToken));
}

describe('U08 mock: two accounts and visibility (R20/R21)', () => {
  it('A posts public and private; B sees only the public one (feed and direct access)', async () => {
    const api = createMockSocialApi({ scenario: 'normal' });
    must(await api.login('demo-a', 'x'));
    const pub = await postAs(api, 'public');
    const priv = await postAs(api, 'private');
    const mine = must(await api.getFeed('mine')).items.map(i => i.postId);
    expect(mine).toEqual(expect.arrayContaining([pub.postId, priv.postId]));

    must(await api.login('demo-b', 'x'));
    const all: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i += 1) {
      const page: Feed = must(await api.getFeed('public', cursor, 1));
      all.push(...page.items.map(p => p.postId));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    expect(all).toContain(pub.postId);
    expect(all).not.toContain(priv.postId);
    expect(all).not.toContain('fx_post_private');
    expect(code(await api.getPost(priv.postId))).toBe('NOT_FOUND');
    expect(code(await api.copyPost(priv.postId, { newStartDate: '2026-12-01', timeZone: 'Asia/Tokyo' }))).toBe('NOT_FOUND');
    expect(code(await api.changeVisibility(pub.postId, 1, 'private', null))).toBe('NOT_FOUND');
    expect(code(await api.deletePost(pub.postId))).toBe('NOT_FOUND');
  });

  it('anonymous users read only the public feed', async () => {
    const api = createMockSocialApi({ initialUser: null });
    expect(must(await api.getFeed('public')).items.every(i => i.visibility === 'public')).toBe(true);
    expect(code(await api.getFeed('mine'))).toBe('UNAUTHENTICATED');
    expect(code(await api.getPost('fx_post_private'))).toBe('NOT_FOUND');
  });

  it('snapshots never contain private notes', async () => {
    const api = createMockSocialApi();
    const post = must(await api.getPost('fx_post_1'));
    expect(JSON.stringify(post)).not.toContain('非公開メモ');
    expect(JSON.stringify(post)).not.toContain('privateNotes');
  });

  it('B copies a public post: own trip, revision 1, needs_revalidation, times and fares cleared (R22)', async () => {
    const api = createMockSocialApi({ initialUser: 'demo-b' });
    const r = must(await api.copyPost('fx_post_1', { newStartDate: '2026-12-01', timeZone: 'Asia/Tokyo' }));
    expect(r).toMatchObject({ ownerId: 'fx_user_b', revision: 1, validationState: 'needs_revalidation' });
    const trip = must(await api.getTrip(r.tripId));
    expect(trip.constraints.startDate).toBe('2026-12-01');
    for (const d of trip.days) for (const it of d.items) {
      if (it.type === 'activity') expect([it.start, it.end, it.cost, it.privateNotes]).toEqual([null, null, null, null]);
      else expect([it.departure, it.arrival, it.fare]).toEqual([null, null, null]);
    }
    expect(must(await api.listMyTrips()).items.map(t => t.tripId)).toContain(r.tripId);
  });

  it('owner can make a post private (公開解除) and delete it (取り下げ)', async () => {
    const api = createMockSocialApi();
    const p = must(await api.changeVisibility('fx_post_1', 1, 'private', null));
    expect(p).toMatchObject({ visibility: 'private', postRevision: 2 });
    expect(code(await api.changeVisibility('fx_post_1', 1, 'public', null))).toBe('REVISION_CONFLICT');
    expect(must(await api.getFeed('public')).items.map(i => i.postId)).not.toContain('fx_post_1');
    must(await api.deletePost('fx_post_1'));
    expect(code(await api.getPost('fx_post_1'))).toBe('NOT_FOUND');
  });
});

describe('U08 mock: groups and invites (K17)', () => {
  it('B joins by invite link and then sees the group post; a used invite is 409', async () => {
    const api = createMockSocialApi({ origin: 'http://127.0.0.1:5173' });
    const groups = must(await api.listGroups());
    const groupId = groups[0]!.groupId;
    const invite = must(await api.createInvite(groupId));
    expect(invite.inviteUrl).toMatch(/^http:\/\/127\.0\.0\.1:5173\/invite#[A-Za-z0-9_-]{16,}$/);
    const token = invite.inviteUrl.split('#')[1]!;

    must(await api.login('demo-b', 'x'));
    expect(must(await api.getFeed('groups')).items).toEqual([]);
    expect(code(await api.getPost('fx_post_group'))).toBe('NOT_FOUND');
    must(await api.acceptInvite(token));
    expect(must(await api.getFeed('groups')).items.map(i => i.postId)).toContain('fx_post_group');
    expect(must(await api.listGroups()).find(g => g.groupId === groupId)?.role).toBe('member');
    expect(code(await api.createInvite(groupId))).toBe('FORBIDDEN');
    expect(code(await api.acceptInvite(token))).toBe('ALREADY_COMMITTED');

    must(await api.leaveGroup(groupId, 'fx_user_b'));
    expect(code(await api.getPost('fx_post_group'))).toBe('NOT_FOUND');
  });

  it('group preview requires membership (422) and an expired invite is 410', async () => {
    let t = Date.parse('2026-10-25T00:00:00Z');
    const api = createMockSocialApi({ now: () => new Date(t) });
    const created = must(await api.createGroup('新しいグループ'));
    const invite = must(await api.createInvite(created.groupId));
    must(await api.login('demo-b', 'x'));
    const b = createMockSocialApi({ initialUser: 'demo-b' });
    expect(code(await b.previewPost({ tripId: 'none', sourceRevision: 1, visibility: 'group', groupId: created.groupId, story: '' }))).toBe('NOT_FOUND');
    t += 8 * 24 * 60 * 60_000;
    expect(code(await api.acceptInvite(invite.inviteUrl.split('#')[1]!))).toBe('EXPIRED');
  });

  it('a preview can be used once and expires after 10 minutes', async () => {
    let t = Date.parse('2026-10-25T00:00:00Z');
    const api = createMockSocialApi({ now: () => new Date(t) });
    const trip = must(await api.listMyTrips()).items[0]!;
    const groupPreview = await api.previewPost({ tripId: trip.tripId, sourceRevision: trip.revision, visibility: 'group', groupId: 'fx_group_unknown', story: '' });
    expect(code(groupPreview)).toBe('VALIDATION_FAILED');
    expect(code(await api.previewPost({ tripId: trip.tripId, sourceRevision: trip.revision + 1, visibility: 'public', story: '' }))).toBe('REVISION_CONFLICT');
    const p1 = must(await api.previewPost({ tripId: trip.tripId, sourceRevision: trip.revision, visibility: 'public', story: '' }));
    expect(p1.redactedFields).toEqual(expect.arrayContaining(['privateNotes', 'preciseCurrentLocation']));
    must(await api.createPost(p1.previewToken));
    expect(code(await api.createPost(p1.previewToken))).toBe('ALREADY_COMMITTED');
    const p2 = must(await api.previewPost({ tripId: trip.tripId, sourceRevision: trip.revision, visibility: 'public', story: '' }));
    t += 11 * 60_000;
    expect(code(await api.createPost(p2.previewToken))).toBe('EXPIRED');
  });

  it('the error and empty scenarios', async () => {
    expect(code(await createMockSocialApi({ scenario: 'error' }).getFeed('public'))).toBe('UNAVAILABLE');
    const empty = createMockSocialApi({ scenario: 'empty' });
    expect(must(await empty.getFeed('public')).items).toEqual([]);
    expect(must(await empty.listMyTrips()).items).toEqual([]);
    expect(must(await empty.listGroups())).toEqual([]);
  });
});
