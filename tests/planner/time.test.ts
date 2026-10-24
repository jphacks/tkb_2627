// R05/R06/R13: 日跨ぎ・複数日・DST・異なるIANAゾーン。日時はすべて架空フィクスチャ。
import { elapsedSeconds, fromLocal, localDayOffset, toLocal, tripElapsedSeconds } from '@tkb/planner';
import { describe, expect, it } from 'vitest';
import { act, day, leg } from './helpers.ts';

describe('time zones (架空フィクスチャ)', () => {
  it('overnight Tokyo to Paris leg: elapsed is real time, local day offset is 1', () => {
    const dep = { utc: '2026-07-01T14:00:00Z', timeZone: 'Asia/Tokyo' }; // 07-01 23:00 JST
    const arr = { utc: '2026-07-02T04:00:00Z', timeZone: 'Europe/Paris' }; // 07-02 06:00 CEST
    expect(toLocal(dep)).toMatchObject({ date: '2026-07-01', time: '23:00' });
    expect(toLocal(arr)).toMatchObject({ date: '2026-07-02', time: '06:00' });
    expect(elapsedSeconds(dep, arr)).toBe(14 * 3600);
    expect(localDayOffset(dep, arr)).toBe(1);
  });

  it('equal wall clocks in different zones are not equal instants', () => {
    const a = { utc: '2026-07-01T00:00:00Z', timeZone: 'Asia/Tokyo' }; // 09:00
    const b = { utc: '2026-07-01T07:00:00Z', timeZone: 'Europe/Paris' }; // 09:00
    expect(toLocal(a).time).toBe(toLocal(b).time);
    expect(elapsedSeconds(a, b)).toBe(7 * 3600);
  });

  it('spring-forward gap in Europe/Paris is reported as a gap, never picked silently', () => {
    expect(fromLocal('2026-03-29', '02:30', 'Europe/Paris').kind).toBe('gap');
  });

  it('fall-back overlap in Europe/Paris returns both instants one hour apart', () => {
    const r = fromLocal('2026-10-25', '02:30', 'Europe/Paris');
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') expect((Date.parse(r.later) - Date.parse(r.earlier)) / 3600_000).toBe(1);
  });

  it('Asia/Tokyo has no DST: a wall time is always exact', () => {
    expect(fromLocal('2026-03-29', '02:30', 'Asia/Tokyo').kind).toBe('exact');
  });

  it('elapsed time over the DST change is 3h for 23:00 to 03:00 local', () => {
    const a = fromLocal('2026-03-28', '23:00', 'Europe/Paris');
    const b = fromLocal('2026-03-29', '03:00', 'Europe/Paris');
    if (a.kind !== 'exact' || b.kind !== 'exact') throw new Error('expected exact');
    expect(elapsedSeconds({ utc: a.utc, timeZone: 'Europe/Paris' }, { utc: b.utc, timeZone: 'Europe/Paris' })).toBe(3 * 3600);
  });

  it('rejects invalid calendar dates and times', () => {
    expect(() => fromLocal('2026-02-30', '10:00', 'Asia/Tokyo')).toThrow(RangeError);
    expect(() => fromLocal('2026-02-01', '24:00', 'Asia/Tokyo')).toThrow(RangeError);
  });
});

describe('tripElapsedSeconds (架空フィクスチャ)', () => {
  it('spans multiple days including an item that crosses midnight', () => {
    const d1 = day([act('late', { start: '2026-07-01T10:00:00Z', end: '2026-07-01T16:30:00Z' })], '2026-07-01'); // 19:00-01:30 JST
    const d2 = day([act('next', { start: '2026-07-02T00:00:00Z', end: '2026-07-02T02:00:00Z' })], '2026-07-02');
    expect(tripElapsedSeconds([d1, d2])).toBe(16 * 3600);
  });

  it('is null (not 0) when any item lacks a time or there are no items', () => {
    expect(tripElapsedSeconds([day([act('x', { start: '2026-07-01T01:00:00Z' })])])).toBeNull();
    expect(tripElapsedSeconds([day([leg('l', { dep: '2026-07-01T01:00:00Z' })])])).toBeNull();
    expect(tripElapsedSeconds([day([])])).toBeNull();
  });
});
