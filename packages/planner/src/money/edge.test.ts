import { describe, expect, it } from 'vitest';
import type { Money } from '@tkb/contracts';
import { TripDiff } from '@tkb/contracts';
import { makeActivity, makeDay, makeLeg } from '../time/fixtures.ts';
import { convert, knownCostDelta, minorUnitDigits, sumByCurrency, summarizeTripCosts, type ExchangeRate } from './currency.ts';
import { tripDiff } from './diff.ts';

const m = (amountMinor: number, currency: string): Money => ({ amountMinor, currency });
const jpy = (n: number) => m(n, 'JPY');
const eur = (n: number) => m(n, 'EUR');
const kwd = (n: number) => m(n, 'KWD');
const rate = (from: string, to: string, r: number, asOf = '2026-07-01T00:00:00Z'): ExchangeRate => ({ from, to, rate: r, asOf, source: 'fixture' });

describe('minorUnitDigits', () => {
  it('3-digit, 2-digit and 0-digit currencies', () => {
    expect(minorUnitDigits('KWD')).toBe(3);
    expect(minorUnitDigits('BHD')).toBe(3);
    expect(minorUnitDigits('KRW')).toBe(0);
    expect(minorUnitDigits('VND')).toBe(0);
    expect(minorUnitDigits('CLP')).toBe(0);
    expect(minorUnitDigits('USD')).toBe(2);
  });

  it('rejects a malformed currency code', () => {
    expect(() => minorUnitDigits('ABCD')).toThrow(RangeError);
  });
});

describe('convert across minor-unit scales', () => {
  it('KWD (3 digits) to JPY (0 digits): 1.234 KWD at 480 JPY/KWD = 592.32 -> 592', () => {
    expect(convert(kwd(1234), 'JPY', [rate('KWD', 'JPY', 480)])).toEqual(jpy(592));
  });

  it('JPY to KWD: 1000 yen at 0.002 KWD/JPY = 2.000 KWD = 2000 fils', () => {
    expect(convert(jpy(1000), 'KWD', [rate('JPY', 'KWD', 0.002)])).toEqual(kwd(2000));
  });

  it('KWD to EUR: 1.000 KWD at 3 EUR/KWD = 3.00 EUR = 300 cents', () => {
    expect(convert(kwd(1000), 'EUR', [rate('KWD', 'EUR', 3)])).toEqual(eur(300));
  });

  it('KWD to BHD (both 3 digits) needs no rescaling', () => {
    expect(convert(kwd(1500), 'BHD', [rate('KWD', 'BHD', 2.5)])).toEqual(m(3750, 'BHD'));
  });

  it('KRW to JPY (both 0 digits)', () => {
    expect(convert(m(10000, 'KRW'), 'JPY', [rate('KRW', 'JPY', 0.11)])).toEqual(jpy(1100));
  });

  it('half rounds away from zero with 3-digit currencies, both signs', () => {
    const one = [rate('KWD', 'EUR', 1)]; // fils / 10 = cents
    expect(convert(kwd(1005), 'EUR', one)).toEqual(eur(101)); // 100.5 -> 101
    expect(convert(kwd(-1005), 'EUR', one)).toEqual(eur(-101)); // -100.5 -> -101
    expect(convert(kwd(1004), 'EUR', one)).toEqual(eur(100));
    expect(convert(kwd(-1004), 'EUR', one)).toEqual(eur(-100));
    expect(convert(kwd(-1006), 'EUR', one)).toEqual(eur(-101));
  });

  it('a negative amount converts with its sign preserved (refund)', () => {
    expect(convert(eur(-1234), 'JPY', [rate('EUR', 'JPY', 160)])).toEqual(jpy(-1974));
  });

  it('zero converts to +0', () => {
    const r = convert(eur(0), 'JPY', [rate('EUR', 'JPY', 160)]);
    expect(r?.currency).toBe('JPY');
    expect(Object.is(r?.amountMinor, 0)).toBe(true);
  });

  it('a tiny negative amount that rounds to zero is +0, not -0 (Intl would render "-0")', () => {
    // -1 euro cent = -0.01 EUR; at 1 JPY/EUR that is -0.01 yen -> rounds to 0.
    const r = convert(eur(-1), 'JPY', [rate('EUR', 'JPY', 1)]);
    expect(r?.currency).toBe('JPY');
    expect(Object.is(r?.amountMinor, 0)).toBe(true);
  });

  it('keeps every digit of an exact integer conversion at 13+ digit magnitudes', () => {
    // 1,234,567,890,123 KRW at 1 JPY/KRW must stay 1,234,567,890,123 JPY (no precision loss from float noise cleanup).
    expect(convert(m(1_234_567_890_123, 'KRW'), 'JPY', [rate('KRW', 'JPY', 1)])).toEqual(jpy(1_234_567_890_123));
  });

  it('large but ordinary amounts stay safe integers', () => {
    const r = convert(eur(100_000_000_00), 'JPY', [rate('EUR', 'JPY', 160)]); // 100 million EUR
    expect(r).toEqual(jpy(16_000_000_000));
    expect(Number.isSafeInteger(r!.amountMinor)).toBe(true);
  });

  it('always returns a safe integer for ordinary inputs, even with an awkward rate', () => {
    for (const cents of [1, 7, 99, 12345, 987_654_321]) {
      const r = convert(eur(cents), 'JPY', [rate('EUR', 'JPY', 161.37)]);
      expect(Number.isInteger(r!.amountMinor), String(cents)).toBe(true);
    }
  });
});

