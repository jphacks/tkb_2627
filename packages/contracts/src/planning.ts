import { z } from 'zod';
import { DataMode, Id, LatLng, Money, SchemaVersion, TimeZone, TransportMode, UtcInstant } from './common.ts';
import { ItineraryItem, PlaceInfo, Trip, TripConstraints, TripDay, TripSummary, TravelLeg, ValidationState } from './trip.ts';

/** K06 adapter query for one segment. */
export const RouteQuery = z.object({
  fromPlaceId: Id,
  toPlaceId: Id,
  departureUtc: UtcInstant,
  mode: z.enum(['transit', 'car', 'walk']),
});
export type RouteQuery = z.infer<typeof RouteQuery>;

/** K05 POST /api/v1/planning-context */
export const PlanningContextRequest = z.object({
  area: z.string().min(1).max(200),
  transportMode: TransportMode,
  maxPlaces: z.number().int().min(1).max(30).default(8),
  placeIds: z.array(Id).max(30).optional(),
  /** Additive (C-1, M1 on #28): IANA zone of the trip area; a place search needs it (PlaceInfo.timeZone). */
  timeZone: TimeZone.optional(),
  /** Additive (C-1): segments to look up. Place ids are resolved against the same area set as `placeIds`. */
  legs: z.array(RouteQuery).max(8).optional(),
});
export type PlanningContextRequest = z.infer<typeof PlanningContextRequest>;

export const PlanningContext = z.object({
  places: z.array(PlaceInfo),
  legs: z.array(TravelLeg),
  /** Field names that could not be obtained, e.g. "fare". */
  unknown: z.array(z.string()),
  dataMode: DataMode,
});
export type PlanningContext = z.infer<typeof PlanningContext>;

export const PlanCandidate = z.object({
  candidateId: Id,
  title: z.string(),
  days: z.array(TripDay),
  reasons: z.array(z.string()),
  warnings: z.array(z.string()),
  excludedPlaceIds: z.array(Id),
  totalKnownCost: z.array(Money),
  hasUnknownCost: z.boolean(),
  validationState: ValidationState,
});
export type PlanCandidate = z.infer<typeof PlanCandidate>;

/** K07 POST /api/v1/plan-batches */
export const PlanBatchCreate = z.strictObject({
  schemaVersion: SchemaVersion,
  baseTripId: Id.nullable(),
  baseRevision: z.number().int().positive().nullable(),
  generationId: Id,
  candidates: z.array(PlanCandidate).min(1).max(3),
  places: z.array(PlaceInfo),
  /** K07: required to apply into a new trip when baseTripId is null. */
  constraints: TripConstraints.optional(),
});
export type PlanBatchCreate = z.infer<typeof PlanBatchCreate>;

export const PlanBatchCreated = z.object({
  batchId: Id,
  candidateIds: z.array(Id),
  validationState: ValidationState,
});
export type PlanBatchCreated = z.infer<typeof PlanBatchCreated>;

/** K07 GET /api/v1/plan-batches/{id} */
export const PlanBatch = z.object({
  batchId: Id,
  baseTripId: Id.nullable(),
  baseRevision: z.number().int().positive().nullable(),
  candidates: z.array(PlanCandidate),
  places: z.array(PlaceInfo),
  createdAt: UtcInstant,
});
export type PlanBatch = z.infer<typeof PlanBatch>;

/** K08 POST /api/v1/trips/apply-candidate */
export const ApplyCandidateRequest = z.strictObject({
  batchId: Id,
  candidateId: Id,
  tripId: Id.nullable(),
  expectedRevision: z.number().int().positive().nullable(),
});
export type ApplyCandidateRequest = z.infer<typeof ApplyCandidateRequest>;

export const TripWriteResult = z.object({
  tripId: Id,
  revision: z.number().int().positive(),
  trip: Trip,
  warnings: z.array(z.string()),
});
export type TripWriteResult = z.infer<typeof TripWriteResult>;

/** K09 GET /api/v1/trips */
export const TripList = z.object({
  items: z.array(TripSummary),
  nextCursor: z.string().nullable(),
});
export type TripList = z.infer<typeof TripList>;

/** K10 PATCH /api/v1/trips/{id}: allow-listed operations only. */
export const TripOperation = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), dayIndex: z.number().int().nonnegative(), position: z.number().int().nonnegative(), item: ItineraryItem }),
  z.object({ op: z.literal('remove'), itemId: Id }),
  z.object({ op: z.literal('move'), itemId: Id, toDayIndex: z.number().int().nonnegative(), toPosition: z.number().int().nonnegative() }),
  z.object({ op: z.literal('update'), itemId: Id, item: ItineraryItem }),
  z.object({ op: z.literal('set_title'), title: z.string().min(1).max(200) }),
]);
export type TripOperation = z.infer<typeof TripOperation>;

export const TripPatchRequest = z.strictObject({
  expectedRevision: z.number().int().positive(),
  operations: z.array(TripOperation).min(1).max(50),
});
export type TripPatchRequest = z.infer<typeof TripPatchRequest>;

/** R11: differences never treat unknown cost as zero. */
export const TripDiff = z.object({
  durationDeltaSeconds: z.number().int().nullable(),
  knownCostDelta: z.array(Money),
  unknownCostItems: z.array(Id),
});
export type TripDiff = z.infer<typeof TripDiff>;

export const TripPatchResult = TripWriteResult.extend({ diff: TripDiff });
export type TripPatchResult = z.infer<typeof TripPatchResult>;

