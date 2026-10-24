import { describe, expect, it } from 'vitest';
import type { TravelLeg, ZonedTime } from '@tkb/contracts';
import { makeActivity, makeDay, makeLeg } from './fixtures.ts';
import { elapsedSeconds, fromLocal, localDayOffset, offsetMinutesAt, parseUtc, toLocal } from './zone.ts';
import { tripElapsedSeconds } from './trip.ts';

// Every transition instant below was confirmed against Intl (Node 22 ICU) before being asserted.
const z = (utc: string, timeZone: string): ZonedTime => ({ utc, timeZone });
const wallKey = (r: { date: string; time: string }) => `${r.date} ${r.time}`;

describe('southern hemisphere and fractional-offset DST (2026)', () => {
  it('Australia/Sydney: offsets switch at 2026-04-04 16:00Z and 2026-10-03 16:00Z', () => {
    expect(offsetMinutesAt('2026-04-04T15:59:59Z', 'Australia/Sydney')).toBe(660);
    expect(offsetMinutesAt('2026-04-04T16:00:00Z', 'Australia/Sydney')).toBe(600);
    expect(offsetMinutesAt('2026-10-03T15:59:59Z', 'Australia/Sydney')).toBe(600);
    expect(offsetMinutesAt('2026-10-03T16:00:00Z', 'Australia/Sydney')).toBe(660);
  });

  it('Australia/Sydney: spring-forward gap in October and fall-back overlap in April', () => {
    expect(fromLocal('2026-10-04', '02:30', 'Australia/Sydney')).toEqual({
      kind: 'gap',
      before: '2026-10-03T15:30:00Z',
      after: '2026-10-03T16:30:00Z',
    });
    expect(fromLocal('2026-04-05', '02:30', 'Australia/Sydney')).toEqual({
      kind: 'ambiguous',
      earlier: '2026-04-04T15:30:00Z',
      later: '2026-04-04T16:30:00Z',
    });
  });

  it('Pacific/Auckland: gap on 2026-09-27 and overlap on 2026-04-05', () => {
    expect(fromLocal('2026-09-27', '02:30', 'Pacific/Auckland')).toEqual({
      kind: 'gap',
      before: '2026-09-26T13:30:00Z',
      after: '2026-09-26T14:30:00Z',
    });
    expect(fromLocal('2026-04-05', '02:30', 'Pacific/Auckland')).toEqual({
      kind: 'ambiguous',
      earlier: '2026-04-04T13:30:00Z',
      later: '2026-04-04T14:30:00Z',
    });
  });

  it('America/Santiago: the 00:00 wall time does not exist on 2026-09-06 (the gap sits at local midnight)', () => {
    expect(fromLocal('2026-09-06', '00:00', 'America/Santiago')).toEqual({
      kind: 'gap',
      before: '2026-09-06T03:00:00Z',
      after: '2026-09-06T04:00:00Z',
    });
    // 01:00 is the first wall time that exists again.
    expect(fromLocal('2026-09-06', '01:00', 'America/Santiago').kind).toBe('exact');
    // 23:59 the evening before is untouched.
    expect(fromLocal('2026-09-05', '23:59', 'America/Santiago').kind).toBe('exact');
  });

  it('America/Santiago: 23:30 on 2026-04-04 happens twice (overlap starts the evening before local midnight)', () => {
    expect(fromLocal('2026-04-04', '23:30', 'America/Santiago')).toEqual({
      kind: 'ambiguous',
      earlier: '2026-04-05T02:30:00Z',
      later: '2026-04-05T03:30:00Z',
    });
  });

  it('Asia/Beirut: gap right after local midnight (00:30 on 2026-03-29) and overlap before it (23:30 on 2026-10-24)', () => {
    expect(fromLocal('2026-03-29', '00:30', 'Asia/Beirut')).toEqual({
      kind: 'gap',
      before: '2026-03-28T21:30:00Z',
      after: '2026-03-28T22:30:00Z',
    });
    expect(fromLocal('2026-10-24', '23:30', 'Asia/Beirut')).toMatchObject({ kind: 'ambiguous' });
  });

  it('Australia/Lord_Howe: DST shift is 30 minutes, so the gap is 02:00-02:29 and the overlap is 01:30-01:59', () => {
    expect(offsetMinutesAt('2026-10-03T15:29:59Z', 'Australia/Lord_Howe')).toBe(630);
    expect(offsetMinutesAt('2026-10-03T15:30:00Z', 'Australia/Lord_Howe')).toBe(660);
    expect(fromLocal('2026-10-04', '02:15', 'Australia/Lord_Howe')).toEqual({
      kind: 'gap',
      before: '2026-10-03T15:15:00Z',
      after: '2026-10-03T15:45:00Z',
    });
    // 02:30 and 01:59 exist; 02:00 does not.
    expect(fromLocal('2026-10-04', '02:30', 'Australia/Lord_Howe').kind).toBe('exact');
    expect(fromLocal('2026-10-04', '01:59', 'Australia/Lord_Howe').kind).toBe('exact');
    expect(fromLocal('2026-10-04', '02:00', 'Australia/Lord_Howe').kind).toBe('gap');

    expect(fromLocal('2026-04-05', '01:45', 'Australia/Lord_Howe')).toEqual({
      kind: 'ambiguous',
      earlier: '2026-04-04T14:45:00Z',
      later: '2026-04-04T15:15:00Z',
    });
    expect(fromLocal('2026-04-05', '01:29', 'Australia/Lord_Howe').kind).toBe('exact');
    expect(fromLocal('2026-04-05', '01:30', 'Australia/Lord_Howe').kind).toBe('ambiguous');
    expect(fromLocal('2026-04-05', '02:00', 'Australia/Lord_Howe').kind).toBe('exact');
  });

  it('Africa/Casablanca: negative DST (Ramadan) still yields a gap in March and an overlap in February', () => {
    expect(fromLocal('2026-03-22', '02:30', 'Africa/Casablanca')).toEqual({
      kind: 'gap',
      before: '2026-03-22T01:30:00Z',
      after: '2026-03-22T02:30:00Z',
    });
    expect(fromLocal('2026-02-15', '02:30', 'Africa/Casablanca')).toEqual({
      kind: 'ambiguous',
      earlier: '2026-02-15T01:30:00Z',
      later: '2026-02-15T02:30:00Z',
    });
  });

  it('Asia/Kathmandu has a fixed +05:45 offset and no DST', () => {
    expect(toLocal(z('2026-01-01T00:00:00Z', 'Asia/Kathmandu'))).toEqual({ date: '2026-01-01', time: '05:45', offsetMinutes: 345 });
    expect(offsetMinutesAt('2026-07-01T00:00:00Z', 'Asia/Kathmandu')).toBe(345);
    expect(fromLocal('2026-07-01', '05:45', 'Asia/Kathmandu')).toEqual({ kind: 'exact', utc: '2026-07-01T00:00:00Z' });
  });

  it('Pacific/Apia skipped 2011-12-30 entirely: every wall time of that day is a gap spanning a whole day', () => {
    expect(fromLocal('2011-12-30', '12:00', 'Pacific/Apia')).toEqual({
      kind: 'gap',
      before: '2011-12-29T22:00:00Z',
      after: '2011-12-30T22:00:00Z',
    });
    expect(fromLocal('2011-12-29', '12:00', 'Pacific/Apia').kind).toBe('exact');
    expect(fromLocal('2011-12-31', '12:00', 'Pacific/Apia').kind).toBe('exact');
  });
});

