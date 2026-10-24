import type { LocalDate, TimeZone, UtcInstant, ZonedTime } from '@tkb/contracts';

/** Local wall-clock reading of an instant in a zone. */
export interface LocalReading {
  date: LocalDate;
  /** HH:mm, 24-hour. */
  time: string;
  /** Offset from UTC in minutes at that instant (e.g. Asia/Tokyo is 540). */
  offsetMinutes: number;
}

/** Result of reading a local wall time in a zone (R07). Callers must choose for `ambiguous` and `gap`. */
export type LocalResolution =
  | { kind: 'exact'; utc: UtcInstant }
  /** DST fall-back overlap: the wall time happens twice. `earlier` uses the pre-transition offset. */
  | { kind: 'ambiguous'; earlier: UtcInstant; later: UtcInstant }
  /**
   * DST spring-forward gap: the wall time never happens.
   * `before` keeps the pre-gap wall clock shifted back (02:30 -> 01:30 local), `after` the post-gap one (02:30 -> 03:30 local).
   */
  | { kind: 'gap'; before: UtcInstant; after: UtcInstant };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Epoch milliseconds of a UTC instant string. Throws RangeError when it is not a valid instant. */
export function parseUtc(utc: string): number {
  const ms = Date.parse(utc);
  if (Number.isNaN(ms)) throw new RangeError(`invalid UTC instant: ${utc}`);
  return ms;
}

function toUtcString(ms: number): UtcInstant {
  return new Date(ms).toISOString().replace(/\.000Z$/, 'Z');
}

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsAt(ms: number, timeZone: string): Parts {
  const out: Record<string, number> = {};
  for (const p of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return {
    year: out.year ?? NaN,
    month: out.month ?? NaN,
    day: out.day ?? NaN,
    hour: out.hour ?? NaN,
    minute: out.minute ?? NaN,
    second: out.second ?? NaN,
  };
}

function offsetMsAtMs(ms: number, timeZone: string): number {
  const whole = Math.floor(ms / 1000) * 1000;
  const p = partsAt(whole, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole;
}

/** UTC offset of a zone at an instant, in minutes (east positive). Throws RangeError for a bad instant or zone. */
export function offsetMinutesAt(utc: string, timeZone: TimeZone): number {
  return offsetMsAtMs(parseUtc(utc), timeZone) / 60000;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** Local date, HH:mm and offset of a zoned time, read in its own zone. */
export function toLocal(zoned: ZonedTime): LocalReading {
  const ms = parseUtc(zoned.utc);
  const p = partsAt(ms, zoned.timeZone);
  return {
    date: `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`,
    time: `${pad(p.hour)}:${pad(p.minute)}`,
    offsetMinutes: offsetMsAtMs(ms, zoned.timeZone) / 60000,
  };
}

/**
 * Turns a local date and HH:mm in a zone into a UTC instant.
 * Never picks silently: a DST overlap returns both instants, a DST gap returns the instants on either side.
 */
export function fromLocal(date: LocalDate, time: string, timeZone: TimeZone): LocalResolution {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!d || !t) throw new RangeError(`invalid local date/time: ${date} ${time}`);
  const [year, month, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const wall = Date.UTC(year, month - 1, day, Number(t[1]), Number(t[2]));
  const check = new Date(wall);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new RangeError(`invalid calendar date: ${date}`);
  }

  // Assumes at most one offset change within ±1 day of the wall time (true for all IANA zones 2015-2030 as checked).
  const DAY = 24 * 3600_000;
  const offsetBefore = offsetMsAtMs(wall - DAY, timeZone);
  const offsetAfter = offsetMsAtMs(wall + DAY, timeZone);
  const candidates = [...new Set([offsetBefore, offsetAfter])]
    .map(offset => wall - offset)
    .filter(ms => offsetMsAtMs(ms, timeZone) === wall - ms)
    .sort((a, b) => a - b);

  if (candidates.length === 1) return { kind: 'exact', utc: toUtcString(candidates[0]!) };
  if (candidates.length >= 2) {
    return { kind: 'ambiguous', earlier: toUtcString(candidates[0]!), later: toUtcString(candidates[candidates.length - 1]!) };
  }
  // Gap: the pre-transition offset maps the wall time to the later instant, the post-transition offset to the earlier one.
  return { kind: 'gap', before: toUtcString(wall - offsetAfter), after: toUtcString(wall - offsetBefore) };
}

/** Absolute seconds from `a` to `b` (negative when `b` is earlier). Independent of either zone. */
export function elapsedSeconds(a: ZonedTime, b: ZonedTime): number {
  const seconds = Math.round((parseUtc(b.utc) - parseUtc(a.utc)) / 1000);
  return seconds === 0 ? 0 : seconds;
}

/** How many local calendar days `end` is after `start`, each read in its own zone (overnight Tokyo to Paris flight: 0 or 1). */
export function localDayOffset(start: ZonedTime, end: ZonedTime): number {
  const toDay = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;
  return Math.round(toDay(toLocal(end).date) - toDay(toLocal(start).date));
}
