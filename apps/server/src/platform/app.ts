import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  ApiError,
  Capabilities,
  ERROR_HTTP_STATUS,
  Health,
  SCHEMA_VERSION,
  type ErrorCode,
} from '@tkb/contracts';
import { checkConnection, migrate, openDatabase, type Db } from '@tkb/db';
import { registerAuth } from './auth/index.ts';
import { registerGroups } from '../social/groups/index.ts';
import { registerPosts } from '../social/posts/index.ts';
import type { SharedConfig } from './config.ts';
import { createStaticHandler, SECURITY_HEADERS } from './static.ts';

export interface BuildAppOptions {
  config: SharedConfig;
  /** Inject an already-migrated database (tests). Otherwise opened from config. */
  db?: Db;
}

function sendError(reply: FastifyReply, requestId: string, code: ErrorCode, message: string, retryable = false) {
  const body = ApiError.parse({ code, message, retryable, requestId });
  return reply.status(ERROR_HTTP_STATUS[code]).send(body);
}

/** Maps framework 4xx statuses onto K23 codes without leaking framework messages. */
export function clientErrorCode(status: number): ErrorCode {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404 || status === 405) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  return 'VALIDATION_FAILED';
}

export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const { config } = opts;
  const app = Fastify({
    logger: false,
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    trustProxy: config.trustProxy,
    // Malformed URLs (FST_ERR_BAD_URL etc.) also use the K23 error shape.
    frameworkErrors: (err, req, reply) => {
      // onSend hooks do not run for these early errors, so set the shared headers here.
      reply.header('x-request-id', req.id);
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
      if (config.publicOrigin.startsWith('https://')) reply.header('strict-transport-security', 'max-age=15552000');
      const code = clientErrorCode((err as { statusCode?: number }).statusCode ?? 400);
      return sendError(reply, req.id, code, code === 'VALIDATION_FAILED' ? 'Invalid request.' : 'Request rejected.');
    },
  });

  let db: Db | null = opts.db ?? null;
  const ownsDb = !opts.db;
  if (!db) {
    db = openDatabase(config.databasePath);
    migrate(db);
  }
  const handle = db;
  app.addHook('onClose', async () => {
    if (ownsDb) handle.close();
  });
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
    if (config.publicOrigin.startsWith('https://')) reply.header('strict-transport-security', 'max-age=15552000');
  });

  app.setErrorHandler((err: unknown, req: FastifyRequest, reply: FastifyReply) => {
    const e = err as { statusCode?: number; validation?: unknown };
    const status = e.statusCode;
    if (e.validation) return sendError(reply, req.id, 'VALIDATION_FAILED', 'Invalid request.');
    if (status !== undefined && status >= 400 && status < 500) {
      const code = clientErrorCode(status);
      return sendError(reply, req.id, code, code === 'VALIDATION_FAILED' ? 'Invalid request.' : 'Request rejected.');
    }
    // No stack, message or secret is returned or logged here.
    return sendError(reply, req.id, 'INTERNAL', 'Internal error.', true);
  });
  const staticHandler = createStaticHandler(config.staticDir);
  app.setNotFoundHandler(async (req, reply) => {
    if (staticHandler && (await staticHandler.handle(req, reply))) return reply;
    return sendError(reply, req.id, 'NOT_FOUND', 'Not found.');
  });

  registerAuth(app, handle, config);
  registerGroups(app, handle, config);
  registerPosts(app, handle);

  app.get('/api/v1/health', async (req, reply) => {
    if (!checkConnection(handle)) {
      return sendError(reply, req.id, 'UNAVAILABLE', 'Database unavailable.', true);
    }
    return Health.parse({
      status: 'ok',
      service: 'shared',
      schemaVersion: SCHEMA_VERSION,
      time: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    });
  });

  app.get('/api/v1/capabilities', async () =>
    Capabilities.parse({
      entry: 'shared',
      aiGeneration: { available: false, runner: 'none', reason: 'SHARED_ENTRY_NO_PERSONAL_CLAUDE' },
      storage: 'shared-server',
      dataMode: config.providerMode,
      schemaVersion: SCHEMA_VERSION,
    }),
  );

  return app;
}
