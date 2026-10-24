import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { ApiError, Capabilities, ERROR_HTTP_STATUS, Health, SCHEMA_VERSION, type ErrorCode } from '@tkb/contracts';
import type { PersonalConfig } from './config.ts';

function clientErrorCode(status: number): ErrorCode {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404 || status === 405) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  return 'VALIDATION_FAILED';
}

function sendError(reply: FastifyReply, requestId: string, code: ErrorCode, message: string, retryable = false) {
  return reply
    .status(ERROR_HTTP_STATUS[code])
    .send(ApiError.parse({ code, message, retryable, requestId }));
}

export function buildApp(opts: { config: PersonalConfig }): FastifyInstance {
  const { config } = opts;
  const app = Fastify({ logger: false, genReqId: () => randomUUID(), requestIdHeader: false });
  const hosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`, `[::1]:${config.port}`]);
  const origins = new Set([
    `http://127.0.0.1:${config.port}`,
    `http://localhost:${config.port}`,
    `http://[::1]:${config.port}`,
    'http://127.0.0.1:5173',
    'http://localhost:5173',
  ]);

  // DNS-rebinding and cross-site defence. No CORS headers are ever added.
  app.addHook('onRequest', async (req, reply) => {
    const host = req.headers.host;
    if (!host || !hosts.has(host.toLowerCase())) {
      return sendError(reply, req.id, 'FORBIDDEN', 'Forbidden.');
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(origin)) {
      return sendError(reply, req.id, 'FORBIDDEN', 'Forbidden.');
    }
  });
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });
  app.setErrorHandler((err: unknown, req, reply) => {
    const status = (err as { statusCode?: number }).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      return sendError(reply, req.id, clientErrorCode(status), 'Request rejected.');
    }
    return sendError(reply, req.id, 'INTERNAL', 'Internal error.', true);
  });
  app.setNotFoundHandler((req, reply) => sendError(reply, req.id, 'NOT_FOUND', 'Not found.'));

  app.get('/local/v1/health', async () =>
    Health.parse({
      status: 'ok',
      service: 'personal',
      schemaVersion: SCHEMA_VERSION,
      time: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    }),
  );

  app.get('/local/v1/capabilities', async () =>
    Capabilities.parse({
      entry: 'personal',
      aiGeneration: { available: false, runner: 'fake', reason: 'CLAUDE_EXECUTION_DISABLED' },
      storage: 'shared-server',
      dataMode: 'fixture',
      schemaVersion: SCHEMA_VERSION,
    }),
  );

  return app;
}
