/**
 * UI review on #34: the Kanazawa sample must add up. Between two top-level stays the next one starts no earlier than
 * the previous end plus the known leg duration (a visible wait is fine, an overlap is not), and the leg's own times
 * agree with the stays around it.
 */
import { describe, expect, it } from 'vitest';
import type { Activity } from '@tkb/contracts';
import { domesticTrip } from './index.ts';

const ms = (t: { utc: string } | null): number | null => (t ? Date.parse(t.utc) : null);

describe('Kanazawa fixture times are consistent with the legs', () => {
  for (const day of domesticTrip.days) {
    const top = day.items.filter(i => !(i.type === 'activity' && i.parentActivityId));
    top.forEach((leg, i) => {
      if (leg.type !== 'leg') return;
      const prev = top[i - 1] as Activity | undefined;
      const next = top[i + 1] as Activity | undefined;
      it(`${day.date} ${leg.legId}`, () => {
        expect(prev?.type).toBe('activity');
        expect(next?.type).toBe('activity');
        const pe = ms(prev!.end), ns = ms(next!.start);
        const dep = ms(leg.departure), arr = ms(leg.arrival);
        if (pe !== null && dep !== null) expect(dep, 'leg departs after the previous stay ends').toBeGreaterThanOrEqual(pe);
        if (leg.durationSeconds !== null && pe !== null && ns !== null) expect(ns, 'next stay starts after end + duration').toBeGreaterThanOrEqual(pe + leg.durationSeconds * 1000);
        if (arr !== null && ns !== null) expect(ns, 'next stay starts after the leg arrives').toBeGreaterThanOrEqual(arr);
        if (dep !== null && arr !== null && leg.durationSeconds !== null) expect((arr - dep) / 1000).toBe(leg.durationSeconds);
      });
    });
  }
  it('after dinner you walk to a stop (its own spot) before the bus to the hotel', () => {
    const items = domesticTrip.days[0]!.items;
    const ids = items.map(i => (i.type === 'activity' ? i.activityId : i.legId));
    const at = ids.indexOf('fx_act_dinner');
    expect(ids.slice(at, at + 5)).toEqual(['fx_act_dinner', 'fx_leg_k6w', 'fx_act_korinbo_stop', 'fx_leg_k6', 'fx_act_hotel']);
    expect((items[at] as Activity).start).toEqual({ utc: '2026-11-01T08:25:00Z', timeZone: 'Asia/Tokyo' });
  });
});
