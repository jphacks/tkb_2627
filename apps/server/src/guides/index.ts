/**
 * U07 / K19: GET /api/v1/amenities (toilets, designated emergency evacuation sites, designated shelters).
 * Public information, no auth. No location is stored or logged; the bbox only lives in the request.
 *
 * Status mapping (documented contract of this route):
 *  - bad bbox / unknown kind or hazard / range too large (PolicyError VALIDATION_FAILED) -> 422
 *  - provider unavailable (live source not connected, dataStatus "unavailable")        -> 503 UNAVAILABLE (retryable)
 *  - unsupported region                                                                 -> 200 with dataStatus "unsupported_region" (never an empty "ok")
 *  - covered range, nothing found                                                       -> 200 items [] with dataStatus "fixture"/"verified"
 * `GET /api/v1/guides` (spot descriptions + licensed photos) lives in ./spots.ts.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AmenityKind as AmenityKindSchema, ApiError, DataStatus, ERROR_HTTP_STATUS, LatLng, Provenance, UtcInstant, type ErrorCode } from '@tkb/contracts';
import { FixtureAmenitiesProvider, HAZARD_TYPES, PolicyError, type AmenitiesProvider, type HazardType } from '@tkb/travel-data';

/** Local response schema: GuideResponse cannot carry hazard flags / openNow, and contracts are not changed here. */
export const AmenityResponseItem = z.object({
  id: z.string(),
  kind: AmenityKindSchema,
  name: z.string(),
  location: LatLng,
  hazards: z.record(z.string(), z.boolean().nullable()).optional(),
  accessible: z.boolean().nullable().optional(),
  openingHours: z.string().nullable().optional(),
  /** Always null: a designation is not a current opening. */
  openNow: z.null(),
  warning: z.string(),
  provenance: Provenance,
});
export const AmenityResponse = z.object({
  items: z.array(AmenityResponseItem),
  dataStatus: DataStatus,
  reason: z.string().nullable(),
  fetchedAt: UtcInstant.nullable(),
  supportedRegion: z.string(),
});
export type AmenityResponse = z.infer<typeof AmenityResponse>;

const num = z.string().regex(/^-?\d{1,3}(\.\d{1,8})?$/).transform(Number);
const Query = z.object({
  bbox: z.string(),
  kind: z.union([z.string(), z.array(z.string())]).optional(),
  hazard: z.string().optional(),
}).strict();

function fail(reply: FastifyReply, reqId: string, code: ErrorCode, message: string, retryable = false) {
  return reply.status(ERROR_HTTP_STATUS[code]).header('cache-control', 'no-store').send(ApiError.parse({ code, message, retryable, requestId: reqId }));
}

export function registerGuides(app: FastifyInstance, provider: AmenitiesProvider = new FixtureAmenitiesProvider()): void {
  app.get('/api/v1/amenities', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const q = Query.safeParse(req.query);
    if (!q.success) return fail(reply, req.id, 'VALIDATION_FAILED', 'クエリが不正です。');
    const parts = q.data.bbox.split(',');
    const nums = parts.length === 4 ? parts.map(p => num.safeParse(p.trim())) : [];
    if (nums.length !== 4 || nums.some(n => !n.success)) return fail(reply, req.id, 'VALIDATION_FAILED', 'bbox は south,west,north,east の数値4つで指定してください。');
    const [south, west, north, east] = nums.map(n => (n as { data: number }).data) as [number, number, number, number];
    const kinds = (Array.isArray(q.data.kind) ? q.data.kind : q.data.kind ? [q.data.kind] : []).flatMap(k => k.split(',')).filter(k => k !== '');
    const parsedKinds = kinds.map(k => AmenityKindSchema.safeParse(k));
    if (parsedKinds.some(k => !k.success)) return fail(reply, req.id, 'VALIDATION_FAILED', '未知の種類です。');
    const hazard = q.data.hazard;
    if (hazard !== undefined && !(HAZARD_TYPES as readonly string[]).includes(hazard)) return fail(reply, req.id, 'VALIDATION_FAILED', '未知の災害種別です。');
    try {
      const r = await provider.search({
        bbox: { south, west, north, east },
        ...(parsedKinds.length > 0 ? { kinds: parsedKinds.map(k => (k as { data: z.infer<typeof AmenityKindSchema> }).data) } : {}),
        ...(hazard !== undefined ? { hazard: hazard as HazardType } : {}),
      });
      if (r.dataStatus === 'unavailable') return fail(reply, req.id, 'UNAVAILABLE', r.reason ?? '公式データを取得できません。', true);
      return AmenityResponse.parse(r);
    } catch (e) {
      if (e instanceof PolicyError && e.code === 'VALIDATION_FAILED') return fail(reply, req.id, 'VALIDATION_FAILED', e.message);
      return fail(reply, req.id, 'UNAVAILABLE', 'データを取得できませんでした。', true);
    }
  });
}
