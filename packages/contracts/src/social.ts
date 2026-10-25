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
    /** S07: images uploaded with POST /api/v1/post-images (max 4). Compatible addition. */
    imageIds: z.array(Id).max(4).optional(),
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

/** S07: who posted. Avatar is generated (initial + colour), never an uploaded photo of the user. */
export const PostAuthor = z.object({
  userId: Id,
  displayName: z.string(),
  avatarInitial: z.string().min(1).max(2),
  avatarColor: z.string().regex(/^#[0-9a-f]{6}$/i),
});
export type PostAuthor = z.infer<typeof PostAuthor>;

/** S07: an image attached to a post. Served with the same visibility as the post; EXIF (incl. GPS) is stripped. */
export const PostImage = z.object({
  imageId: Id,
  url: z.string().startsWith('/api/v1/post-images/'),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
});
export type PostImage = z.infer<typeof PostImage>;

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
  /** S07 additions (optional for compatibility; the S07 server always sends them). */
  author: PostAuthor.optional(),
  isMine: z.boolean().optional(),
  likeCount: z.number().int().nonnegative().optional(),
  likedByMe: z.boolean().optional(),
  images: z.array(PostImage).max(4).optional(),
  updatedAt: UtcInstant.nullable().optional(),
});
export type PostSummary = z.infer<typeof PostSummary>;

export const Post = PostSummary.extend({ snapshot: PostSnapshot });
export type Post = z.infer<typeof Post>;

/** K14 GET /api/v1/posts */
export const FeedQuery = z.object({
  /** S07 adds 'following': posts the viewer may see from users they follow. */
  scope: z.enum(['public', 'groups', 'mine', 'following']),
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

/** S07 PUT|DELETE /api/v1/posts/{id}/like — only posts the viewer may read; idempotent. */
export const LikeState = z.object({ postId: Id, likeCount: z.number().int().nonnegative(), likedByMe: z.boolean() });
export type LikeState = z.infer<typeof LikeState>;

/** S07 GET /api/v1/users/{id}/profile and GET /api/v1/me/profile; PUT|DELETE /api/v1/users/{id}/follow returns it. */
export const UserProfile = z.object({
  user: PostAuthor,
  followerCount: z.number().int().nonnegative(),
  followingCount: z.number().int().nonnegative(),
  followedByMe: z.boolean(),
  isMe: z.boolean(),
});
export type UserProfile = z.infer<typeof UserProfile>;

/** S07 POST /api/v1/post-images (raw body; Content-Type image/jpeg|png|webp; max 5 MB). Owner-only until attached. */
export const POST_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const POST_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const PostImageUploaded = PostImage;
export type PostImageUploaded = z.infer<typeof PostImageUploaded>;

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
export const GroupCreateRequest = z.strictObject({ name: z.string().trim().min(1).max(100) });
export const Group = z.object({ groupId: Id, name: z.string(), role: GroupRole, createdAt: UtcInstant });
export type Group = z.infer<typeof Group>;
/** K17 POST /api/v1/groups/{id}/invites. inviteeId limits who may accept; omit for an open invite link. */
export const GroupInviteCreate = z.strictObject({ inviteeId: Id.nullable().optional() });
export type GroupInviteCreate = z.infer<typeof GroupInviteCreate>;
export const GroupInviteCreated = z.object({ inviteUrl: z.string(), expiresAt: UtcInstant });
export const GroupInviteAccept = z.strictObject({ token: z.string().min(16) });
export const Membership = z.object({ groupId: Id, userId: Id, membership: z.enum(['active', 'revoked']) });
export type Membership = z.infer<typeof Membership>;