describe('convert rate selection', () => {
  it('a reverse-direction rate alone gives null even when it is the exact inverse', () => {
    expect(convert(eur(100), 'JPY', [rate('JPY', 'EUR', 1 / 160)])).toBeNull();
  });

  it('a chain through a third currency alone gives null, also when both legs share the latest asOf', () => {
    const rates = [rate('EUR', 'USD', 1.1, '2026-08-01T00:00:00Z'), rate('USD', 'JPY', 150, '2026-08-01T00:00:00Z')];
    expect(convert(eur(100), 'JPY', rates)).toBeNull();
  });

  it('rates for other pairs do not leak in', () => {
    const rates = [rate('USD', 'JPY', 150), rate('EUR', 'USD', 1.1), rate('GBP', 'JPY', 200), rate('JPY', 'EUR', 0.006)];
    expect(convert(eur(100), 'JPY', rates)).toBeNull();
    expect(convert(eur(100), 'JPY', [...rates, rate('EUR', 'JPY', 160)])).toEqual(jpy(160));
  });

  it('on an asOf tie the first listed rate wins', () => {
    const a = rate('EUR', 'JPY', 100);
    const b = rate('EUR', 'JPY', 200);
    expect(convert(eur(100), 'JPY', [a, b])).toEqual(jpy(100));
    expect(convert(eur(100), 'JPY', [b, a])).toEqual(jpy(200));
  });

  it('instants are compared as instants: the same moment written with an offset ties', () => {
    const z = rate('EUR', 'JPY', 100, '2026-07-01T00:00:00Z');
    const plus9 = rate('EUR', 'JPY', 200, '2026-07-01T09:00:00+09:00');
    expect(convert(eur(100), 'JPY', [z, plus9])).toEqual(jpy(100));
    expect(convert(eur(100), 'JPY', [plus9, z])).toEqual(jpy(200));
    // And a later instant written with a 'smaller' string still wins.
    const later = rate('EUR', 'JPY', 300, '2026-07-01T09:00:01+09:00');
    expect(convert(eur(100), 'JPY', [z, later])).toEqual(jpy(300));
  });

  it('a newer invalid rate is skipped in favour of an older valid one', () => {
    const older = rate('EUR', 'JPY', 150, '2026-06-01T00:00:00Z');
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(convert(eur(100), 'JPY', [rate('EUR', 'JPY', bad, '2026-09-01T00:00:00Z'), older]), String(bad)).toEqual(jpy(150));
    }
  });

  it('same-currency conversion ignores rates entirely, even a bogus self-rate, and returns a fresh object', () => {
    const original = jpy(500);
    const r = convert(original, 'JPY', [rate('JPY', 'JPY', 7)]);
    expect(r).toEqual(jpy(500));
    expect(r).not.toBe(original);
  });

  it('does not mutate its inputs', () => {
    const money = eur(1234);
    const rates = [rate('EUR', 'JPY', 160)];
    const snapshot = JSON.stringify([money, rates]);
    convert(money, 'JPY', rates);
    expect(JSON.stringify([money, rates])).toBe(snapshot);
  });

  it('no rate for a 3-digit currency pair is null, not a 1.0 fallback', () => {
    expect(convert(kwd(1000), 'JPY', [])).toBeNull();
  });
});

