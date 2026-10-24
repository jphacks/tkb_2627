import { describe, expect, it } from 'vitest';
import { makeActivity, makeDay, makeLeg } from './fixtures.ts';
import { tripElapsedSeconds } from './trip.ts';

describe('tripElapsedSeconds', () => {
  it('spans earliest start to latest end across days and items, including a local-midnight crossing', () => {
    const d1 = makeDay([
      makeActivity('dinner', { start: '2026-07-01T10:00:00Z', end: '2026-07-01T14:30:00Z' }), // 19:00-23:30 JST
      makeLeg('night', { departure: '2026-07-01T14:30:00Z', arrival: '2026-07-01T15:45:00Z' }), // arrives 00:45 JST next day
    ]);
    const d2 = makeDay([makeActivity('late', { start: '2026-07-01T16:00:00Z', end: '2026-07-01T17:00:00Z' })], 'Asia/Tokyo', '2026-07-02');
    expect(tripElapsedSeconds([d1, d2])).toBe(7 * 3600);
  });

  it('is independent of the zone each item is expressed in', () => {
    const items = [
      makeActivity('a', { start: '2026-07-01T00:00:00Z', end: '2026-07-01T01:00:00Z', timeZone: 'Asia/Tokyo' }),
      makeActivity('b', { start: '2026-07-01T02:00:00Z', end: '2026-07-01T03:00:00Z', timeZone: 'Europe/Paris' }),
    ];
    expect(tripElapsedSeconds([makeDay(items)])).toBe(3 * 3600);
  });

  it('is null (not 0) when any item lacks a start or end', () => {
    expect(tripElapsedSeconds([makeDay([makeActivity('a', { start: '2026-07-01T00:00:00Z' })])])).toBeNull();
    expect(
      tripElapsedSeconds([
        makeDay([
          makeActivity('a', { start: '2026-07-01T00:00:00Z', end: '2026-07-01T01:00:00Z' }),
          makeLeg('l', { arrival: '2026-07-01T02:00:00Z' }),
        ]),
      ]),
    ).toBeNull();
  });

  it('is null when there are no items', () => {
    expect(tripElapsedSeconds([])).toBeNull();
    expect(tripElapsedSeconds([makeDay([])])).toBeNull();
  });

  it('is 0 for a single zero-length item (known, distinct from null)', () => {
    expect(tripElapsedSeconds([makeDay([makeActivity('a', { start: '2026-07-01T00:00:00Z', end: '2026-07-01T00:00:00Z' })])])).toBe(0);
  });
});
