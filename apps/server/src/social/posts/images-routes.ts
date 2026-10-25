import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  ApiError,
  ERROR_HTTP_STATUS,
  Id,
  POST_IMAGE_MAX_BYTES,
  POST_IMAGE_TYPES,
  PostImageUploaded,
  type ErrorCode,
} from '@tkb/contracts';
import { getImageForViewer, insertImage, type Db } from '@tkb/db';
import { optionalActor, requireActor } from '../../platform/auth/index.ts';
import { sanitizeImage } from './images.ts';

function fail(reply: FastifyReply, requestId: string, code: ErrorCode, message: string, retryable = false) {
  return reply.status(ERROR_HTTP_STATUS[code]).send(ApiError.parse({ code, message, retryable, requestId }));
}
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

/** S07: raw image upload (EXIF stripped) and ACL-checked download. Bytes live in the DB. */
export function registerPostImages(app: FastifyInstance, db: Db): void {
  // Encapsulated so the raw-body parser exists only for this upload route.
  void app.register(async (inst) => {
    inst.addContentTypeParser([...POST_IMAGE_TYPES], { parseAs: 'buffer', bodyLimit: POST_IMAGE_MAX_BYTES }, (_req, body, done) =>
      done(null, body),
    );
    inst.post(
      '/api/v1/post-images',
      { preHandler: app.authenticate, bodyLimit: POST_IMAGE_MAX_BYTES },
      async (req, reply) => {
        const { userId } = requireActor(req);
        const declared = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
        const body = req.body;
        if (!Buffer.isBuffer(body) || body.length === 0) return fail(reply, req.id, 'VALIDATION_FAILED', 'Invalid request.');
        const clean = sanitizeImage(declared, body);
        if (!clean) return fail(reply, req.id, 'VALIDATION_FAILED', 'Unsupported or damaged image.');
        const id = insertImage(db, { ownerId: userId, ...clean, now: nowIso() });
        if (!id) return fail(reply, req.id, 'RATE_LIMITED', 'Too many unused images.', true);
        return reply.status(201).send(
          PostImageUploaded.parse({ imageId: id, url: `/api/v1/post-images/${id}`, width: clean.width, height: clean.height }),
        );
      },
    );
  });

  app.get('/api/v1/post-images/:id', { preHandler: app.optionalAuthenticate }, async (req, reply) => {
    const id = Id.safeParse((req.params as { id: string }).id);
    if (!id.success) return fail(reply, req.id, 'NOT_FOUND', 'Not found.');
    const img = getImageForViewer(db, id.data, optionalActor(req)?.userId ?? null);
    if (!img) return fail(reply, req.id, 'NOT_FOUND', 'Not found.');
    return reply
      .header('content-type', img.contentType)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store')
      .header('content-disposition', 'inline')
      .send(Buffer.from(img.bytes));
  });
}