describe('sumByCurrency', () => {
  it('sorts three or more currencies by code regardless of input order', () => {
    const r = sumByCurrency([m(1, 'USD'), jpy(2), m(3, 'GBP'), eur(4), m(5, 'KWD')]);
    expect(r.totals.map(t => t.currency)).toEqual(['EUR', 'GBP', 'JPY', 'KWD', 'USD']);
    expect(r.unknownCount).toBe(0);
  });

  it('is independent of input order and of where the nulls sit', () => {
    const a = sumByCurrency([jpy(100), null, eur(50), jpy(25), null]);
    const b = sumByCurrency([null, null, jpy(25), eur(50), jpy(100)]);
    expect(a).toEqual(b);
    expect(a).toEqual({ totals: [eur(50), jpy(125)], unknownCount: 2 });
  });

  it('negative amounts (refunds) net against positives and a net 0 stays a known 0 total', () => {
    expect(sumByCurrency([jpy(1000), jpy(-1000)])).toEqual({ totals: [jpy(0)], unknownCount: 0 });
    expect(sumByCurrency([jpy(300), jpy(-500)]).totals).toEqual([jpy(-200)]);
  });

  it('does not convert or merge 3-digit and 0-digit currencies', () => {
    expect(sumByCurrency([kwd(1000), jpy(1000)]).totals).toEqual([jpy(1000), kwd(1000)]);
  });

  it('many items stay exact integers', () => {
    const values = Array.from({ length: 1000 }, () => jpy(1_000_000_000));
    expect(sumByCurrency(values).totals).toEqual([jpy(1_000_000_000_000)]);
  });

  it('does not mutate the input', () => {
    const values: (Money | null)[] = [jpy(1), null, eur(2)];
    const snapshot = JSON.stringify(values);
    sumByCurrency(values);
    expect(JSON.stringify(values)).toBe(snapshot);
  });
});

describe('summarizeTripCosts', () => {
  it('empty trip and empty days give no totals and no unknown items', () => {
    expect(summarizeTripCosts([])).toEqual({ totals: [], unknownItemIds: [] });
    expect(summarizeTripCosts([makeDay([]), makeDay([])])).toEqual({ totals: [], unknownItemIds: [] });
  });

  it('a trip with only unknown costs has no totals (not a 0 total) and lists every id', () => {
    const days = [makeDay([makeActivity('a'), makeLeg('l')])];
    expect(summarizeTripCosts(days)).toEqual({ totals: [], unknownItemIds: ['a', 'l'] });
  });

  it('a known free item (0) is a known cost, not unknown', () => {
    const days = [makeDay([makeActivity('park', { cost: jpy(0) })])];
    expect(summarizeTripCosts(days)).toEqual({ totals: [jpy(0)], unknownItemIds: [] });
  });

  it('unknown ids follow day order then item order, not alphabetical order', () => {
    const days = [
      makeDay([makeActivity('z-first'), makeLeg('m-leg'), makeActivity('priced', { cost: jpy(1) })]),
      makeDay([makeLeg('a-last')], 'Asia/Tokyo', '2026-07-02'),
    ];
    expect(summarizeTripCosts(days).unknownItemIds).toEqual(['z-first', 'm-leg', 'a-last']);
  });

  it('keeps JPY, EUR and KWD separate across activities and legs of different days', () => {
    const days = [
      makeDay([makeActivity('a', { cost: eur(1000) }), makeLeg('l', { fare: kwd(500) })]),
      makeDay([makeActivity('b', { cost: jpy(3000) }), makeLeg('l2', { fare: eur(250) })], 'Asia/Tokyo', '2026-07-02'),
    ];
    expect(summarizeTripCosts(days).totals).toEqual([eur(1250), jpy(3000), kwd(500)]);
  });

  it('unknown count equals the number of unknown ids when compared with sumByCurrency over the same items', () => {
    const items = [
      makeActivity('a', { cost: eur(1000) }),
      makeActivity('b'),
      makeLeg('c'),
      makeLeg('d', { fare: jpy(200) }),
    ];
    const summary = summarizeTripCosts([makeDay(items)]);
    const direct = sumByCurrency([eur(1000), null, null, jpy(200)]);
    expect(summary.totals).toEqual(direct.totals);
    expect(summary.unknownItemIds).toHaveLength(direct.unknownCount);
  });
});

