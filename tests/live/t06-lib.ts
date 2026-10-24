// T06 pure helpers (no network, no app imports). Shared by t06-live.mts and t06-plan.test.ts.

/** Google calls allowed in one run. Arithmetic: per area 2 Places searches (観光 + レストラン; both are cache-shared by call 2) + 2 Routes (transit, car) = 4; two areas = 8. */
export const HARD_CAP = 8;
export const GOOGLE_HOSTS = ['places.googleapis.com', 'routes.googleapis.com'] as const;
export type GoogleHost = (typeof GOOGLE_HOSTS)[number];

export interface CaseSpec { id: string; area: string; region: 'domestic' | 'overseas'; mode: 'transit' | 'car'; timeZone: string }

export const AREAS = [
  { area: '金沢', region: 'domestic', timeZone: 'Asia/Tokyo' },
  { area: 'パリ', region: 'overseas', timeZone: 'Europe/Paris' },
] as const;

export function buildCases(): CaseSpec[] {
  return AREAS.flatMap(a => (['transit', 'car'] as const).map(mode => ({ id: `${a.region}-${mode}`, area: a.area, region: a.region, mode, timeZone: a.timeZone })));
}

/** Expected Google calls: per area 2 Places (call 1) + one Routes per leg (call 2 re-uses call 1's Places responses from the in-script cache). */
export function expectedCalls(cases: readonly CaseSpec[]): { places: number; routes: number; total: number } {
  const areas = new Set(cases.map(c => c.area)).size;
  const places = areas * 2;
  const routes = cases.length;
  return { places, routes, total: places + routes };
}

export class CallCap {
  readonly counts: Record<GoogleHost, number> = { 'places.googleapis.com': 0, 'routes.googleapis.com': 0 };
  readonly cap: number;
  constructor(cap: number = HARD_CAP) {
    this.cap = cap;
  }
  get total(): number { return this.counts['places.googleapis.com'] + this.counts['routes.googleapis.com']; }
  /** Throws BEFORE the call that would exceed the cap. */
  record(host: GoogleHost): void {
    if (this.total + 1 > this.cap) throw new Error(`T06: Google call cap ${this.cap} reached; refusing call to ${host}`);
    this.counts[host]++;
  }
}

export function hostOf(input: unknown): string {
  try {
    const s = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as { url?: string }).url ?? '';
    return new URL(s).hostname;
  } catch {
    return '';
  }
}
export const googleHostOf = (input: unknown): GoogleHost | null => (GOOGLE_HOSTS as readonly string[]).includes(hostOf(input)) ? (hostOf(input) as GoogleHost) : null;

/** Tomorrow 10:00 in `timeZone`, as UTC `...Z` (no ms). */
export function tomorrow10Utc(timeZone: string, now: Date = new Date()): string {
  const ymd = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const [y, m, d] = ymd(new Date(now.getTime() + 86_400_000)).split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, 10, 0, 0);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(guess));
  const g = (t: string) => Number(parts.find(p => p.type === t)!.value);
  const asLocal = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return new Date(guess - (asLocal - guess)).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const known = (v: unknown) => v !== null && v !== undefined;
const count = (xs: readonly string[]) => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});

/** Redacted summary of a place list: counts only, no names/addresses/coordinates. */
export function summarizePlaces(places: readonly any[]) {
  return {
    count: places.length,
    dataStatus: count(places.map(p => String(p.dataStatus))),
    source: count(places.map(p => String(p.provenance?.source))),
    fields: {
      openingHours: { returned: places.filter(p => known(p.openingHours)).length, null: places.filter(p => !known(p.openingHours)).length },
      photo: { returned: places.filter(p => known(p.photo)).length, null: places.filter(p => !known(p.photo)).length },
      description: { returned: places.filter(p => known(p.description)).length, null: places.filter(p => !known(p.description)).length },
    },
  };
}

/** Redacted summary of one leg (booleans and enums only). */
export function summarizeLeg(leg: any | undefined) {
  if (!leg) return { returned: false };
  return {
    returned: true,
    mode: leg.mode,
    dataStatus: leg.dataStatus,
    source: leg.provenance?.source ?? null,
    durationKnown: known(leg.durationSeconds),
    fareKnown: known(leg.fare),
    lineNameKnown: known(leg.lineName),
    platformKnown: known(leg.platform),
    transfersKnown: known(leg.transfers),
    transitStopsKnown: !!leg.transit && (known(leg.transit.boardingStop) || known(leg.transit.alightingStop) || (leg.transit.transferStops?.length ?? 0) > 0),
  };
}
