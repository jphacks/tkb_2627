import type { PlaceInfo, TravelLeg, Trip, UtcInstant } from '@tkb/contracts';
import { PolicyError, type CallBudget, type RouteProvider } from '@tkb/travel-data';

/** Most live route calls one preview may spend (D02 allows 8 per input; this keeps headroom). */
export const MAX_LIVE_ROUTE_CALLS = 6;
/** Fixture lookups are in memory and free, but still bounded. */
const MAX_FIXTURE_LOOKUPS = 80;
const WALK_BELOW_M = 1000;

export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Same rule as K05: a pair closer than 1 km is walked, otherwise the day's mode applies. */
export function legModeFor(from: PlaceInfo | undefined, to: PlaceInfo | undefined, dayMode: TravelLeg['mode']): TravelLeg['mode'] {
  return from?.location && to?.location && distanceM(from.location, to.location) < WALK_BELOW_M ? 'walk' : dayMode;
}

/**
 * Travel legs known during one preview: the trip's own stored legs plus what the K05 sources return.
 * Times are always dropped here (the sequencer derives them from the duration); an unknown duration is never
 * replaced by a number. Provider failures and the call cap simply leave the pair unknown.
 */
export class LegBook {
  private readonly byKey = new Map<string, TravelLeg | null>();
  private readonly byPair = new Map<string, TravelLeg>();
  calls = 0;
  lookups = 0;
  readonly unknownPairs = new Set<string>();

  constructor(
    private readonly o: {
      routes: RouteProvider | null;
      budget: CallBudget;
      signal: AbortSignal;
      /** true: fixture sources (no provider call, no charge). */
      free: boolean;
      places: ReadonlyMap<string, PlaceInfo>;
    },
  ) {}

  private static norm(leg: TravelLeg): TravelLeg | null {
    let seconds = leg.durationSeconds;
    if (seconds === null && leg.departure && leg.arrival) seconds = Math.round((Date.parse(leg.arrival.utc) - Date.parse(leg.departure.utc)) / 1000);
    if (seconds === null || seconds < 0) return null;
    return { ...structuredClone(leg), durationSeconds: seconds, departure: null, arrival: null };
  }

  /** The trip's stored legs are reusable as they are (stored data is already storable). */
  seed(trip: Trip): void {
    for (const d of trip.days) {
      for (const it of d.items) {
        if (it.type !== 'leg') continue;
        const n = LegBook.norm(it);
        if (!n) continue;
        this.byKey.set(`${it.fromPlaceId}|${it.toPlaceId}|${it.mode}`, n);
        if (!this.byPair.has(`${it.fromPlaceId}|${it.toPlaceId}`)) this.byPair.set(`${it.fromPlaceId}|${it.toPlaceId}`, n);
      }
    }
  }

  get(from: string, to: string, mode: TravelLeg['mode']): TravelLeg | null {
    const hit = this.byKey.get(`${from}|${to}|${mode}`);
    if (hit) return structuredClone(hit);
    const any = this.byPair.get(`${from}|${to}`);
    return any ? structuredClone(any) : null;
  }

  has(from: string, to: string, mode: TravelLeg['mode']): boolean {
    return this.byKey.has(`${from}|${to}|${mode}`) || this.byPair.has(`${from}|${to}`);
  }

  async ensure(from: string, to: string, mode: TravelLeg['mode'], departureUtc: UtcInstant): Promise<void> {
    if (from === to || this.has(from, to, mode) || this.byKey.has(`${from}|${to}|${mode}!`)) return;
    const miss = () => {
      this.byKey.set(`${from}|${to}|${mode}!`, null);
      this.unknownPairs.add(`${from}>${to}`);
    };
    const a = this.o.places.get(from);
    const b = this.o.places.get(to);
    if (!this.o.routes || !a || !b) return miss();
    if (this.o.free ? this.lookups >= MAX_FIXTURE_LOOKUPS : this.calls >= MAX_LIVE_ROUTE_CALLS) return miss();
    this.lookups += 1;
    if (!this.o.free) this.calls += 1;
    try {
      const r = await this.o.routes.route({ from: a, to: b, departureUtc, mode }, this.o.budget);
      const n = r.leg ? LegBook.norm(r.leg) : null;
      if (!n) return miss();
      this.byKey.set(`${from}|${to}|${mode}`, n);
    } catch (e) {
      if (e instanceof PolicyError && e.code === 'CANCELLED') throw e;
      miss(); // limits and provider failures: unknown, never guessed
    }
  }
}