describe('knownCostDelta', () => {
  it('both sides empty gives no delta', () => {
    expect(knownCostDelta([], [])).toEqual([]);
  });

  it('negative money (refunds) in either side', () => {
    expect(knownCostDelta([jpy(-500)], [jpy(300)])).toEqual([jpy(800)]);
    expect(knownCostDelta([jpy(500)], [jpy(-300)])).toEqual([jpy(-800)]);
  });

  it('sorts three or more currencies and omits only the zero ones', () => {
    const before = [m(100, 'USD'), jpy(1000), eur(500), kwd(2000)];
    const after = [m(150, 'USD'), jpy(1000), eur(400), kwd(2500), m(70, 'GBP')];
    expect(knownCostDelta(before, after)).toEqual([eur(-100), m(70, 'GBP'), kwd(500), m(50, 'USD')]);
  });

  it('a known 0 total on one side and nothing on the other is not a change', () => {
    expect(knownCostDelta([jpy(0)], [])).toEqual([]);
    expect(knownCostDelta([], [eur(0)])).toEqual([]);
  });

  it('entries repeated for one currency within a side are added together', () => {
    expect(knownCostDelta([jpy(100), jpy(200)], [jpy(100), jpy(250), jpy(50)])).toEqual([jpy(100)]);
  });

  it('three-digit currency deltas stay in fils', () => {
    expect(knownCostDelta([kwd(1000)], [kwd(1001)])).toEqual([kwd(1)]);
  });

  it('does not mutate its inputs', () => {
    const before = [jpy(1)];
    const after = [jpy(5), eur(2)];
    const snapshot = JSON.stringify([before, after]);
    knownCostDelta(before, after);
    expect(JSON.stringify([before, after])).toBe(snapshot);
  });

  it('never returns an amount that is -0', () => {
    const r = knownCostDelta([jpy(5), eur(3)], [jpy(5), eur(4)]);
    expect(r).toEqual([eur(1)]);
    for (const x of r) expect(Object.is(x.amountMinor, -0)).toBe(false);
  });
});

