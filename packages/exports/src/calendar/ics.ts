import type { Activity, Money, PlaceInfo, TravelLeg, Trip, UtcInstant, ZonedTime } from '@tkb/contracts';

/** Shown next to the ICS download (R19): importing a file is not registering events in the user's account. */
export const ICS_NOTICE =
  'カレンダーアプリに読み込むためのICSファイルです。読み込むと予定が追加されますが、Googleカレンダー等のアカウントへの自動登録は行いません（この機能は提供していません）。';

// ---- Zone helpers (same approach as @tkb/planner time/zone.ts; @tkb/exports does not depend on the planner) ----

const formatters = new Map<string, Intl.DateTimeFormat>();

function wallParts(ms: number, timeZone: string): number[] {
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
  const out: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return [out.year!, out.month!, out.day!, out.hour!, out.minute!, out.second!];
}

/** UTC offset in minutes at an instant (east positive). */
function offsetAt(ms: number, timeZone: string): number {
  const whole = Math.floor(ms / 1000) * 1000;
  const [y, mo, d, h, mi, s] = wallParts(whole, timeZone);
  return (Date.UTC(y!, mo! - 1, d!, h!, mi!, s!) - whole) / 60000;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
/** YYYYMMDDTHHMMSS of an epoch-ms value read as UTC fields. */
const stamp = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
};
const formatOffset = (minutes: number) => `${minutes < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(minutes) / 60))}${pad(Math.abs(minutes) % 60)}`;

/**
 * True when the wall time of `ms` in `timeZone` also happens earlier (DST fall-back). RFC 5545 reads such a local
 * time as its first occurrence, so the second one must be written in UTC instead.
 */
function isSecondOccurrence(ms: number, timeZone: string): boolean {
  const wall = ms + offsetAt(ms, timeZone) * 60000;
  const DAY = 86_400_000;
  return [offsetAt(ms - DAY, timeZone), offsetAt(ms + DAY, timeZone)].some(o => {
    const other = wall - o * 60000;
    return other < ms && offsetAt(other, timeZone) === o;
  });
}

/** DTSTART/DTEND property: local time with TZID (R19), or UTC for the second pass through a repeated hour. */
function dateTime(name: string, t: ZonedTime): string {
  const ms = Date.parse(t.utc);
  if (isSecondOccurrence(ms, t.timeZone)) return `${name}:${stamp(ms)}Z`;
  return `${name};TZID=${t.timeZone}:${stamp(ms + offsetAt(ms, t.timeZone) * 60000)}`;
}

/** VTIMEZONE with explicit observances for every offset change between `from` and `to` (no RRULE). */
function vtimezone(timeZone: string, from: number, to: number): string[] {
  const HOUR = 3_600_000;
  const year = new Date(from).getUTCFullYear();
  const standard = Math.min(offsetAt(Date.UTC(year, 0, 1), timeZone), offsetAt(Date.UTC(year, 6, 1), timeZone));
  const observance = (start: number, before: number, after: number) => {
    const kind = after > standard ? 'DAYLIGHT' : 'STANDARD';
    // DTSTART is the local time of the change, read with the offset in force before it.
    return [`BEGIN:${kind}`, `DTSTART:${stamp(start + before * 60000)}`, `TZOFFSETFROM:${formatOffset(before)}`, `TZOFFSETTO:${formatOffset(after)}`, `END:${kind}`];
  };
  const first = offsetAt(from, timeZone);
  const lines = ['BEGIN:VTIMEZONE', `TZID:${timeZone}`, ...observance(from, first, first)];
  let prev = first;
  for (let t = from + HOUR; t <= to + HOUR; t += HOUR) {
    const now = offsetAt(t, timeZone);
    if (now === prev) continue;
    let lo = t - HOUR;
    let hi = t;
    while (hi - lo > 60000) {
      const mid = lo + Math.floor((hi - lo) / 120000) * 60000;
      if (offsetAt(mid, timeZone) === prev) lo = mid;
      else hi = mid;
    }
    lines.push(...observance(hi, prev, now));
    prev = now;
  }
  return [...lines, 'END:VTIMEZONE'];
}

// ---- Text ----

/** RFC 5545 TEXT escaping: backslash, semicolon, comma and newlines. */
export function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}

const encoder = new TextEncoder();

