import { describe, expect, it } from 'vitest';
import { makeActivity, makeDay, makeLeg } from '../time/fixtures.ts';
import { tripDiff } from './diff.ts';

const before = [
  makeDay([
    makeActivity('museum', { start: '2026-07-01T01:00:00Z', end: '2026-07-01T03:00:00Z', cost: { amountMinor: 1500, currency: 'EUR' } }),
    makeLeg('metro', { departure: '2026-07-01T03:00:00Z', arrival: '2026-07-01T04:00:00Z', fare: { amountMinor: 200, currency: 'JPY' } }),
  ]),
];

describe('tripDiff', () => {
  it('reports the duration delta and per-currency known cost delta', () => {
    const after = [
      makeDay([
        makeActivity('museum', { start: '2026-07-01T01:00:00Z', end: '2026-07-01T03:00:00Z', cost: { amountMinor: 1500, currency: 'EUR' } }),
        makeLeg('metro', { departure: '2026-07-01T03:00:00Z', arrival: '2026-07-01T05:30:00Z', fare: { amountMinor: 500, currency: 'JPY' } }),
      ]),
    ];
    expect(tripDiff(before, after)).toEqual({
      durationDeltaSeconds: 5400,
      knownCostDelta: [{ amountMinor: 300, currency: 'JPY' }],
      unknownCostItems: [],
    });
  });

  it('has null duration delta when either side has an unknown time, and lists unknown cost items of after', () => {
    const after = [
      makeDay([
        makeActivity('museum', { start: '2026-07-01T01:00:00Z', end: '2026-07-01T03:00:00Z', cost: { amountMinor: 1500, currency: 'EUR' } }),
        makeLeg('metro', { departure: '2026-07-01T03:00:00Z', fare: null }),
      ]),
    ];
    const diff = tripDiff(before, after);
    expect(diff.durationDeltaSeconds).toBeNull();
    expect(diff.unknownCostItems).toEqual(['metro']);
    // Metro fare went from 200 JPY to unknown: the known JPY total drops, it is not presented as a saving of 0 for an unknown.
    expect(diff.knownCostDelta).toEqual([{ amountMinor: -200, currency: 'JPY' }]);
    expect(tripDiff(after, before).durationDeltaSeconds).toBeNull();
  });

  it('does not treat an unknown cost as 0 when nothing else changed', () => {
    const a = [makeDay([makeActivity('walk', { start: '2026-07-01T01:00:00Z', end: '2026-07-01T02:00:00Z' })])];
    expect(tripDiff(a, a)).toEqual({ durationDeltaSeconds: 0, knownCostDelta: [], unknownCostItems: ['walk'] });
  });

  it('validates against the contract schema', async () => {
    const { TripDiff } = await import('@tkb/contracts');
    expect(() => TripDiff.parse(tripDiff(before, before))).not.toThrow();
  });
});
