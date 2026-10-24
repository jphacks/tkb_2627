import { z } from 'zod';
import { DataMode, Id, LatLng, Money, SchemaVersion, TransportMode, UtcInstant } from './common.ts';
import { ItineraryItem, PlaceInfo, Trip, TripConstraints, TripDay, TripSummary, TravelLeg, ValidationState } from './trip.ts';

/** K05 POST /api/v1/planning-context */
export const PlanningContextRequest = z.object({
  area: z.string().min(1).max(200),
  transportMode: TransportMode,
  maxPlaces: z.number().int().min(1).max(30).default(8),
  placeIds: z.array(Id).max(30).optional(),
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

/** K06 adapter query for one segment. */
export const RouteQuery = z.object({
  fromPlaceId: Id,
  toPlaceId: Id,
  departureUtc: UtcInstant,
  mode: z.enum(['transit', 'car', 'walk']),
});
export type RouteQuery = z.infer<typeof RouteQuery>;

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
  /** K07: required to apply into a new trip. */
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

export { LatLng };
