import { describe, expect, it } from 'vitest';
import type { ZonedTime } from '@tkb/contracts';
import { elapsedSeconds, fromLocal, localDayOffset, offsetMinutesAt, toLocal } from './zone.ts';

const tokyo = (utc: string): ZonedTime => ({ utc, timeZone: 'Asia/Tokyo' });
const paris = (utc: string): ZonedTime => ({ utc, timeZone: 'Europe/Paris' });

describe('offsetMinutesAt', () => {
  it('Asia/Tokyo has no DST', () => {
    expect(offsetMinutesAt('2026-01-15T00:00:00Z', 'Asia/Tokyo')).toBe(540);
    expect(offsetMinutesAt('2026-07-15T00:00:00Z', 'Asia/Tokyo')).toBe(540);
  });

  it('Europe/Paris switches at 2026-03-29 01:00Z and 2026-10-25 01:00Z', () => {
    expect(offsetMinutesAt('2026-03-29T00:59:59Z', 'Europe/Paris')).toBe(60);
    expect(offsetMinutesAt('2026-03-29T01:00:00Z', 'Europe/Paris')).toBe(120);
    expect(offsetMinutesAt('2026-10-25T00:59:59Z', 'Europe/Paris')).toBe(120);
    expect(offsetMinutesAt('2026-10-25T01:00:00Z', 'Europe/Paris')).toBe(60);
  });

  it('America/New_York switches at 2026-03-08 07:00Z and 2026-11-01 06:00Z', () => {
    expect(offsetMinutesAt('2026-03-08T06:59:59Z', 'America/New_York')).toBe(-300);
    expect(offsetMinutesAt('2026-03-08T07:00:00Z', 'America/New_York')).toBe(-240);
    expect(offsetMinutesAt('2026-11-01T05:59:59Z', 'America/New_York')).toBe(-240);
    expect(offsetMinutesAt('2026-11-01T06:00:00Z', 'America/New_York')).toBe(-300);
  });

  it('supports a half-hour zone', () => {
    expect(offsetMinutesAt('2026-01-01T00:00:00Z', 'Asia/Kolkata')).toBe(330);
  });

  it('rejects an invalid instant', () => {
    expect(() => offsetMinutesAt('not-a-date', 'Asia/Tokyo')).toThrow(RangeError);
  });
});

describe('toLocal', () => {
  it('reads the same instant in different zones', () => {
    const utc = '2026-07-01T15:30:00Z';
    expect(toLocal(tokyo(utc))).toEqual({ date: '2026-07-02', time: '00:30', offsetMinutes: 540 });
    expect(toLocal(paris(utc))).toEqual({ date: '2026-07-01', time: '17:30', offsetMinutes: 120 });
  });

  it('renders midnight as 00:00 (h23), not 24:00', () => {
    expect(toLocal(tokyo('2026-07-01T15:00:00Z'))).toMatchObject({ date: '2026-07-02', time: '00:00' });
  });
});

