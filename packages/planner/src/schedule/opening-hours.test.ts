import { describe, expect, it } from 'vitest';
import { earliestOpenStart, fitsOpeningHours, parseOpeningHours } from './opening-hours.ts';

describe('parseOpeningHours', () => {
  it('reads daily ranges, full-width digits and the fixture marker', () => {
    expect(parseOpeningHours('9:00-17:00')).toEqual([{ open: 540, close: 1020 }]);
    expect(parseOpeningHours('（fixture）7:00-18:00')).toEqual([{ open: 420, close: 1080 }]);
    expect(parseOpeningHours('１１：３０～１４：００、17:00〜22:00')).toEqual([
      { open: 690, close: 840 },
      { open: 1020, close: 1320 },
    ]);
    expect(parseOpeningHours('24時間')).toEqual([{ open: 0, close: 2880 }]);
    expect(parseOpeningHours('10:00-24:00')).toEqual([{ open: 600, close: 1440 }]);
  });

  it('keeps a range that runs past midnight on the opening day', () => {
    expect(parseOpeningHours('18:00-2:00')).toEqual([{ open: 1080, close: 1560 }]);
  });

  it('returns null for anything it cannot read exactly, instead of guessing', () => {
    for (const text of [
      null,
      '',
      '月曜定休',
      '9:00-17:00（月曜定休）',
      '(月曜定休)9:00-17:00',
      'Mo-Fr 09:00-18:00',
      '9:00-17:00 最終入館16:30',
      '9:00-9:00',
      '25:00-26:00',
      '9:00-24:30',
      '9:00-17:00/9:00-16:30', // overlapping: maybe seasonal alternatives
      '18:00-2:00, 1:00-5:00',
    ]) {
      expect(parseOpeningHours(text), String(text)).toBeNull();
    }
  });
});

describe('fitsOpeningHours / earliestOpenStart', () => {
  const lunchDinner = [
    { open: 690, close: 840 },
    { open: 1020, close: 1320 },
  ];

  it('requires the whole stay inside one range', () => {
    expect(fitsOpeningHours(lunchDinner, 700, 800)).toBe(true);
    expect(fitsOpeningHours(lunchDinner, 800, 1030)).toBe(false); // spans the afternoon break
    expect(fitsOpeningHours(lunchDinner, 1300, 1330)).toBe(false);
  });

  it('accepts an early-morning stay inside a range that opened the previous evening', () => {
    const bar = [{ open: 1080, close: 1560 }];
    expect(fitsOpeningHours(bar, 30, 90)).toBe(true); // 0:30-1:30
    expect(fitsOpeningHours(bar, 60, 150)).toBe(false); // ends 2:30
    expect(fitsOpeningHours(bar, 1380, 1500)).toBe(true); // 23:00-1:00
    expect(fitsOpeningHours(parseOpeningHours('24時間')!, 1380, 1500)).toBe(true);
    expect(fitsOpeningHours(parseOpeningHours('0:00-24:00')!, 1380, 1500)).toBe(true);
  });

  it('finds the earliest start that fits, or null', () => {
    expect(earliestOpenStart(lunchDinner, 600, 60)).toBe(690);
    expect(earliestOpenStart(lunchDinner, 800, 60)).toBe(1020); // 13:20 + 60 would pass 14:00
    expect(earliestOpenStart(lunchDinner, 1300, 60)).toBeNull();
    expect(earliestOpenStart([{ open: 1080, close: 1560 }], 30, 60)).toBe(30);
  });
});
