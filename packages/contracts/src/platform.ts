import { z } from 'zod';
import { DataMode, DataStatus, Id, LatLng, Provenance, SchemaVersion, UtcInstant } from './common.ts';
import { Photo } from './trip.ts';

/** K11 POST /api/v1/auth/login. Claude credentials are never part of app login. */
export const LoginRequest = z.strictObject({
  loginId: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const LoginResponse = z.object({
  userId: Id,
  displayName: z.string(),
  csrfToken: z.string(),
});
export type LoginResponse = z.infer<typeof LoginResponse>;

/** K22 GET /api/v1/capabilities and /local/v1/capabilities */
export const AiUnavailableReason = z.enum([
  'SHARED_ENTRY_NO_PERSONAL_CLAUDE',
  'CLAUDE_EXECUTION_DISABLED',
  'CLI_NOT_FOUND',
  'CLI_NOT_AUTHENTICATED',
  'TERMS_NOT_CONFIRMED',
]);
export const Capabilities = z.object({
  entry: z.enum(['shared', 'personal']),
  aiGeneration: z.object({
    available: z.boolean(),
    runner: z.enum(['none', 'fake', 'claude-code']),
    reason: AiUnavailableReason.nullable(),
  }),
  storage: z.literal('shared-server'),
  dataMode: DataMode,
  schemaVersion: SchemaVersion,
});
export type Capabilities = z.infer<typeof Capabilities>;

export const Health = z.object({
  status: z.literal('ok'),
  service: z.enum(['shared', 'personal']),
  schemaVersion: SchemaVersion,
  time: UtcInstant,
});
export type Health = z.infer<typeof Health>;

/** K18 exports */
export const ExportRequest = z.strictObject({
  /** Optional echo of the path id (K18 example); must equal it when sent. */
  tripId: Id.optional(),
  expectedRevision: z.number().int().positive(),
  format: z.enum(['pdf', 'ics', 'maps']),
});
export type ExportRequest = z.infer<typeof ExportRequest>;
/** An item left out of an export because its provider does not allow export (K18 転載不可の素材). */
export const ExportWithheld = z.object({
  kind: z.enum(['place', 'leg', 'photo']),
  id: Id,
});
export type ExportWithheld = z.infer<typeof ExportWithheld>;
export const ExportStatus = z.object({
  exportId: Id,
  /** `queued` covers both waiting and running jobs. */
  status: z.enum(['queued', 'ready', 'failed', 'expired']),
  url: z.string().nullable(),
  /** Added (schemaVersion 1): items not written to the file. */
  withheld: z.array(ExportWithheld).optional(),
  /** Added (schemaVersion 1): why a job failed (e.g. TIMEOUT). */
  error: z.object({ code: z.string(), message: z.string() }).nullable().optional(),
});
export type ExportStatus = z.infer<typeof ExportStatus>;

/** K19 guides and amenities. Empty result and failed fetch are different states. */
export const AmenityKind = z.enum(['toilet', 'evacuation_site', 'evacuation_shelter']);
export const GuideItem = z.object({
  number: z.number().int().positive(),
  placeId: Id,
  name: z.string(),
  kind: z.union([AmenityKind, z.literal('spot')]),
  location: LatLng.nullable(),
  description: z.string().nullable(),
  photo: Photo.nullable(),
  /** Shelters: designated hazard types, not current opening status. */
  hazards: z.array(z.string()).optional(),
  provenance: Provenance,
});
export type GuideItem = z.infer<typeof GuideItem>;

export const GuideResponse = z.object({
  items: z.array(GuideItem),
  dataStatus: DataStatus,
  reason: z.string().nullable(),
  fetchedAt: UtcInstant.nullable(),
});
export type GuideResponse = z.infer<typeof GuideResponse>;
