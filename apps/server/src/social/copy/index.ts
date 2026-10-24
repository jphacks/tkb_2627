import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  ApiError,
  CopyRequest,
  CopyResult,
  ERROR_HTTP_STATUS,
  Id,
  SCHEMA_VERSION,
  Trip,
  type ErrorCode,
  type PostSnapshot,
} from '@tkb/contracts';
import { getPostForViewer, insertTrip, type Db } from '@tkb/db';
import { requireActor } from '../../platform/auth/index.ts';

function fail(reply: FastifyReply, requestId: string, code: ErrorCode, message: string, retryable = false) {
  return reply.status(ERROR_HTTP_STATUS[code]).send(ApiError.parse({ code, message, retryable, requestId }));
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** YYYY-MM-DD plus n calendar days (UTC arithmetic, no time zone involved). */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** True when the last day of a copy starting at `start` still has a 4-digit year (<= 9999-12-31). */
export function fitsCalendar(start: string, dayCount: number): boolean {
  return /^\d{4}-/.test(addDays(start, Math.max(dayCount, 1) - 1));
}

const newId = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;

const SUFFIX = '（コピー）';
export const COPY_LIMIT = 10;
export const COPY_WINDOW_MS = 60_000;

/**
 * F07/K16: builds a new draft trip from a post snapshot only (never from the source trip).
 * Nothing time-dependent is reused: times, fares, platforms and provider provenance are nulled,
 * so the new dates must be re-validated before the trip is trusted.
 */
export function buildCopiedTrip(snapshot: PostSnapshot, ownerId: string, req: CopyRequest, now: string): Trip {
  const known = new Set(snapshot.places.map((p) => p.placeId));
  const dayCount = Math.max(snapshot.days.length, 1);
  // K16 takes a single timeZone, so every day is overwritten with it (the source days may differ).
  const days = snapshot.days.map((d, i) => ({
    date: addDays(req.newStartDate, i),
    timeZone: req.timeZone,
    items: d.items.flatMap((it): Trip['days'][number]['items'] => {
      if (it.type === 'activity') {
        return [
          {
            ...it,
            // New ids: the copy must not share identifiers with the source trip.
            activityId: newId('act'),
            placeId: it.placeId && known.has(it.placeId) ? it.placeId : null,
            start: null,
            end: null,
            // The author's reservation lock and price belong to the old dates; do not carry them over.
            fixed: false,
            cost: null,
            costStatus: 'unknown' as const,
            status: 'planned' as const,
            privateNotes: null,
          },
        ];
      }
      // hidden_N and unknown endpoints cannot be resolved against places, so the leg is dropped.
      if (!known.has(it.fromPlaceId) || !known.has(it.toPlaceId)) return [];
      return [
        {
          ...it,
          legId: newId('leg'),
          departure: null,
          arrival: null,
          durationSeconds: null,
          lineName: null,
          platform: null,
          transfers: null,
          fare: null,
          dataStatus: 'unknown' as const,
          provenance: null,
        },
      ];
    }),
  }));
  const c = snapshot.constraints;
  return Trip.parse({
    schemaVersion: SCHEMA_VERSION,
    tripId: `trip_${randomUUID().replaceAll('-', '')}`,
    ownerId,
    // Keep the suffix: shorten the source title by code points, not the whole string.
    title: req.title ?? `${Array.from(snapshot.title).slice(0, 200 - SUFFIX.length).join('')}${SUFFIX}`,
    revision: 1,
    constraints: {
      area: c.area,
      startDate: req.newStartDate,
      endDate: addDays(req.newStartDate, dayCount - 1),
      timeZone: req.timeZone,
      transportMode: c.transportMode,
    },
    days,
    places: snapshot.places,
    validationState: 'needs_revalidation',
    warnings: [
      '他の人の投稿からコピーした旅程です。新しい日付で再検証が必要です。',
      '時刻・運賃・乗換は引き継いでいません。費用・営業時間・交通は新しい日付で再確認してください。',
    ],
    createdAt: now,
    updatedAt: now,
  });
}

/** K16. Per-user burst limit is in memory (single shared process). */
export function registerCopy(app: FastifyInstance, db: Db): void {
  const recent = new Map<string, number[]>();

  app.post('/api/v1/posts/:id/copy', { preHandler: app.authenticate }, async (req, reply) => {
    const { userId } = requireActor(req);
    reply.header('cache-control', 'no-store');
    const id = Id.safeParse((req.params as { id: string }).id);
    if (!id.success) return fail(reply, req.id, 'NOT_FOUND', 'Not found.');
    // ACL first: an unviewable post is 404 regardless of the body.
    const post = getPostForViewer(db, id.data, userId);
    if (!post) return fail(reply, req.id, 'NOT_FOUND', 'Not found.');
    const body = CopyRequest.safeParse(req.body);
    if (!body.success) return fail(reply, req.id, 'VALIDATION_FAILED', 'Invalid request.');

    const title = body.data.title?.trim();
    if (title === '' || !fitsCalendar(body.data.newStartDate, post.snapshot.days.length)) {
      return fail(reply, req.id, 'VALIDATION_FAILED', 'Invalid request.');
    }
    const input: CopyRequest = title === undefined ? body.data : { ...body.data, title };

    const nowMs = Date.now();
    const hits = (recent.get(userId) ?? []).filter((t) => nowMs - t < COPY_WINDOW_MS);
    if (hits.length >= COPY_LIMIT) {
      recent.set(userId, hits);
      return fail(reply, req.id, 'RATE_LIMITED', 'Too many copies.', true);
    }
    hits.push(nowMs);
    recent.set(userId, hits);
    if (recent.size > 10_000) for (const [k, v] of recent) if (v.every((t) => nowMs - t >= COPY_WINDOW_MS)) recent.delete(k);

    const trip = insertTrip(db, userId, buildCopiedTrip(post.snapshot, userId, input, iso(nowMs)), iso(nowMs));
    return reply.status(201).send(
      CopyResult.parse({ tripId: trip.tripId, ownerId: trip.ownerId, revision: 1, validationState: trip.validationState }),
    );
  });
}
