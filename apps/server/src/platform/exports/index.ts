import type { FastifyInstance, FastifyReply } from 'fastify';
import { ApiError, ERROR_HTTP_STATUS, ExportRequest, ExportStatus, Id, type ErrorCode } from '@tkb/contracts';
import { getTripForOwner, type Db } from '@tkb/db';
import { requireActor } from '../auth/index.ts';
import { ExportJobs, type ExportJobOptions, type ExportRecord } from './jobs.ts';
import { buildPrintModel, localParts } from './print-model.ts';
import { renderPdf } from './pdf.ts';
import type { PrintLine } from './print-model.ts';

export { ExportJobs } from './jobs.ts';

/**
 * E02 / K18 PDF export (owner only).
 * - POST /api/v1/trips/:id/exports  {tripId?, expectedRevision, format:'pdf'} → 202 ExportStatus (queued)
 * - GET  /api/v1/exports/:id        → the PDF when ready, otherwise ExportStatus JSON (queued/failed/expired)
 * - DELETE /api/v1/exports/:id      → 204; a later GET is 404
 * Another user's trip or export and a missing one are both 404. A deleted trip makes its exports 404 too.
 * ICS and Maps URL (E03) are library functions in @tkb/exports and are not served by this route.
 */

export interface ExportsDeps {
  jobs?: ExportJobs;
  jobOptions?: ExportJobOptions;
  /** Replaces the PDF renderer (tests: slow or failing jobs). */
  render?: (lines: PrintLine[], opts: { footer: string }) => Promise<Uint8Array>;
}

function fail(reply: FastifyReply, requestId: string, code: ErrorCode, message: string, details?: Record<string, unknown>) {
  const retryable = code === 'RATE_LIMITED' || code === 'QUEUE_FULL';
  return reply
    .status(ERROR_HTTP_STATUS[code])
    .send(ApiError.parse({ code, message, retryable, requestId, ...(details ? { details } : {}) }));
}

function status(r: ExportRecord): ExportStatus {
  const state = r.state === 'running' ? 'queued' : r.state;
  return ExportStatus.parse({
    exportId: r.exportId,
    status: state,
    url: state === 'ready' ? `/api/v1/exports/${r.exportId}` : null,
    withheld: r.withheld,
    error: r.error,
  });
}

export function registerExports(app: FastifyInstance, db: Db, deps: ExportsDeps = {}): ExportJobs {
  const jobs = deps.jobs ?? new ExportJobs(deps.jobOptions);
  const render = deps.render ?? renderPdf;
  const pre = { preHandler: app.authenticate };

  app.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/api/v1/exports')) reply.header('cache-control', 'no-store');
  });

  app.post<{ Params: { id: string } }>('/api/v1/trips/:id/exports', pre, async (req, reply) => {
    const { userId } = requireActor(req);
    const tripId = Id.safeParse(req.params.id);
    if (!tripId.success) return fail(reply, req.id, 'NOT_FOUND', 'Not found.');
    const body = ExportRequest.safeParse(req.body);
    if (!body.success) return fail(reply, req.id, 'VALIDATION_FAILED', 'Invalid request.');
    const input = body.data;
    if (input.tripId !== undefined && input.tripId !== tripId.data) return fail(reply, req.id, 'VALIDATION_FAILED', 'tripId does not match the path.');
    if (input.format !== 'pdf') return fail(reply, req.id, 'VALIDATION_FAILED', 'Only format=pdf is served here.');
    const trip = getTripForOwner(db, tripId.data, userId);
    if (!trip) return fail(reply, req.id, 'NOT_FOUND', 'Not found.');
    if (trip.revision !== input.expectedRevision) {
      return fail(reply, req.id, 'REVISION_CONFLICT', 'Trip changed.', {
        expectedRevision: input.expectedRevision,
        currentRevision: trip.revision,
      });
    }
    const now = new Date();
    const model = buildPrintModel(trip, now);
    if (model.nothingExportable) {
      return fail(reply, req.id, 'RESTRICTED_ASSET', 'Nothing in this trip may be exported.', {
        withheld: model.withheld.map(({ kind, id }) => ({ kind, id })),
      });
    }
    const at = localParts(now.toISOString(), trip.constraints.timeZone);
    const footer = `tkb_2627 旅のしおり ・ 出力 ${at.date} ${at.time} (${trip.constraints.timeZone})`;
    const queued = jobs.enqueue(
      userId,
      trip.tripId,
      model.filename,
      model.withheld.map(({ kind, id }) => ({ kind, id })),
      () => render(model.lines, { footer }),
    );
    if (!queued.ok) {
      return fail(reply, req.id, queued.code, queued.code === 'RATE_LIMITED' ? 'An export is already in progress.' : 'Export queue is full.');
    }
    return reply.status(202).send(status(queued.record));
  });

  app.get<{ Params: { id: string } }>('/api/v1/exports/:id', pre, async (req, reply) => {
    const { userId } = requireActor(req);
    const record = jobs.get(req.params.id, userId);
    // The file is re-authorized on every fetch: the trip must still exist and belong to the requester.
    if (!record || !getTripForOwner(db, record.tripId, userId)) {
      if (record) jobs.delete(record.exportId, userId);
      return fail(reply, req.id, 'NOT_FOUND', 'Not found.');
    }
    if (record.state === 'ready' && record.bytes) {
      return reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', `attachment; filename="${record.filename}"`)
        .send(Buffer.from(record.bytes));
    }
    return status(record);
  });

  app.delete<{ Params: { id: string } }>('/api/v1/exports/:id', pre, async (req, reply) => {
    const { userId } = requireActor(req);
    if (!jobs.delete(req.params.id, userId)) return fail(reply, req.id, 'NOT_FOUND', 'Not found.');
    return reply.status(204).send();
  });

  return jobs;
}