/** K10 extension (A05): POST /api/v1/trips/{id}/alternatives. Preview only; nothing is stored. Same strict body as PATCH. */
export const AlternativesRequest = TripPatchRequest.extend({
  maxAlternatives: z.number().int().min(1).max(3).optional(),
});
export type AlternativesRequest = z.infer<typeof AlternativesRequest>;

/** requested: the edit as asked; reorder: same stops re-sequenced (day end assumed 23:59, labelled as packed); swap: a nearby substitute. */
export const AlternativeKind = z.enum(['requested', 'reorder', 'swap']);
export type AlternativeKind = z.infer<typeof AlternativeKind>;

export const AffectedSegment = z.object({
  dayIndex: z.number().int().nonnegative(),
  fromItemId: Id,
  toItemId: Id,
  /** known: a leg with a duration; none: nothing to travel; unknown: not obtained, left untimed (never 0). */
  travel: z.enum(['known', 'none', 'unknown']),
});
export type AffectedSegment = z.infer<typeof AffectedSegment>;

export const AlternativeCandidate = z.object({
  candidateId: Id,
  kind: AlternativeKind,
  summary: z.string(),
  /** Previewed itinerary for display. Live route details may appear here but are never in `operations`. */
  trip: Trip,
  /** Exactly what K10 PATCH returns for `operations`. */
  diff: TripDiff,
  /** Only when live route details were left out of `operations`: the same measures with them. Display only. */
  displayOnly: z.object({ knownCostDelta: z.array(Money), durationDeltaSeconds: z.number().int().nullable() }).optional(),
  affectedSegments: z.array(AffectedSegment),
  validationState: ValidationState,
  warnings: z.array(z.string()),
  unknown: z.array(z.string()),
  /** Send to PATCH /api/v1/trips/{id} with expectedRevision = baseRevision to apply. null: cannot be written. */
  operations: z.array(TripOperation).nullable(),
});
export type AlternativeCandidate = z.infer<typeof AlternativeCandidate>;

export const AlternativesResult = z.object({
  tripId: Id,
  baseRevision: z.number().int().positive(),
  candidates: z.array(AlternativeCandidate),
});
export type AlternativesResult = z.infer<typeof AlternativesResult>;

export { LatLng };

/** K10 extension (A06): POST /api/v1/trips/{id}/replan. Preview only; the server clock decides "now". Coordinates are never stored, logged or echoed. */
export const ReplanLocation = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('coords'), point: LatLng }),
  z.strictObject({ kind: z.literal('place'), placeId: Id }),
  z.strictObject({ kind: z.literal('unavailable'), reason: z.enum(['denied', 'error', 'skipped']) }),
]);
export type ReplanLocation = z.infer<typeof ReplanLocation>;

const uniqueIds = (max: number) =>
  z
    .array(Id)
    .max(max)
    .default([])
    .transform(ids => [...new Set(ids)]);

export const ReplanRequest = z.strictObject({
  expectedRevision: z.number().int().positive(),
  location: ReplanLocation,
  completedActivityIds: uniqueIds(200),
  /** Fixed (reserved) activities the traveller says they missed. Reported as conflicts, never moved. */
  missedActivityIds: uniqueIds(50),
  /** Pinned for this run only: treated as fixed while re-timing. The stored `fixed` flag never changes. */
  fixedActivityIds: uniqueIds(200),
  /** Destination change (K10 operations) applied before re-timing. */
  operations: z.array(TripOperation).max(50).default([]),
  maxCandidates: z.number().int().min(1).max(2).default(1),
});
export type ReplanRequest = z.infer<typeof ReplanRequest>;

export const ReplanStartKind = z.enum(['coords', 'place', 'last_completed', 'ongoing', 'none']);
export type ReplanStartKind = z.infer<typeof ReplanStartKind>;
export const ReplanConflictReason = z.enum(['missed', 'unreachable', 'travel_unknown', 'time_unknown']);
export type ReplanConflictReason = z.infer<typeof ReplanConflictReason>;

export const ReplanCandidate = z.object({
  candidateId: Id,
  kind: z.enum(['keep_order', 'reorder']),
  summary: z.string(),
  trip: Trip,
  /** Exactly what K10 PATCH returns for `operations`. */
  diff: TripDiff,
  /** Only when live route details were left out of `operations`: the same measures with them. Display only. */
  displayOnly: z.object({ knownCostDelta: z.array(Money), durationDeltaSeconds: z.number().int().nullable() }).optional(),
  validationState: ValidationState,
  warnings: z.array(z.string()),
  unknown: z.array(z.string()),
  /** Send to PATCH /api/v1/trips/{id} with expectedRevision = baseRevision to apply. null: cannot be written. */
  operations: z.array(TripOperation).nullable(),
  kept: z.object({ completed: z.array(Id), fixed: z.array(Id) }),
  retimed: z.array(Id),
  untimed: z.array(z.object({ activityId: Id, reason: z.string() })),
  reservationConflicts: z.array(z.object({ activityId: Id, reason: ReplanConflictReason })),
});
export type ReplanCandidate = z.infer<typeof ReplanCandidate>;

export const ReplanResult = z.object({
  tripId: Id,
  baseRevision: z.number().int().positive(),
  now: UtcInstant,
  dayIndex: z.number().int().nonnegative(),
  /** Where the re-timing started. Never coordinates. */
  start: z.object({ kind: ReplanStartKind, placeId: Id.nullable() }),
  /** Travel from the start to the first remaining stop. Display only: not in `trip` and not in `operations`. */
  startLeg: TravelLeg.nullable(),
  candidates: z.array(ReplanCandidate),
});
export type ReplanResult = z.infer<typeof ReplanResult>;