describe('fromLocal property scan over 2026', () => {
  const zones = [
    'Asia/Tokyo',
    'Asia/Kathmandu',
    'Europe/London',
    'Europe/Paris',
    'America/New_York',
    'America/Havana',
    'America/Santiago',
    'Australia/Sydney',
    'Australia/Lord_Howe',
    'Pacific/Auckland',
    'Asia/Beirut',
    'Africa/Casablanca',
  ];
  const times = ['00:00', '00:30', '01:15', '01:45', '02:00', '02:15', '02:30', '03:30', '12:00', '23:30'];
  const noDst = new Set(['Asia/Tokyo', 'Asia/Kathmandu']);

  function* days() {
    for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 86_400_000) {
      yield new Date(t).toISOString().slice(0, 10);
    }
  }

  it('exact maps back to the same wall time; ambiguous and gap satisfy their documented shape', () => {
    const seen = new Map<string, { exact: number; ambiguous: number; gap: number }>();
    for (const zone of zones) {
      const stat = { exact: 0, ambiguous: 0, gap: 0 };
      seen.set(zone, stat);
      for (const date of days()) {
        for (const time of times) {
          const input = `${date} ${time}`;
          const r = fromLocal(date, time, zone);
          stat[r.kind] += 1;
          if (r.kind === 'exact') {
            expect(wallKey(toLocal(z(r.utc, zone))), `${zone} ${input}`).toBe(input);
          } else if (r.kind === 'ambiguous') {
            const e = toLocal(z(r.earlier, zone));
            const l = toLocal(z(r.later, zone));
            expect(parseUtc(r.earlier) < parseUtc(r.later), `${zone} ${input}`).toBe(true);
            expect(wallKey(e), `${zone} ${input}`).toBe(input);
            expect(wallKey(l), `${zone} ${input}`).toBe(input);
            // Clocks were turned back: the earlier instant has the larger offset, and the instants differ by the shift.
            expect(e.offsetMinutes - l.offsetMinutes, `${zone} ${input}`).toBeGreaterThan(0);
            expect((parseUtc(r.later) - parseUtc(r.earlier)) / 60000, `${zone} ${input}`).toBe(e.offsetMinutes - l.offsetMinutes);
          } else {
            const b = toLocal(z(r.before, zone));
            const a = toLocal(z(r.after, zone));
            expect(parseUtc(r.before) < parseUtc(r.after), `${zone} ${input}`).toBe(true);
            // Neither candidate reads back as the requested wall time: it never happened.
            expect(wallKey(b), `${zone} ${input}`).not.toBe(input);
            expect(wallKey(a), `${zone} ${input}`).not.toBe(input);
            // `before` reads earlier on the wall clock and `after` later.
            expect(wallKey(b) < input, `${zone} ${input}`).toBe(true);
            expect(wallKey(a) > input, `${zone} ${input}`).toBe(true);
            expect(a.offsetMinutes - b.offsetMinutes, `${zone} ${input}`).toBeGreaterThan(0);
            expect((parseUtc(r.after) - parseUtc(r.before)) / 60000, `${zone} ${input}`).toBe(a.offsetMinutes - b.offsetMinutes);
          }
        }
      }
    }
    // The scan must not be vacuous: every DST zone produced both ambiguous and gap results, others none.
    for (const zone of zones) {
      const stat = seen.get(zone)!;
      if (noDst.has(zone)) {
        expect(stat.ambiguous + stat.gap, zone).toBe(0);
      } else {
        expect(stat.gap, zone).toBeGreaterThan(0);
        expect(stat.ambiguous, zone).toBeGreaterThan(0);
      }
    }
  }, 60_000);
});

