/**
 * Daily opening range in local minutes after midnight. `close` exceeds 1440 when the range runs past midnight
 * (18:00-2:00 is { open: 1080, close: 1560 }).
 */
export interface OpeningRange {
  open: number;
  close: number;
}

const DAY_MINUTES = 1440;
const TIME = String.raw`(\d{1,2}):([0-5]\d)`;
const RANGE = new RegExp(String.raw`^${TIME}\s*[-–—~〜]\s*${TIME}$`);
// Only the fixture marker is dropped. Any other note (closed days, last entry...) makes the text unreadable.
const FIXTURE_MARKER = /^\(fixture\)\s*/i;

/**
 * Reads provider opening hours that are the same every day: "9:00-17:00", "11:30-14:00, 17:00-22:00", "24時間".
 * Anything else (weekdays, closed days, notes) returns null: hours are unknown, never guessed (docs/01_SPEC.md).
 */
export function parseOpeningHours(text: string | null): OpeningRange[] | null {
  if (text === null) return null;
  const rest = text.normalize('NFKC').trim().replace(FIXTURE_MARKER, '');
  if (/^(24時間(営業)?|24 ?hours|open 24 hours)$/i.test(rest)) return [{ open: 0, close: DAY_MINUTES }];
  const ranges: OpeningRange[] = [];
  for (const part of rest.split(/\s*[,、/;]\s*/)) {
    const m = RANGE.exec(part);
    if (!m) return null;
    const [oh, om, ch, cm] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    if (oh > 23 || ch > 24 || (ch === 24 && cm !== 0)) return null;
    const open = oh * 60 + om;
    let close = ch * 60 + cm;
    if (close === open) return null;
    if (close < open) close += DAY_MINUTES;
    ranges.push({ open, close });
  }
  return ranges.length > 0 ? ranges.sort((a, b) => a.open - b.open) : null;
}

/**
 * Whether a stay from local minute `start` (0-1439) to `end` (may exceed 1440 for a stay past midnight) fits inside
 * one range, including a range that started the previous evening.
 */
export function fitsOpeningHours(ranges: readonly OpeningRange[], start: number, end: number): boolean {
  return ranges.some(
    r => (r.open <= start && end <= r.close) || (r.close > DAY_MINUTES && r.open <= start + DAY_MINUTES && end + DAY_MINUTES <= r.close),
  );
}

/**
 * Earliest local minute at or after `from` when a stay of `stayMinutes` fits in one range on the same day,
 * or null when none does. Ranges carried over from the previous evening count from minute 0.
 */
export function earliestOpenStart(ranges: readonly OpeningRange[], from: number, stayMinutes: number): number | null {
  let best: number | null = null;
  for (const r of ranges) {
    const windows = [r, ...(r.close > DAY_MINUTES ? [{ open: 0, close: r.close - DAY_MINUTES }] : [])];
    for (const w of windows) {
      const start = Math.max(from, w.open);
      if (start + stayMinutes <= w.close && (best === null || start < best)) best = start;
    }
  }
  return best;
}