describe('tripDiff', () => {
  const day = (items: Parameters<typeof makeDay>[0]) => [makeDay(items)];
  const timed = (id: string, start: string, end: string, cost?: Money) => makeActivity(id, { start, end, cost: cost ?? null });

  it('two empty trips: duration unknown (null, not 0), no cost change, no unknown items', () => {
    const d = tripDiff([], []);
    expect(d).toEqual({ durationDeltaSeconds: null, knownCostDelta: [], unknownCostItems: [] });
    expect(() => TripDiff.parse(d)).not.toThrow();
  });

  it('empty before and populated after: duration is null (before unknown), after costs appear as a known delta', () => {
    const after = day([timed('a', '2026-07-01T00:00:00Z', '2026-07-01T01:00:00Z', jpy(500))]);
    expect(tripDiff([], after)).toEqual({ durationDeltaSeconds: null, knownCostDelta: [jpy(500)], unknownCostItems: [] });
  });

  it('before has an unknown duration but after is fully known: still null', () => {
    const before = day([makeActivity('a', { start: '2026-07-01T00:00:00Z' })]); // no end
    const after = day([timed('a', '2026-07-01T00:00:00Z', '2026-07-01T02:00:00Z')]);
    expect(tripDiff(before, after).durationDeltaSeconds).toBeNull();
    expect(tripDiff(after, before).durationDeltaSeconds).toBeNull();
  });

  it('a shorter plan has a negative duration delta and 0 stays 0', () => {
    const long = day([timed('a', '2026-07-01T00:00:00Z', '2026-07-01T05:00:00Z')]);
    const short = day([timed('a', '2026-07-01T00:00:00Z', '2026-07-01T03:30:00Z')]);
    expect(tripDiff(long, short).durationDeltaSeconds).toBe(-5400);
    expect(tripDiff(long, long).durationDeltaSeconds).toBe(0);
    expect(Object.is(tripDiff(long, long).durationDeltaSeconds, 0)).toBe(true);
  });

  it('sub-second timestamps still produce an integer delta accepted by the contract', () => {
    const before = day([timed('a', '2026-07-01T00:00:00.000Z', '2026-07-01T01:00:00.000Z')]);
    const after = day([timed('a', '2026-07-01T00:00:00.000Z', '2026-07-01T01:00:01.600Z')]);
    const d = tripDiff(before, after);
    expect(Number.isInteger(d.durationDeltaSeconds)).toBe(true);
    expect(() => TripDiff.parse(d)).not.toThrow();
  });

  it('an item unknown on either side is excluded from the known delta and reported as unknown (R11)', () => {
    const before = day([timed('a', '2026-07-01T00:00:00Z', '2026-07-01T01:00:00Z'), timed('b', '2026-07-01T01:00:00Z', '2026-07-01T02:00:00Z', jpy(100))]);
    const after = day([timed('a', '2026-07-01T00:00:00Z', '2026-07-01T01:00:00Z', jpy(400)), timed('b', '2026-07-01T01:00:00Z', '2026-07-01T02:00:00Z', jpy(150))]);
    // unknown -> known: +400 would treat the old unknown as 0, so 'a' is unknown and only b's +50 is known.
    expect(tripDiff(before, after)).toMatchObject({ knownCostDelta: [jpy(50)], unknownCostItems: ['a'] });
    // known -> unknown: no -400 "saving".
    expect(tripDiff(after, before)).toMatchObject({ knownCostDelta: [jpy(-50)], unknownCostItems: ['a'] });
  });

  it('removing or adding an item with an unknown cost is an unknown change, not "no change"', () => {
    const base = timed('b', '2026-07-01T01:00:00Z', '2026-07-01T02:00:00Z', jpy(100));
    const withUnknown = day([timed('a', '2026-07-01T00:00:00Z', '2026-07-01T01:00:00Z'), base]);
    const without = day([base]);
    expect(tripDiff(withUnknown, without)).toMatchObject({ knownCostDelta: [], unknownCostItems: ['a'] });
    expect(tripDiff(without, withUnknown)).toMatchObject({ knownCostDelta: [], unknownCostItems: ['a'] });
  });

  it('a duplicated id is known only when every occurrence has a cost', () => {
    const before = day([makeActivity('dup', { cost: jpy(100) }), makeActivity('dup', { cost: null })]);
    const after = day([makeActivity('dup', { cost: jpy(100) }), makeActivity('dup', { cost: jpy(300) })]);
    expect(tripDiff(before, after)).toMatchObject({ knownCostDelta: [], unknownCostItems: ['dup'] });
    expect(tripDiff(after, after)).toMatchObject({ knownCostDelta: [], unknownCostItems: [] });
  });

  it('removing a costed item shows a negative known delta; adding a new currency shows a separate entry', () => {
    const before = day([timed('a', '2026-07-01T00:00:00Z', '2026-07-01T01:00:00Z', jpy(1000))]);
    const after = day([timed('b', '2026-07-01T00:00:00Z', '2026-07-01T01:00:00Z', eur(800))]);
    expect(tripDiff(before, after).knownCostDelta).toEqual([eur(800), jpy(-1000)]);
  });

  it('a cost changing currency is not netted against the old currency', () => {
    const before = day([timed('a', '2026-07-01T00:00:00Z', '2026-07-01T01:00:00Z', jpy(1000))]);
    const after = day([timed('a', '2026-07-01T00:00:00Z', '2026-07-01T01:00:00Z', eur(1000))]);
    expect(tripDiff(before, after).knownCostDelta).toEqual([eur(1000), jpy(-1000)]);
  });

  it('unknown items are listed in plan order across days and the same ids as summarizeTripCosts', () => {
    const after = [
      makeDay([makeActivity('z'), makeLeg('y')]),
      makeDay([makeActivity('x'), makeActivity('paid', { cost: jpy(10) })], 'Asia/Tokyo', '2026-07-02'),
    ];
    const d = tripDiff([], after);
    expect(d.unknownCostItems).toEqual(['z', 'y', 'x']);
    expect(d.unknownCostItems).toEqual(summarizeTripCosts(after).unknownItemIds);
  });

  it('every result parses with the contract TripDiff schema', () => {
    const t = (s: string, e: string) => ({ start: s, end: e });
    const a = day([makeActivity('a', { ...t('2026-07-01T00:00:00Z', '2026-07-01T01:00:00Z'), cost: kwd(1234) })]);
    const b = day([makeActivity('a', { ...t('2026-07-01T00:00:00Z', '2026-07-01T03:00:00Z'), cost: jpy(10) }), makeLeg('l')]);
    const c = day([makeActivity('open', { start: '2026-07-01T00:00:00Z' })]);
    for (const [x, y] of [[a, b], [b, a], [a, c], [c, a], [[], []], [c, c]] as const) {
      expect(() => TripDiff.parse(tripDiff(x, y))).not.toThrow();
    }
  });

  it('does not mutate its inputs', () => {
    const before = day([timed('a', '2026-07-01T00:00:00Z', '2026-07-01T01:00:00Z', jpy(1))]);
    const after = day([timed('a', '2026-07-01T00:00:00Z', '2026-07-01T02:00:00Z', jpy(3))]);
    const snapshot = JSON.stringify([before, after]);
    tripDiff(before, after);
    expect(JSON.stringify([before, after])).toBe(snapshot);
  });
});