describe('invalid input throws RangeError', () => {
  it('unknown zone', () => {
    expect(() => fromLocal('2026-07-01', '10:00', 'Mars/Base')).toThrow(RangeError);
    expect(() => toLocal(z('2026-07-01T00:00:00Z', 'Mars/Base'))).toThrow(RangeError);
    expect(() => offsetMinutesAt('2026-07-01T00:00:00Z', 'Mars/Base')).toThrow(RangeError);
    expect(() => localDayOffset(z('2026-07-01T00:00:00Z', 'Asia/Tokyo'), z('2026-07-01T00:00:00Z', 'Mars/Base'))).toThrow(RangeError);
  });

  it('non-leap and century-non-leap February 29', () => {
    expect(() => fromLocal('2026-02-29', '10:00', 'Asia/Tokyo')).toThrow(RangeError);
    expect(() => fromLocal('2027-02-29', '10:00', 'Asia/Tokyo')).toThrow(RangeError);
    expect(() => fromLocal('2100-02-29', '10:00', 'Asia/Tokyo')).toThrow(RangeError);
  });

  it('leap-day dates are accepted', () => {
    expect(fromLocal('2028-02-29', '09:00', 'Asia/Tokyo')).toEqual({ kind: 'exact', utc: '2028-02-29T00:00:00Z' });
    expect(fromLocal('2028-02-29', '00:00', 'Asia/Tokyo')).toEqual({ kind: 'exact', utc: '2028-02-28T15:00:00Z' });
    expect(fromLocal('2000-02-29', '12:00', 'Europe/Paris').kind).toBe('exact');
  });

  it('impossible month, day, or day-of-month overflow', () => {
    for (const date of ['2026-13-01', '2026-00-10', '2026-01-00', '2026-04-31', '2026-06-31', '2026-01-32']) {
      expect(() => fromLocal(date, '10:00', 'Asia/Tokyo'), date).toThrow(RangeError);
    }
  });

  it('malformed time strings', () => {
    for (const time of ['24:00', '24:30', '12:60', '1:00', '12:5', '', '12', '12:00:00', ' 12:00', '12:00 ', 'ab:cd', '-1:00']) {
      expect(() => fromLocal('2026-07-01', time, 'Asia/Tokyo'), JSON.stringify(time)).toThrow(RangeError);
    }
  });

  it('malformed date strings', () => {
    for (const date of ['', '2026/07/01', '20260701', '2026-7-1', '2026-07-01T00:00', ' 2026-07-01', '2026-07-01 ']) {
      expect(() => fromLocal(date, '10:00', 'Asia/Tokyo'), JSON.stringify(date)).toThrow(RangeError);
    }
  });

  it('boundaries 00:00 and 23:59 are accepted', () => {
    expect(fromLocal('2026-07-01', '00:00', 'Asia/Tokyo')).toEqual({ kind: 'exact', utc: '2026-06-30T15:00:00Z' });
    expect(fromLocal('2026-07-01', '23:59', 'Asia/Tokyo')).toEqual({ kind: 'exact', utc: '2026-07-01T14:59:00Z' });
  });

  it('malformed UTC instants', () => {
    for (const utc of ['', 'garbage', '2026-13-01T00:00:00Z', '2026-07-01T25:00:00Z']) {
      expect(() => parseUtc(utc), JSON.stringify(utc)).toThrow(RangeError);
      expect(() => toLocal(z(utc, 'Asia/Tokyo')), JSON.stringify(utc)).toThrow(RangeError);
      expect(() => offsetMinutesAt(utc, 'Asia/Tokyo'), JSON.stringify(utc)).toThrow(RangeError);
      expect(() => elapsedSeconds(z(utc, 'Asia/Tokyo'), z('2026-07-01T00:00:00Z', 'Asia/Tokyo')), JSON.stringify(utc)).toThrow(RangeError);
      expect(() => localDayOffset(z('2026-07-01T00:00:00Z', 'Asia/Tokyo'), z(utc, 'Asia/Tokyo')), JSON.stringify(utc)).toThrow(RangeError);
    }
  });

  it('an instant with an explicit offset reads the same as its Z equivalent', () => {
    expect(toLocal(z('2026-07-01T09:00:00+09:00', 'Europe/Paris'))).toEqual(toLocal(z('2026-07-01T00:00:00Z', 'Europe/Paris')));
  });

  it('seconds are dropped, not rounded, when reading HH:mm', () => {
    expect(toLocal(z('2026-07-01T14:59:59Z', 'Asia/Tokyo'))).toMatchObject({ date: '2026-07-01', time: '23:59' });
    expect(toLocal(z('2026-07-01T14:59:59.999Z', 'Asia/Tokyo'))).toMatchObject({ date: '2026-07-01', time: '23:59' });
  });
});

