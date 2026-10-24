import { z } from 'zod';
import { Id, LocalDate, SchemaVersion, TimeZone, UtcInstant, Visibility } from './common.ts';
import { PlaceInfo, PublicTripConstraints, PublicTripDay, ValidationState } from './trip.ts';

/** Fields removed from every public snapshot (docs/01_SPEC.md SNS). */
export const REDACTED_FIELDS = ['homeAddress', 'preciseCurrentLocation', 'privateNotes'] as const;

/**
 * Immutable public copy of a trip. Built by the server only; never accepted from the browser.
 * Every part is an allow-list. `places` must contain only places referenced by `days`, and only
 * provider data whose provenance allows export.
 */
export const PostSnapshot = z.object({
  schemaVersion: SchemaVersion,
  title: z.string(),
  constraints: PublicTripConstraints,
  days: z.array(PublicTripDay),
  places: z.array(PlaceInfo),
  redactionVersion: z.number().int().positive(),
});
export type PostSnapshot = z.infer<typeof PostSnapshot>;

/** K12 POST /api/v1/posts/preview */
export const PostPreviewRequest = z
  .strictObject({
    tripId: Id,
    sourceRevision: z.number().int().positive(),
    visibility: Visibility,
    groupId: Id.nullable().optional(),
    story: z.string().max(5000),
  })
  .refine(r => (r.visibility === 'group') === Boolean(r.groupId), {
    message: 'groupId is required for group visibility and forbidden otherwise',
    path: ['groupId'],
  });
export type PostPreviewRequest = z.infer<typeof PostPreviewRequest>;

export const PostPreview = z.object({
  previewToken: z.string().min(16),
  snapshot: PostSnapshot,
  redactedFields: z.array(z.string()),
  expiresAt: UtcInstant,
});
export type PostPreview = z.infer<typeof PostPreview>;

/** K13 POST /api/v1/posts */
export const PostCreateRequest = z.strictObject({
  previewToken: z.string().min(16),
  confirmed: z.literal(true),
});
export type PostCreateRequest = z.infer<typeof PostCreateRequest>;

export const PostSummary = z.object({
  postId: Id,
  postRevision: z.number().int().positive(),
  authorDisplayName: z.string(),
  title: z.string(),
  story: z.string(),
  visibility: Visibility,
  groupId: Id.nullable(),
  area: z.string(),
  startDate: LocalDate,
  createdAt: UtcInstant,
});
export type PostSummary = z.infer<typeof PostSummary>;

export const Post = PostSummary.extend({ snapshot: PostSnapshot });
export type Post = z.infer<typeof Post>;

/** K14 GET /api/v1/posts */
export const FeedQuery = z.object({
  scope: z.enum(['public', 'groups', 'mine']),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(20).default(20),
});
export type FeedQuery = z.infer<typeof FeedQuery>;

export const Feed = z.object({
  items: z.array(PostSummary),
  nextCursor: z.string().nullable(),
});
export type Feed = z.infer<typeof Feed>;

/** K15 PATCH /api/v1/posts/{id} */
export const PostPatchRequest = z
  .strictObject({
    expectedPostRevision: z.number().int().positive(),
    visibility: Visibility.optional(),
    groupId: Id.nullable().optional(),
    story: z.string().max(5000).optional(),
  })
  .refine(r => r.visibility === undefined || (r.visibility === 'group') === Boolean(r.groupId), {
    message: 'groupId is required for group visibility and forbidden otherwise',
    path: ['groupId'],
  })
  .refine(r => r.visibility !== undefined || r.groupId === undefined, {
    message: 'groupId can only change together with visibility',
    path: ['groupId'],
  });
export type PostPatchRequest = z.infer<typeof PostPatchRequest>;

/** K16 POST /api/v1/posts/{id}/copy */
export const CopyRequest = z.strictObject({
  newStartDate: LocalDate,
  timeZone: TimeZone,
  title: z.string().min(1).max(200).optional(),
});
export type CopyRequest = z.infer<typeof CopyRequest>;

export const CopyResult = z.object({
  tripId: Id,
  ownerId: Id,
  revision: z.literal(1),
  validationState: ValidationState,
});
export type CopyResult = z.infer<typeof CopyResult>;

/** K17 groups */
export const GroupRole = z.enum(['owner', 'admin', 'member']);
export const GroupCreateRequest = z.strictObject({ name: z.string().min(1).max(100) });
export const Group = z.object({ groupId: Id, name: z.string(), role: GroupRole, createdAt: UtcInstant });
export type Group = z.infer<typeof Group>;
export const GroupInviteCreated = z.object({ inviteUrl: z.string(), expiresAt: UtcInstant });
export const GroupInviteAccept = z.strictObject({ token: z.string().min(16) });
export const Membership = z.object({ groupId: Id, userId: Id, membership: z.enum(['active', 'revoked']) });
export type Membership = z.infer<typeof Membership>;
