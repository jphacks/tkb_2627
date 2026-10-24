/** Guide entry point: picks today's / the next item from the trip itself. No location is used. */
import type { Activity, Trip, TripDay } from '@tkb/contracts';

export type GuideDayReason = 'today' | 'upcoming' | 'past' | 'none';

export interface GuideTarget {
  reason: GuideDayReason;
  day: TripDay | null;
  /** First activity of the day that is still planned (not completed/skipped). */
  next: Activity | null;
  /** The activity after `next`, if any. */
  following: Activity | null;
}

/** LocalDate (YYYY-MM-DD) of `now` in the given IANA zone. */
export function localDateIn(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function plannedActivities(day: TripDay): Activity[] {
  return day.items.filter((i): i is Activity => i.type === 'activity' && i.status === 'planned');
}

export function pickGuideTarget(trip: Trip, now: Date): GuideTarget {
  const today = trip.days.find(d => d.date === localDateIn(now, d.timeZone));
  let day: TripDay | null = today ?? null;
  let reason: GuideDayReason = today ? 'today' : 'none';
  if (!day) {
    const upcoming = trip.days.find(d => d.date > localDateIn(now, d.timeZone));
    if (upcoming) {
      day = upcoming;
      reason = 'upcoming';
    } else if (trip.days.length > 0) {
      day = trip.days[trip.days.length - 1] ?? null;
      reason = day ? 'past' : 'none';
    }
  }
  if (!day) return { reason: 'none', day: null, next: null, following: null };
  const planned = plannedActivities(day);
  return { reason, day, next: planned[0] ?? null, following: planned[1] ?? null };
}