describe('localDayOffset across the date line and calendar boundaries', () => {
  it('Pacific/Kiritimati (+14) is up to 2 calendar days ahead of Pacific/Pago_Pago (-11) at the same instant', () => {
    const utc = '2026-07-01T10:00:00Z';
    expect(toLocal(z(utc, 'Pacific/Kiritimati'))).toMatchObject({ date: '2026-07-02', time: '00:00', offsetMinutes: 840 });
    expect(toLocal(z(utc, 'Pacific/Pago_Pago'))).toMatchObject({ date: '2026-06-30', time: '23:00', offsetMinutes: -660 });
    expect(localDayOffset(z(utc, 'Pacific/Pago_Pago'), z(utc, 'Pacific/Kiritimati'))).toBe(2);
    expect(localDayOffset(z(utc, 'Pacific/Kiritimati'), z(utc, 'Pacific/Pago_Pago'))).toBe(-2);
  });

  it('is 1 at another time of day for the same pair (Pago_Pago 01:00, Kiritimati 02:00 next day)', () => {
    const utc = '2026-07-01T12:00:00Z';
    expect(localDayOffset(z(utc, 'Pacific/Pago_Pago'), z(utc, 'Pacific/Kiritimati'))).toBe(1);
  });

  it('is 0 for the same instant in the same zone and for zones sharing a calendar date', () => {
    expect(localDayOffset(z('2026-07-01T03:00:00Z', 'Asia/Tokyo'), z('2026-07-01T03:00:00Z', 'Asia/Tokyo'))).toBe(0);
    expect(localDayOffset(z('2026-07-01T03:00:00Z', 'Asia/Tokyo'), z('2026-07-01T03:00:00Z', 'Europe/Paris'))).toBe(0);
  });

  it('Tokyo to Los Angeles is negative across a year boundary (2027-01-01 05:00 JST = 2026-12-31 12:00 PST)', () => {
    expect(localDayOffset(z('2026-12-31T20:00:00Z', 'Asia/Tokyo'), z('2026-12-31T20:00:00Z', 'America/Los_Angeles'))).toBe(-1);
  });

  it('a 23-hour DST day still counts as exactly one calendar day (Paris 2026-03-29)', () => {
    // 00:00 CET on 03-29 -> 00:00 CEST on 03-30.
    const start = z('2026-03-28T23:00:00Z', 'Europe/Paris');
    const end = z('2026-03-29T22:00:00Z', 'Europe/Paris');
    expect(elapsedSeconds(start, end)).toBe(23 * 3600);
    expect(localDayOffset(start, end)).toBe(1);
  });

  it('a 25-hour DST day still counts as exactly one calendar day (Paris 2026-10-25)', () => {
    const start = z('2026-10-24T22:00:00Z', 'Europe/Paris');
    const end = z('2026-10-25T23:00:00Z', 'Europe/Paris');
    expect(elapsedSeconds(start, end)).toBe(25 * 3600);
    expect(localDayOffset(start, end)).toBe(1);
  });

  it('respects leap years across the Feb/Mar boundary', () => {
    expect(localDayOffset(z('2028-02-27T15:00:00Z', 'Asia/Tokyo'), z('2028-02-29T15:00:00Z', 'Asia/Tokyo'))).toBe(2);
    expect(localDayOffset(z('2027-02-27T15:00:00Z', 'Asia/Tokyo'), z('2027-02-28T15:00:00Z', 'Asia/Tokyo'))).toBe(1);
    // 2028-02-28 JST -> 2028-03-01 JST is 2 days (29 Feb exists); 2027-02-28 -> 2027-03-01 is 1.
    expect(localDayOffset(z('2028-02-28T00:00:00Z', 'Asia/Tokyo'), z('2028-03-01T00:00:00Z', 'Asia/Tokyo'))).toBe(2);
    expect(localDayOffset(z('2027-02-28T00:00:00Z', 'Asia/Tokyo'), z('2027-03-01T00:00:00Z', 'Asia/Tokyo'))).toBe(1);
  });
});

