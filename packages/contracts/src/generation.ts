import { z } from 'zod';
import { Id, LatLng, SchemaVersion, UtcInstant } from './common.ts';
import { ErrorCode } from './errors.ts';
import { Activity, PlaceInfo, TravelLeg, TripConstraints } from './trip.ts';

/**
 * K01 POST /local/v1/generations (personal entry only, 127.0.0.1:4311).
 * Strict: ownerId and any unknown field are rejected. Idempotency-Key travels in the header.
 */
export const GenerateRequest = z.strictObject({
  mode: z.enum(['generate', 'replan']).default('generate'),
  constraints: TripConstraints,
  baseTripId: Id.nullable().optional(),
  expectedRevision: z.number().int().positive().nullable().optional(),
  /** Replan only (F04/R12). */
  now: UtcInstant.optional(),
  currentLocation: LatLng.nullable().optional(),
  completedActivityIds: z.array(Id).optional(),
  fixedActivityIds: z.array(Id).optional(),
});
export type GenerateRequest = z.infer<typeof GenerateRequest>;

export const JobState = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export type JobState = z.infer<typeof JobState>;
export const TERMINAL_JOB_STATES: readonly JobState[] = ['succeeded', 'failed', 'cancelled'];

export const JobStage = z.enum(['queued', 'collecting_context', 'generating', 'validating', 'saving', 'saved', 'done']);
export type JobStage = z.infer<typeof JobStage>;

export const JobAccepted = z.object({
  jobId: Id,
  state: z.literal('queued'),
  pollAfterMs: z.number().int().positive(),
});
export type JobAccepted = z.infer<typeof JobAccepted>;

export const JobError = z.object({
  code: ErrorCode,
  message: z.string(),
  retryable: z.boolean(),
  requestId: z.string(),
});

/** K02 GET /local/v1/jobs/{jobId}. `succeeded` means candidates are saved in the shared DB (batchId set). */
export const JobStatus = z
  .object({
    jobId: Id,
    state: JobState,
    stage: JobStage,
    batchId: Id.nullable(),
    error: JobError.nullable(),
    updatedAt: UtcInstant,
  })
  .refine(j => j.state !== 'succeeded' || j.batchId !== null, { message: 'succeeded requires batchId', path: ['batchId'] })
  .refine(j => j.state !== 'failed' || j.error !== null, { message: 'failed requires error', path: ['error'] });
export type JobStatus = z.infer<typeof JobStatus>;

/** K21 POST /local/v1/jobs/{jobId}/cancel response. */
export const CancelResult = z.object({
  jobId: Id,
  state: JobState,
  batchId: Id.nullable(),
});
export type CancelResult = z.infer<typeof CancelResult>;

/** A fact the provider allows us to send to the model (maySendToModel=true). */
export const PermittedFact = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('place'), place: PlaceInfo }),
  z.object({ kind: z.literal('leg'), leg: TravelLeg }),
]);
export type PermittedFact = z.infer<typeof PermittedFact>;

/** K03 input to the official Claude Code CLI (stdin). Contains no commands, paths or tokens. */
export const GenerationInput = z.object({
  schemaVersion: SchemaVersion,
  constraints: TripConstraints,
  allowedPlaceIds: z.array(Id),
  facts: z.array(PermittedFact),
  fixedActivities: z.array(Activity),
  instructions: z.string(),
});
export type GenerationInput = z.infer<typeof GenerationInput>;

export const CandidateBlueprint = z.object({
  candidateId: Id,
  title: z.string().optional(),
  /** Must only contain IDs from GenerationInput.allowedPlaceIds; checked by BlueprintParser. */
  activityOrder: z.array(Id).min(1),
  excludedPlaceIds: z.array(Id).optional(),
  reasons: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type CandidateBlueprint = z.infer<typeof CandidateBlueprint>;

/** K03 output: structured_output of the CLI envelope. Unverified until the planner validates it. */
export const PlanBlueprint = z.object({
  schemaVersion: SchemaVersion,
  candidates: z.array(CandidateBlueprint).min(1).max(3),
});
export type PlanBlueprint = z.infer<typeof PlanBlueprint>;
