import { Id, LatLng, TripOperation, type TravelLeg, type Trip, type TripDiff, type ValidationState } from '@tkb/contracts';

/**
 * POST /api/v1/trips/:id/replan (A06, Issue #30). Not in docs/03_CONTRACTS.md yet; the shapes below are local until
 * M1 adds them. The client never sends the time: the server clock decides "now".
 */
export type ReplanLocation =
  | { kind: 'coords'; point: LatLng }
  | { kind: 'place'; placeId: string }
  | { kind: 'unavailable'; reason: 'denied' | 'error' | 'skipped' };

export interface ReplanRequest {
  expectedRevision: number;
  location: ReplanLocation;
  completedActivityIds: string[];
  /** Fixed (reserved) activities the traveller says they missed. Reported as conflicts, never moved. */
  missedActivityIds: string[];
  /** Pinned for this run only: treated as fixed while re-timing. The stored `fixed` flag never changes. */
  fixedActivityIds: string[];
  /** Destination change (K10 operations) applied before re-timing. */
  operations: TripOperation[];
  maxCandidates: number;
}

export type StartKind = 'coords' | 'place' | 'last_completed' | 'ongoing' | 'none';
export type ConflictReason = 'missed' | 'unreachable' | 'travel_unknown' | 'time_unknown';

export interface ReplanCandidate {
  candidateId: string;
  kind: 'keep_order' | 'reorder';
  summary: string;
  trip: Trip;
  /** Exactly what K10 PATCH returns for `operations`. */
  diff: TripDiff;
  /** Only when live route details were left out of `operations`: the same measures with them. Display only. */
  displayOnly?: { knownCostDelta: TripDiff['knownCostDelta']; durationDeltaSeconds: number | null };
  validationState: ValidationState;
  warnings: string[];
  unknown: string[];
  /** Send to PATCH /api/v1/trips/:id with expectedRevision = baseRevision to apply the candidate. null: not representable. */
  operations: TripOperation[] | null;
  kept: { completed: string[]; fixed: string[] };
  retimed: string[];
  untimed: { activityId: string; reason: string }[];
  reservationConflicts: { activityId: string; reason: ConflictReason }[];
}

export interface ReplanResult {
  tripId: string;
  baseRevision: number;
  now: string;
  dayIndex: number;
  /** Where the re-timing started. Never coordinates. */
  start: { kind: StartKind; placeId: string | null };
  /** Travel from the start to the first remaining stop. Display only: not in `trip` and not in `operations`. */
  startLeg: TravelLeg | null;
  candidates: ReplanCandidate[];
}

const isObject = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
const onlyKeys = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every(k => keys.includes(k));

function parseLocation(raw: unknown): ReplanLocation | null {
  if (!isObject(raw)) return null;
  if (raw.kind === 'coords') {
    const point = LatLng.safeParse(raw.point);
    return onlyKeys(raw, ['kind', 'point']) && point.success ? { kind: 'coords', point: point.data } : null;
  }
  if (raw.kind === 'place') {
    const id = Id.safeParse(raw.placeId);
    return onlyKeys(raw, ['kind', 'placeId']) && id.success ? { kind: 'place', placeId: id.data } : null;
  }
  if (raw.kind === 'unavailable') {
    const r = raw.reason;
    return onlyKeys(raw, ['kind', 'reason']) && (r === 'denied' || r === 'error' || r === 'skipped') ? { kind: 'unavailable', reason: r } : null;
  }
  return null;
}

function parseIds(raw: unknown, max: number): string[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > max) return null;
  const ids: string[] = [];
  for (const x of raw) {
    const id = Id.safeParse(x);
    if (!id.success) return null;
    ids.push(id.data);
  }
  return [...new Set(ids)];
}

/** Strict body: unknown keys are refused. null means invalid (422 VALIDATION_FAILED). */
export function parseReplanRequest(raw: unknown): ReplanRequest | null {
  if (!isObject(raw)) return null;
  if (!onlyKeys(raw, ['expectedRevision', 'location', 'completedActivityIds', 'missedActivityIds', 'fixedActivityIds', 'operations', 'maxCandidates'])) return null;
  const rev = raw.expectedRevision;
  if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 1) return null;
  const location = parseLocation(raw.location);
  const completedActivityIds = parseIds(raw.completedActivityIds, 200);
  const missedActivityIds = parseIds(raw.missedActivityIds, 50);
  const fixedActivityIds = parseIds(raw.fixedActivityIds, 200);
  if (!location || !completedActivityIds || !missedActivityIds || !fixedActivityIds) return null;
  const operations: TripOperation[] = [];
  if (raw.operations !== undefined) {
    if (!Array.isArray(raw.operations) || raw.operations.length > 50) return null;
    for (const op of raw.operations) {
      const p = TripOperation.safeParse(op);
      if (!p.success) return null;
      operations.push(p.data);
    }
  }
  const max = raw.maxCandidates ?? 1;
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > 2) return null;
  return { expectedRevision: rev, location, completedActivityIds, missedActivityIds, fixedActivityIds, operations, maxCandidates: max };
}