describe('fromLocal', () => {
  it('is exact in Asia/Tokyo', () => {
    expect(fromLocal('2026-11-01', '09:00', 'Asia/Tokyo')).toEqual({ kind: 'exact', utc: '2026-11-01T00:00:00Z' });
  });

  it('is exact in Paris outside transitions (summer and winter offsets)', () => {
    expect(fromLocal('2026-07-01', '12:00', 'Europe/Paris')).toEqual({ kind: 'exact', utc: '2026-07-01T10:00:00Z' });
    expect(fromLocal('2026-01-01', '12:00', 'Europe/Paris')).toEqual({ kind: 'exact', utc: '2026-01-01T11:00:00Z' });
  });

  it('reports the Paris spring-forward gap (02:30 on 2026-03-29 does not exist)', () => {
    const r = fromLocal('2026-03-29', '02:30', 'Europe/Paris');
    expect(r).toEqual({ kind: 'gap', before: '2026-03-29T00:30:00Z', after: '2026-03-29T01:30:00Z' });
    if (r.kind !== 'gap') throw new Error('unreachable');
    expect(toLocal(paris(r.before))).toMatchObject({ date: '2026-03-29', time: '01:30' });
    expect(toLocal(paris(r.after))).toMatchObject({ date: '2026-03-29', time: '03:30' });
  });

  it('the Paris gap edges are exact: 01:59 exists, 03:00 exists', () => {
    expect(fromLocal('2026-03-29', '01:59', 'Europe/Paris').kind).toBe('exact');
    expect(fromLocal('2026-03-29', '03:00', 'Europe/Paris').kind).toBe('exact');
    expect(fromLocal('2026-03-29', '02:00', 'Europe/Paris').kind).toBe('gap');
  });

  it('reports the Paris fall-back overlap (02:30 on 2026-10-25 happens twice)', () => {
    const r = fromLocal('2026-10-25', '02:30', 'Europe/Paris');
    expect(r).toEqual({ kind: 'ambiguous', earlier: '2026-10-25T00:30:00Z', later: '2026-10-25T01:30:00Z' });
    if (r.kind !== 'ambiguous') throw new Error('unreachable');
    expect(toLocal(paris(r.earlier))).toMatchObject({ time: '02:30', offsetMinutes: 120 });
    expect(toLocal(paris(r.later))).toMatchObject({ time: '02:30', offsetMinutes: 60 });
  });

  it('handles America/New_York gap and overlap in 2026', () => {
    expect(fromLocal('2026-03-08', '02:30', 'America/New_York')).toEqual({
      kind: 'gap',
      before: '2026-03-08T06:30:00Z',
      after: '2026-03-08T07:30:00Z',
    });
    expect(fromLocal('2026-11-01', '01:30', 'America/New_York')).toEqual({
      kind: 'ambiguous',
      earlier: '2026-11-01T05:30:00Z',
      later: '2026-11-01T06:30:00Z',
    });
  });

  it('the same wall time is never ambiguous in Tokyo on those dates', () => {
    expect(fromLocal('2026-10-25', '02:30', 'Asia/Tokyo').kind).toBe('exact');
    expect(fromLocal('2026-03-29', '02:30', 'Asia/Tokyo').kind).toBe('exact');
  });

  it('round-trips through toLocal for exact results', () => {
    const r = fromLocal('2026-12-31', '23:59', 'America/New_York');
    if (r.kind !== 'exact') throw new Error('expected exact');
    expect(toLocal({ utc: r.utc, timeZone: 'America/New_York' })).toMatchObject({ date: '2026-12-31', time: '23:59' });
  });

  it('rejects malformed or impossible input', () => {
    expect(() => fromLocal('2026-02-30', '10:00', 'Asia/Tokyo')).toThrow(RangeError);
    expect(() => fromLocal('2026-02-10', '24:00', 'Asia/Tokyo')).toThrow(RangeError);
    expect(() => fromLocal('2026-2-10', '10:00', 'Asia/Tokyo')).toThrow(RangeError);
  });
});

describe('elapsedSeconds', () => {
  it('is the absolute instant difference regardless of zone', () => {
    // Departs Tokyo 23:30 local (14:30Z), arrives Paris 06:00 local next day (04:00Z at +2) => 13.5h.
    expect(elapsedSeconds(tokyo('2026-07-01T14:30:00Z'), paris('2026-07-02T04:00:00Z'))).toBe(13.5 * 3600);
  });

  it('is negative when the end is earlier', () => {
    expect(elapsedSeconds(tokyo('2026-07-01T01:00:00Z'), tokyo('2026-07-01T00:00:00Z'))).toBe(-3600);
  });

  it('counts a DST night as 1 hour longer in the fall-back night and shorter in spring', () => {
    // Paris local 00:00 -> 06:00 on those days.
    const spring = elapsedSeconds(paris('2026-03-28T23:00:00Z'), paris('2026-03-29T04:00:00Z'));
    const fall = elapsedSeconds(paris('2026-10-24T22:00:00Z'), paris('2026-10-25T05:00:00Z'));
    expect(spring).toBe(5 * 3600);
    expect(fall).toBe(7 * 3600);
  });
});

describe('localDayOffset', () => {
  it('Tokyo 23:30 departure arriving the next local day in Tokyo', () => {
    // 23:30 JST on 07-01 = 14:30Z; 00:45 JST on 07-02 = 15:45Z.
    expect(localDayOffset(tokyo('2026-07-01T14:30:00Z'), tokyo('2026-07-01T15:45:00Z'))).toBe(1);
  });

  it('overnight Tokyo to Paris flight lands on the same Paris date as it left Tokyo', () => {
    // Depart Tokyo 07-01 23:30 (14:30Z), arrive Paris 07-02 06:00 (04:00Z next day).
    expect(localDayOffset(tokyo('2026-07-01T14:30:00Z'), paris('2026-07-02T04:00:00Z'))).toBe(1);
    // Depart Tokyo 07-01 11:00 (02:00Z), arrive Paris 07-01 17:00 (15:00Z): same local date.
    expect(localDayOffset(tokyo('2026-07-01T02:00:00Z'), paris('2026-07-01T15:00:00Z'))).toBe(0);
  });

  it('can be negative when the end zone is behind (Tokyo to Los Angeles)', () => {
    // Depart Tokyo 07-02 01:00 (07-01 16:00Z), arrive Los Angeles 07-01 10:00 PDT (17:00Z).
    expect(
      localDayOffset(tokyo('2026-07-01T16:00:00Z'), { utc: '2026-07-01T17:00:00Z', timeZone: 'America/Los_Angeles' }),
    ).toBe(-1);
  });

  it('works across a month boundary', () => {
    expect(localDayOffset(tokyo('2026-07-31T14:30:00Z'), tokyo('2026-07-31T15:30:00Z'))).toBe(1);
  });
});