describe('elapsedSeconds with DST edge instants', () => {
  it('wall-clock 01:00 to 04:00 across the Paris fall-back is 4 hours; across spring-forward 02:00 -> 04:00 does not exist but 01:30 -> 03:30 is 1 hour', () => {
    const start = fromLocal('2026-10-25', '01:00', 'Europe/Paris');
    const end = fromLocal('2026-10-25', '04:00', 'Europe/Paris');
    if (start.kind !== 'exact' || end.kind !== 'exact') throw new Error('expected exact');
    expect(elapsedSeconds(z(start.utc, 'Europe/Paris'), z(end.utc, 'Europe/Paris'))).toBe(4 * 3600);

    const s = fromLocal('2026-03-29', '01:30', 'Europe/Paris');
    const e = fromLocal('2026-03-29', '03:30', 'Europe/Paris');
    if (s.kind !== 'exact' || e.kind !== 'exact') throw new Error('expected exact');
    expect(elapsedSeconds(z(s.utc, 'Europe/Paris'), z(e.utc, 'Europe/Paris'))).toBe(3600);
  });

  it('the two instants of an ambiguous wall time are 1 hour apart in Paris and 30 minutes apart in Lord_Howe', () => {
    const p = fromLocal('2026-10-25', '02:30', 'Europe/Paris');
    const l = fromLocal('2026-04-05', '01:45', 'Australia/Lord_Howe');
    if (p.kind !== 'ambiguous' || l.kind !== 'ambiguous') throw new Error('expected ambiguous');
    expect(elapsedSeconds(z(p.earlier, 'Europe/Paris'), z(p.later, 'Europe/Paris'))).toBe(3600);
    expect(elapsedSeconds(z(l.earlier, 'Australia/Lord_Howe'), z(l.later, 'Australia/Lord_Howe'))).toBe(1800);
  });

  it('is exactly 0 (not -0) when the end is a fraction of a second before the start', () => {
    const r = elapsedSeconds(z('2026-07-01T00:00:00.400Z', 'Asia/Tokyo'), z('2026-07-01T00:00:00.000Z', 'Asia/Tokyo'));
    expect(Object.is(r, 0)).toBe(true);
  });
});

