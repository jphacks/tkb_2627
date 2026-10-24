import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import {
  ApiError,
  Capabilities,
  ERROR_HTTP_STATUS,
  CancelResult,
  GenerateRequest,
  JobStatus,
  LoginResponse,
  Health,
  Id,
  LoginRequest,
  SCHEMA_VERSION,
  type ErrorCode,
  type GenerationInput,
} from '@tkb/contracts';
import { FakeRunner, type Runner } from '@tkb/ai';
import { PairingStore, safeEqual } from './auth/pairing.ts';
import { SESSION_COOKIE, SessionStore, parseCookies, sessionCookieHeader, type LocalSession } from './auth/session.ts';
import type { PersonalConfig } from './config.ts';
import { JobManager } from './jobs/index.ts';
import { createSharedClient, type FetchLike, type SharedClient } from './shared-client/index.ts';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const PAIR_PATH = '/local/v1/pair';

export interface BuildAppOptions {
  config: PersonalConfig;
  pairing?: PairingStore;
  runner?: Runner;
  fetch?: FetchLike;
  sharedClient?: SharedClient;
  /** Place IDs a runner result may reference (A04 will derive these from permitted facts). */
  allowedPlaceIds?: readonly string[];
}

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

export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const { config } = opts;
  const pairing = opts.pairing ?? new PairingStore({ ttlMs: config.pairingTtlMs });
  const sessions = new SessionStore();
  const shared = opts.sharedClient ?? createSharedClient({ baseUrl: config.sharedBaseUrl, fetch: opts.fetch });
  // No real Claude CLI runner exists yet (A01 terms unconfirmed): always the fake, even if execution is allowed.
  const jobs = new JobManager({
    runner: opts.runner ?? new FakeRunner(),
    queueLimit: config.aiQueueLimit,
    timeoutMs: config.aiTimeoutMs,
    allowedPlaceIds: opts.allowedPlaceIds ?? [],
  });
  const sessionOf = (req: FastifyRequest): LocalSession | null =>
    sessions.get(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
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
    if (!STATE_CHANGING.has(req.method)) return;
    // State-changing requests need an allowlisted Origin (browsers always send it on POST), or
    // an explicit same-origin Sec-Fetch-Site when Origin is absent. Anything else is refused.
    const site = req.headers['sec-fetch-site'];
    if (site === 'cross-site' || site === 'same-site') return sendError(reply, req.id, 'FORBIDDEN', 'Forbidden.');
    if (origin === undefined && site !== 'same-origin') return sendError(reply, req.id, 'FORBIDDEN', 'Forbidden.');
    if (req.url.split('?')[0] === PAIR_PATH) return; // authenticated by the pairing code instead
    const session = sessionOf(req);
    if (!session) return sendError(reply, req.id, 'UNAUTHENTICATED', 'Pairing required.');
    const csrf = req.headers['x-csrf-token'];
    if (typeof csrf !== 'string' || !safeEqual(csrf, session.csrfToken)) {
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
      // Never available yet: no real runner (A01). Enabling execution only changes the reason.
      aiGeneration: {
        available: false,
        runner: 'fake',
        reason: config.allowClaudeExecution ? 'TERMS_NOT_CONFIRMED' : 'CLAUDE_EXECUTION_DISABLED',
      },
      storage: 'shared-server',
      dataMode: 'fixture',
      schemaVersion: SCHEMA_VERSION,
    }),
  );

  app.post(PAIR_PATH, async (req, reply) => {
    const b = req.body as { code?: unknown } | null | undefined;
    const keys = b && typeof b === 'object' ? Object.keys(b) : [];
    if (keys.length !== 1 || typeof b?.code !== 'string' || b.code.length < 1 || b.code.length > 64) {
      return sendError(reply, req.id, 'VALIDATION_FAILED', 'Invalid request.');
    }
    const r = pairing.verify(b.code);
    if (r === 'expired') return sendError(reply, req.id, 'EXPIRED', 'Pairing code expired or already used.');
    if (r === 'locked') return sendError(reply, req.id, 'RATE_LIMITED', 'Too many attempts; the pairing code was invalidated.');
    if (r === 'invalid') return sendError(reply, req.id, 'FORBIDDEN', 'Forbidden.');
    const s = sessions.create();
    reply.header('set-cookie', sessionCookieHeader(s.id));
    return { csrfToken: s.csrfToken };
  });

  // K11 limited proxy: one fixed upstream path, strict body, nothing client-controlled is forwarded.
  app.post('/local/v1/auth/login', async (req, reply) => {
    const session = sessionOf(req)!;
    const body = LoginRequest.safeParse(req.body);
    if (!body.success) return sendError(reply, req.id, 'VALIDATION_FAILED', 'Invalid request.');
    const r = await shared.login(body.data);
    if (!r.ok) return sendError(reply, req.id, r.code, 'Login failed.', r.retryable);
    if (config.ownerUserId === null || r.userId !== config.ownerUserId) {
      session.upstream = null; // discard the upstream session
      return sendError(reply, req.id, 'FORBIDDEN', 'Forbidden.');
    }
    session.upstream = { userId: r.userId, displayName: r.displayName, cookie: r.cookie, csrfToken: r.csrfToken };
    // csrfToken is the LOCAL session token; the upstream one never leaves the server.
    return LoginResponse.parse({ userId: r.userId, displayName: r.displayName, csrfToken: session.csrfToken });
  });

  // K01. Full job lifecycle/dedup belongs to A03; candidate saving to S04/A04.
  app.post('/local/v1/generations', async (req, reply) => {
    const owner = sessionOf(req)!.upstream?.userId;
    if (!owner) return sendError(reply, req.id, 'UNAUTHENTICATED', 'Login required.');
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key)) {
      return sendError(reply, req.id, 'VALIDATION_FAILED', 'Invalid Idempotency-Key.');
    }
    const body = GenerateRequest.safeParse(req.body);
    if (!body.success) return sendError(reply, req.id, 'VALIDATION_FAILED', 'Invalid request.');
    // User strings stay inside constraints as data; no command line is ever built from them.
    const input: GenerationInput = {
      schemaVersion: SCHEMA_VERSION,
      constraints: body.data.constraints,
      allowedPlaceIds: [], // real allowed IDs come from the shared server (A04); mustVisit is user input
      facts: [],
      fixedActivities: [],
      instructions: 'Return a plan blueprint as structured output.',
    };
    // TODO(A06): replan. Never silently run it as generate.
    if (body.data.mode === 'replan') return sendError(reply, req.id, 'VALIDATION_FAILED', 'mode=replan is not supported yet.');
    const fingerprint = createHash('sha256').update(JSON.stringify(body.data)).digest('hex');
    const r = jobs.submit(owner, key, fingerprint, input, req.id);
    if (r.kind === 'conflict') return sendError(reply, req.id, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key reused with a different request.');
    if (r.kind === 'full') return sendError(reply, req.id, 'QUEUE_FULL', 'Queue is full.', true);
    return reply.status(202).send({ jobId: r.jobId, state: 'queued', pollAfterMs: 2000 });
  });

  const jobIdOf = (req: FastifyRequest) => Id.safeParse((req.params as { jobId: string }).jobId);

  app.get('/local/v1/jobs/:jobId', async (req, reply) => {
    const owner = sessionOf(req)?.upstream?.userId;
    if (!owner) return sendError(reply, req.id, 'UNAUTHENTICATED', 'Login required.');
    const id = jobIdOf(req);
    const st = id.success ? jobs.status(owner, id.data) : null;
    return st ? JobStatus.parse(st) : sendError(reply, req.id, 'NOT_FOUND', 'Not found.');
  });

  app.post('/local/v1/jobs/:jobId/cancel', async (req, reply) => {
    const owner = sessionOf(req)!.upstream?.userId;
    if (!owner) return sendError(reply, req.id, 'UNAUTHENTICATED', 'Login required.');
    const id = jobIdOf(req);
    const r = id.success ? jobs.cancel(owner, id.data) : null;
    if (!r) return sendError(reply, req.id, 'NOT_FOUND', 'Not found.');
    // K21: 202 when the cancel was accepted for a queued/running job, 200 if already terminal.
    const { wasActive, ...result } = r;
    return reply.status(wasActive ? 202 : 200).send(CancelResult.parse(result));
  });

  app.get('/local/v1/session', async (req, reply) => {
    const s = sessionOf(req);
    if (!s) return sendError(reply, req.id, 'UNAUTHENTICATED', 'Pairing required.');
    return { csrfToken: s.csrfToken, userId: s.upstream?.userId ?? null };
  });

  return app;
}
