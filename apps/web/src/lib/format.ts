import type { Money, ZonedTime } from '@tkb/contracts';

export const UNKNOWN = '未取得';

/** Local time in the ZonedTime's own zone, with the zone name. null is shown as 未取得. */
export function formatZoned(t: ZonedTime | null): string {
  if (t === null) return UNKNOWN;
  const d = new Date(t.utc);
  const time = new Intl.DateTimeFormat('ja-JP', { timeZone: t.timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  const zone = new Intl.DateTimeFormat('ja-JP', { timeZone: t.timeZone, timeZoneName: 'short' })
    .formatToParts(d).find(p => p.type === 'timeZoneName')?.value ?? t.timeZone;
  return `${time} ${zone}（${t.timeZone}）`;
}

/** Date label for a LocalDate (YYYY-MM-DD), independent of the viewer's zone. */
export function formatDay(date: string): string {
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'UTC', month: 'numeric', day: 'numeric', weekday: 'short' }).format(new Date(`${date}T00:00:00Z`));
}

/** Money in minor units; null is 未取得 (never 0). */
export function formatMoney(m: Money | null): string {
  if (m === null) return UNKNOWN;
  const fmt = new Intl.NumberFormat('ja-JP', { style: 'currency', currency: m.currency });
  const digits = fmt.resolvedOptions().maximumFractionDigits ?? 0;
  return fmt.format(m.amountMinor / 10 ** digits);
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return UNKNOWN;
  const min = Math.round(seconds / 60);
  return min >= 60 ? `${Math.floor(min / 60)}時間${min % 60}分` : `${min}分`;
}
