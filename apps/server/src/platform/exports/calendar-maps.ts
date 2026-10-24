import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ApiError, ERROR_HTTP_STATUS, ExportWithheld, Id, type ErrorCode } from '@tkb/contracts';
import { getTripForOwner, type Db } from '@tkb/db';
import { tripMapsLinks, tripToIcs } from '@tkb/exports';
import { requireActor } from '../auth/index.ts';

/**
 * E03 / K18 (owner only), pure in-process generation with no external fetch:
 * - GET /api/v1/trips/:id/ics        → text/calendar attachment (ICS, RFC 5545)
 * - GET /api/v1/trips/:id/maps-links → {links:[{dayIndex,url}], withheld:[{kind,id}]}
 * Another user's trip and a missing one are both 404; anonymous is 401. When nothing can be exported: 422 RESTRICTED_ASSET.
 */

export const MapsLinksResponse = z.object({
  links: z.array(z.object({ dayIndex: z.number().int().min(0), url: z.string().url() })),
  withheld: z.array(ExportWithheld),
});
export type MapsLinksResponse = z.infer<typeof MapsLinksResponse>;

function fail(reply: FastifyReply, requestId: string, code: ErrorCode, message: string, details?: Record<string, unknown>) {
  return reply
    .status(ERROR_HTTP_STATUS[code])
    .send(ApiError.parse({ code, message, retryable: false, requestId, ...(details ? { details } : {}) }));
}

/** Safe ASCII filename: the trip id with anything outside [A-Za-z0-9_-] replaced. */
function safeName(tripId: string): string {
  return `trip-${tripId.replace(/[^A-Za-z0-9_-]/g, '_')}.ics`;
}

export function registerCalendarMaps(app: FastifyInstance, db: Db): void {
  const pre = { preHandler: app.authenticate };
  const isExportPath = (url: string) => /^\/api\/v1\/trips\/[^/?]+\/(ics|maps-links)(\?|$)/.test(url);

  app.addHook('onSend', async (req, reply) => {
    if (isExportPath(req.url)) reply.header('cache-control', 'no-store');
  });

  app.get<{ Params: { id: string } }>('/api/v1/trips/:id/ics', pre, async (req, reply) => {
    const { userId } = requireActor(req);
    const tripId = Id.safeParse(req.params.id);
    if (!tripId.success) return fail(reply, req.id, 'NOT_FOUND', 'Not found.');
    const trip = getTripForOwner(db, tripId.data, userId);
    if (!trip) return fail(reply, req.id, 'NOT_FOUND', 'Not found.');
    const result = tripToIcs(trip, { now: new Date().toISOString() });
    if (result.eventCount === 0) {
      return fail(reply, req.id, 'RESTRICTED_ASSET', 'Nothing in this trip can be written to a calendar.', {
        withheld: result.withheldPlaceIds.map(id => ({ kind: 'place', id })),
      });
    }
    return reply
      .header('content-type', 'text/calendar; charset=utf-8')
      .header('content-disposition', `attachment; filename="${safeName(trip.tripId)}"`)
      .send(result.ics);
  });

  app.get<{ Params: { id: string } }>('/api/v1/trips/:id/maps-links', pre, async (req, reply) => {
    const { userId } = requireActor(req);
    const tripId = Id.safeParse(req.params.id);
    if (!tripId.success) return fail(reply, req.id, 'NOT_FOUND', 'Not found.');
    const trip = getTripForOwner(db, tripId.data, userId);
    if (!trip) return fail(reply, req.id, 'NOT_FOUND', 'Not found.');
    const maps = tripMapsLinks(trip);
    const links: MapsLinksResponse['links'] = [];
    maps.days.forEach((day, dayIndex) => {
      const urls = day.routes.length > 0 ? day.routes : day.places.slice(0, 1);
      for (const l of urls) links.push({ dayIndex, url: l.url });
    });
    const withheld = maps.withheldPlaceIds.map(id => ({ kind: 'place' as const, id }));
    if (links.length === 0) {
      return fail(reply, req.id, 'RESTRICTED_ASSET', 'Nothing in this trip can be opened in a map.', { withheld });
    }
    return MapsLinksResponse.parse({ links, withheld });
  });
}
