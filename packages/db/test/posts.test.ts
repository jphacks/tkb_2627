import { describe, expect, it } from 'vitest';
import { fixtureTrips } from '@tkb/fixtures';
import {
  createGroup,
  createPostFromPreview,
  createUser,
  getPostForViewer,
  hashPreviewToken,
  hidePostsForTrip,
  insertPreview,
  insertTrip,
  listFeed,
  migrate,
  openDatabase,
} from '../src/index.ts';

const NOW = '2026-10-24T03:00:00Z';

function seed() {
  const db = openDatabase(':memory:');
  migrate(db);
  for (const id of ['u1', 'u2']) createUser(db, { id, loginId: id, passwordHash: 'h', displayName: id, createdAt: NOW });
  const trip = insertTrip(db, 'u1', { ...structuredClone(fixtureTrips[0]!), tripId: 't1' }, NOW);
  const g = createGroup(db, 'u1', 'g', NOW);
  return { db, trip, g };
}
const snapshot = (title: string) =>
  JSON.stringify({
    schemaVersion: 1,
    title,
    constraints: { area: 'A', startDate: '2026-11-01', endDate: '2026-11-02', timeZone: 'Asia/Tokyo', transportMode: 'transit' },
    days: [],
    places: [],
    redactionVersion: 1,
  });

describe('posts repository', () => {
  it('commits a preview once, atomically, and hidePostsForTrip makes posts private', () => {
    const { db, trip, g } = seed();
    insertPreview(db, { tokenHash: hashPreviewToken('tok'), ownerId: 'u1', tripId: 't1', sourceRevision: 1, visibility: 'group', groupId: g.groupId, story: 's', snapshotJson: snapshot('T'), expiresAt: '2026-10-24T03:10:00Z' }, NOW);
    expect(createPostFromPreview(db, hashPreviewToken('tok'), 'u2', NOW)).toEqual({ ok: false, code: 'NOT_FOUND' });
    const r = createPostFromPreview(db, hashPreviewToken('tok'), 'u1', NOW);
    expect(r.ok).toBe(true);
    expect(createPostFromPreview(db, hashPreviewToken('tok'), 'u1', NOW)).toEqual({ ok: false, code: 'ALREADY_COMMITTED' });
    expect(listFeed(db, { scope: 'groups', viewerId: 'u1', limit: 20 }).items).toHaveLength(1);
    expect(hidePostsForTrip(db, trip.tripId, 'u2')).toBe(0);
    expect(hidePostsForTrip(db, trip.tripId, 'u1', NOW)).toBe(1);
    const postId = r.ok ? r.post.postId : '';
    const p = getPostForViewer(db, postId, 'u1')!;
    expect(p).toMatchObject({ visibility: 'private', groupId: null, postRevision: 2 });
    expect(listFeed(db, { scope: 'groups', viewerId: 'u1', limit: 20 }).items).toEqual([]);
    expect(hidePostsForTrip(db, trip.tripId, 'u1', NOW)).toBe(0);
  });
});