describe('tripElapsedSeconds', () => {
  it('does not depend on the order of items within a day or of days', () => {
    const early = makeActivity('early', { start: '2026-07-01T00:00:00Z', end: '2026-07-01T01:00:00Z' });
    const mid = makeLeg('mid', { departure: '2026-07-01T03:00:00Z', arrival: '2026-07-01T04:00:00Z' });
    const late = makeActivity('late', { start: '2026-07-02T05:00:00Z', end: '2026-07-02T09:30:00Z' });
    const expected = 33.5 * 3600; // 2026-07-01T00:00Z -> 2026-07-02T09:30Z
    expect(tripElapsedSeconds([makeDay([early, mid]), makeDay([late], 'Asia/Tokyo', '2026-07-02')])).toBe(expected);
    expect(tripElapsedSeconds([makeDay([late], 'Asia/Tokyo', '2026-07-02'), makeDay([mid, early])])).toBe(expected);
    expect(tripElapsedSeconds([makeDay([late, mid, early])])).toBe(expected);
  });

  it('a single item gives its own duration', () => {
    expect(tripElapsedSeconds([makeDay([makeLeg('l', { departure: '2026-07-01T00:00:00Z', arrival: '2026-07-01T00:45:00Z' })])])).toBe(2700);
  });

  it('spans several days in different zones and includes the idle gap between them', () => {
    // Tokyo day: 2026-07-01 10:00-12:00 JST (01:00Z-03:00Z). Flight 23:00 JST (14:00Z) -> Paris 06:30 CEST next day (04:30Z).
    // Paris day: 2026-07-02 18:00-20:00 CEST (16:00Z-18:00Z).
    const tokyoDay = makeDay([
      makeActivity('tokyo-am', { start: '2026-07-01T01:00:00Z', end: '2026-07-01T03:00:00Z', timeZone: 'Asia/Tokyo' }),
      makeLeg('flight', { departure: '2026-07-01T14:00:00Z', arrival: '2026-07-02T04:30:00Z', timeZone: 'Asia/Tokyo' }),
    ]);
    const parisDay = makeDay(
      [makeActivity('paris-pm', { start: '2026-07-02T16:00:00Z', end: '2026-07-02T18:00:00Z', timeZone: 'Europe/Paris' })],
      'Europe/Paris',
      '2026-07-02',
    );
    expect(tripElapsedSeconds([tokyoDay, parisDay])).toBe(41 * 3600); // 07-01 01:00Z -> 07-02 18:00Z
  });

  it('counts a DST fall-back night as the real elapsed time', () => {
    // Paris 2026-10-24 20:00 CEST (18:00Z) to 2026-10-25 08:00 CET (07:00Z) = 13 real hours, not 12.
    const day = makeDay(
      [
        makeActivity('dinner', { start: '2026-10-24T18:00:00Z', end: '2026-10-24T19:00:00Z', timeZone: 'Europe/Paris' }),
        makeActivity('breakfast', { start: '2026-10-25T06:00:00Z', end: '2026-10-25T07:00:00Z', timeZone: 'Europe/Paris' }),
      ],
      'Europe/Paris',
      '2026-10-24',
    );
    expect(tripElapsedSeconds([day])).toBe(13 * 3600);
  });

  it('is null for a leg that has durationSeconds but no departure or arrival (duration is not a substitute for times)', () => {
    const leg: TravelLeg = { ...makeLeg('l'), durationSeconds: 3600 };
    expect(tripElapsedSeconds([makeDay([leg])])).toBeNull();
    const half: TravelLeg = { ...makeLeg('l2', { departure: '2026-07-01T00:00:00Z' }), durationSeconds: 3600 };
    expect(tripElapsedSeconds([makeDay([half])])).toBeNull();
  });

  it('one unknown item anywhere makes the whole result null, even when all other items are known and in later days', () => {
    const known = makeActivity('k', { start: '2026-07-01T00:00:00Z', end: '2026-07-01T01:00:00Z' });
    const unknownLate = makeActivity('u', { start: null, end: '2026-07-05T01:00:00Z' });
    expect(tripElapsedSeconds([makeDay([known]), makeDay([unknownLate], 'Asia/Tokyo', '2026-07-05')])).toBeNull();
    expect(tripElapsedSeconds([makeDay([unknownLate], 'Asia/Tokyo', '2026-07-05'), makeDay([known])])).toBeNull();
  });

  it('an empty day between populated days does not matter', () => {
    const a = makeActivity('a', { start: '2026-07-01T00:00:00Z', end: '2026-07-01T01:00:00Z' });
    const b = makeActivity('b', { start: '2026-07-03T00:00:00Z', end: '2026-07-03T01:00:00Z' });
    expect(tripElapsedSeconds([makeDay([a]), makeDay([], 'Asia/Tokyo', '2026-07-02'), makeDay([b], 'Asia/Tokyo', '2026-07-03')])).toBe(49 * 3600);
  });

  it('nested items overlapping or contained do not shrink the span', () => {
    const outer = makeActivity('outer', { start: '2026-07-01T00:00:00Z', end: '2026-07-01T10:00:00Z' });
    const inner = makeActivity('inner', { start: '2026-07-01T02:00:00Z', end: '2026-07-01T03:00:00Z' });
    expect(tripElapsedSeconds([makeDay([outer, inner])])).toBe(10 * 3600);
    expect(tripElapsedSeconds([makeDay([inner, outer])])).toBe(10 * 3600);
  });
});
