/** Places API (New) OpeningHours.Point: day 0 = Sunday. */
export interface GPoint {
  day?: number;
  hour?: number;
  minute?: number;
}
export interface GOpeningHours {
  periods?: { open?: GPoint; close?: GPoint }[];
  weekdayDescriptions?: string[];
}

const hm = (p: GPoint) => `${p.hour ?? 0}:${String(p.minute ?? 0).padStart(2, '0')}`;

/**
 * Turns provider opening hours into PlaceInfo.openingHours (free text, K06). When every day of the week has exactly
 * the same ranges, it writes them as "9:00-17:00" (or "11:30-14:00, 17:00-22:00", or "24時間"), which D06 can check.
 * Anything else (a closed day, days that differ) keeps the provider's own weekday descriptions joined with " / ":
 * shown to the user, read by D06 as unknown. Nothing usable gives null. Never invents hours.
 */
export function openingHoursText(hours: GOpeningHours | undefined): string | null {
  if (!hours) return null;
  const periods = hours.periods ?? [];
  const descriptions = (hours.weekdayDescriptions ?? []).filter(d => d.trim() !== '');
  const fallback = descriptions.length > 0 ? descriptions.join(' / ') : null;

  // Always open: one period opening Sunday 0:00 with no close (Places API reference).
  if (periods.length === 1 && !periods[0]!.close && periods[0]!.open?.day === 0 && (periods[0]!.open.hour ?? 0) === 0 && (periods[0]!.open.minute ?? 0) === 0) {
    return '24時間';
  }
  if (periods.length === 0 || periods.some(p => !p.open || !p.close || p.open.day === undefined || p.close.day === undefined)) return fallback;
  // A period must close on its opening day or the next one; anything longer is not a daily pattern.
  if (periods.some(p => p.close!.day !== p.open!.day && p.close!.day !== (p.open!.day! + 1) % 7)) return fallback;

  const byDay = new Map<number, { start: number; text: string }[]>();
  for (const p of periods) {
    const ranges = byDay.get(p.open!.day!) ?? [];
    ranges.push({ start: (p.open!.hour ?? 0) * 60 + (p.open!.minute ?? 0), text: `${hm(p.open!)}-${hm(p.close!)}` });
    byDay.set(p.open!.day!, ranges);
  }
  if (byDay.size !== 7) return fallback; // a day without hours: closed that day, so not the same every day
  const days = [...byDay.values()].map(r => [...r].sort((a, b) => a.start - b.start).map(x => x.text).join(', '));
  if (!days.every(d => d === days[0])) return fallback;
  // Open from 0:00 to the next 0:00 every day is open around the clock.
  return days[0] === '0:00-0:00' ? '24時間' : days[0]!;
}