/** Folds a content line to at most 75 octets per line (continuations start with a space), never splitting a character. */
export function foldLine(line: string): string {
  const parts: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    const limit = parts.length === 0 ? 75 : 74;
    if (bytes + size > limit) {
      parts.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

function money(m: Money | null): string {
  if (m === null) return '未取得';
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency: m.currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const sign = m.amountMinor < 0 ? '-' : '';
  const abs = Math.abs(m.amountMinor);
  const major = digits === 0 ? String(abs) : `${Math.floor(abs / 10 ** digits)}.${String(abs % 10 ** digits).padStart(digits, '0')}`;
  return `${sign}${major} ${m.currency}`;
}

const KIND_LABEL: Record<Activity['kind'], string> = { visit: '訪問', meal: '食事', free_walk: '自由散策', lodging: '宿泊', custom: '予定' };
const MODE_LABEL: Record<TravelLeg['mode'], string> = { transit: '公共交通', car: '車', walk: '徒歩' };
const FIXTURE_NOTE = 'サンプルデータ（fixture）です。実在の時刻・料金・営業時間ではありません。';

// ---- Calendar ----

export interface IcsOptions {
  /** DTSTAMP of every event (the export time); passed in so output is reproducible. */
  now: UtcInstant;
}

export interface IcsResult {
  ics: string;
  filename: string;
  notice: string;
  eventCount: number;
  /** Items not written, with the reason: times unknown are never guessed (R19). */
  omitted: { itemId: string; reason: 'time_unknown' }[];
  /** Places whose details were not written because their provider does not allow export (docs/08). */
  withheldPlaceIds: string[];
}

/**
 * ICS (RFC 5545) for a trip (K18 format=ics). Each activity and leg with both times becomes an event in its own time
 * zone, with a VTIMEZONE per zone. Skipped activities are left out and private notes are never written. Place names
 * and coordinates are written only when the provider allows export.
 */
export function tripToIcs(trip: Pick<Trip, 'tripId' | 'title' | 'days' | 'places'>, options: IcsOptions): IcsResult {
  const places = new Map(trip.places.map(p => [p.placeId, p]));
  const withheld = new Set<string>();
  const exportable = (placeId: string | null): PlaceInfo | undefined => {
    const place = placeId === null ? undefined : places.get(placeId);
    if (place && !place.provenance.mayExport) {
      withheld.add(place.placeId);
      return undefined;
    }
    return place;
  };

  const omitted: IcsResult['omitted'] = [];
  const events: { id: string; start: ZonedTime; end: ZonedTime; props: string[] }[] = [];
  for (const day of trip.days) {
    for (const item of day.items) {
      if (item.type === 'activity') {
        if (item.status === 'skipped') continue;
        if (item.start === null || item.end === null) {
          omitted.push({ itemId: item.activityId, reason: 'time_unknown' });
          continue;
        }
        const place = exportable(item.placeId);
        const where = [...new Set([place?.name, item.areaName].filter((v): v is string => Boolean(v)))].join(' / ');
        const description = [
          `${KIND_LABEL[item.kind]}${item.fixed ? '（固定予定）' : ''}${item.status === 'completed' ? '（訪問済み）' : ''}`,
          `費用: ${money(item.cost)}`,
          ...(place?.dataStatus === 'fixture' || item.costStatus === 'fixture' ? [FIXTURE_NOTE] : []),
        ];
        events.push({
          id: item.activityId,
          start: item.start,
          end: item.end,
          props: [
            `SUMMARY:${escapeText(item.title)}`,
            ...(where ? [`LOCATION:${escapeText(where)}`] : []),
            ...(place?.location ? [`GEO:${place.location.lat};${place.location.lng}`] : []),
            `DESCRIPTION:${escapeText(description.join('\n'))}`,
          ],
        });
      } else {
        if (item.departure === null || item.arrival === null) {
          omitted.push({ itemId: item.legId, reason: 'time_unknown' });
          continue;
        }
        const from = exportable(item.fromPlaceId)?.name;
        const to = exportable(item.toPlaceId)?.name;
        const details = item.provenance === null || item.provenance.mayExport;
        const line = details && item.lineName ? item.lineName : MODE_LABEL[item.mode];
        const description = [
          `移動（${MODE_LABEL[item.mode]}）`,
          ...(details && item.platform ? [`乗り場: ${item.platform}`] : []),
          ...(details && item.transfers !== null ? [`乗換: ${item.transfers}回`] : []),
          `運賃: ${details ? money(item.fare) : '未取得'}`,
          ...(item.dataStatus === 'fixture' ? [FIXTURE_NOTE] : []),
        ];
        events.push({
          id: item.legId,
          start: item.departure,
          end: item.arrival,
          props: [`SUMMARY:${escapeText(`移動: ${from ?? '出発地'} → ${to ?? '到着地'}（${line}）`)}`, `DESCRIPTION:${escapeText(description.join('\n'))}`],
        });
      }
    }
  }

  const DAY = 86_400_000;
  const zones = new Map<string, { from: number; to: number }>();
  for (const e of events) {
    for (const t of [e.start, e.end]) {
      const ms = Date.parse(t.utc);
      const z = zones.get(t.timeZone);
      zones.set(t.timeZone, { from: Math.min(z?.from ?? ms, ms - DAY), to: Math.max(z?.to ?? ms, ms + DAY) });
    }
  }
  const dtstamp = `${stamp(Date.parse(options.now))}Z`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//tkb_2627//travel planner//JA',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(trip.title)}`,
    ...[...zones.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).flatMap(([tz, r]) => vtimezone(tz, r.from, r.to)),
    ...events.flatMap(e => [
      'BEGIN:VEVENT',
      `UID:${e.id}.${trip.tripId}@tkb-2627`,
      `DTSTAMP:${dtstamp}`,
      dateTime('DTSTART', e.start),
      dateTime('DTEND', e.end),
      ...e.props,
      'END:VEVENT',
    ]),
    'END:VCALENDAR',
  ];
  return {
    ics: `${lines.map(foldLine).join('\r\n')}\r\n`,
    filename: `${trip.tripId}.ics`,
    notice: ICS_NOTICE,
    eventCount: events.length,
    omitted,
    withheldPlaceIds: [...withheld],
  };
}
