import type { TripDay, ZonedTime } from '@tkb/contracts';
import { parseUtc } from './zone.ts';

function itemEnds(day: TripDay): { start: ZonedTime | null; end: ZonedTime | null }[] {
  return day.items.map(item =>
    item.type === 'activity' ? { start: item.start, end: item.end } : { start: item.departure, end: item.arrival },
  );
}

/**
 * Seconds from the earliest start/departure to the latest end/arrival across all days (includes gaps between items).
 * Returns null when there are no items or any item lacks a start or end: unknown is never 0.
 */
export function tripElapsedSeconds(days: readonly TripDay[]): number | null {
  let min = Infinity;
  let max = -Infinity;
  let count = 0;
  for (const day of days) {
    for (const { start, end } of itemEnds(day)) {
      if (start === null || end === null) return null;
      min = Math.min(min, parseUtc(start.utc));
      max = Math.max(max, parseUtc(end.utc));
      count += 1;
    }
  }
  if (count === 0) return null;
  return Math.round((max - min) / 1000);
}
