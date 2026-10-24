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
import { createRunner, type CreatedRunner, type RunnerFactoryDeps, type RunnerStatus } from './runner-factory.ts';
import { PairingStore, safeEqual } from './auth/pairing.ts';
import { SESSION_COOKIE, SessionStore, parseCookies, sessionCookieHeader, type LocalSession } from './auth/session.ts';
import type { PersonalConfig } from './config.ts';
import { FileJobStore, JobManager, type GenerationPipeline, type JobManagerOptions, type JobStore } from './jobs/index.ts';
import { createCapabilitiesClient, createContextClient, createPlanBatchClient, createSharedClient, type ContextClient, type FetchLike, type SharedCapabilitiesClient, type PlanBatchClient, type SharedClient } from './shared-client/index.ts';
import { createPipeline } from './generation/pipeline.ts';
import type { JobMetrics } from './generation/metrics.ts';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const PAIR_PATH = '/local/v1/pair';

export interface BuildAppOptions {
  config: PersonalConfig;
  pairing?: PairingStore;
  /** Test/override runner. When given, the factory is bypassed and capabilities stay fake (flag-derived reason). */
  runner?: Runner;
  /** Deps for the single runner factory (W2), e.g. an injected preflight in tests. */
  runnerDeps?: RunnerFactoryDeps;
  fetch?: FetchLike;
  sharedClient?: SharedClient;
  planClient?: PlanBatchClient;
  contextClient?: ContextClient;
  /** Reads the shared server's real dataMode for /local/v1/capabilities (cached 60 s). */
  capabilitiesClient?: SharedCapabilitiesClient;
  /**
   * The A04 generation pipeline (K05 -> model -> assemble -> K07). Default: built from the shared clients. Pass `false`,
   * or give the legacy `allowedPlaceIds` / `save`, to run jobs without it (tests of the job machinery).
   */
  pipeline?: GenerationPipeline | false;
  /** Called with content-free metrics when a pipeline job ends. */
  onMetrics?: (m: JobMetrics) => void;
  /** Legacy (no pipeline): place IDs a runner result may reference. */
  allowedPlaceIds?: readonly string[];
  /** Job journal; default: file store at config.jobDir if set, else in-memory. */
  jobStore?: JobStore;
  /** Restart recovery lookup (S04/A04). */
  findSavedBatch?: (ownerId: string, operationKey: string) => Promise<string | null>;
  /** Legacy candidate saver (no pipeline). Absent: valid output fails UNAVAILABLE. */
  save?: JobManagerOptions['save'];
}

function clientErrorCode(status: number): ErrorCode {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404 || status === 405) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  return 'VALIDATION_FAILED';
}

function sendError(reply: FastifyReply, requestId: string, code: ErrorCode, message: string, retryable = false, details?: Record<string, unknown>) {
  return reply
    .status(ERROR_HTTP_STATUS[code])
    .send(ApiError.parse({ code, message, retryable, requestId, ...(details ? { details } : {}) }));
}

export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const { config } = opts;
  const sessions = new SessionStore();
  const pairing = opts.pairing ?? new PairingStore({ ttlMs: config.pairingTtlMs });
  const shared = opts.sharedClient ?? createSharedClient({ baseUrl: config.sharedBaseUrl, fetch: opts.fetch });
  const planClient = opts.planClient ?? createPlanBatchClient({ baseUrl: config.sharedBaseUrl, fetch: opts.fetch });
  const contextClient = opts.contextClient ?? createContextClient({ baseUrl: config.sharedBaseUrl, fetch: opts.fetch });
  const capabilitiesClient = opts.capabilitiesClient ?? createCapabilitiesClient({ baseUrl: config.sharedBaseUrl, fetch: opts.fetch });
  // Runner: injected one, else whatever the single factory decides at startup (onReady). Until then (and for the
  // fake) jobs use a FakeRunner. Nothing here ever builds a real runner directly (W2).
  let created: CreatedRunner | null = null;
  const initialRunner = opts.runner ?? new FakeRunner();
  const lazyRunner: Runner = { run: (i, s) => (opts.runner ? initialRunner : (created?.runner ?? initialRunner)).run(i, s) };
  const flagStatus = (): RunnerStatus => ({
    available: false,
    runner: 'fake',
    reason: !config.allowClaudeExecution ? 'CLAUDE_EXECUTION_DISABLED' : 'TERMS_NOT_CONFIRMED',
  });
  const runnerStatus = async (): Promise<RunnerStatus> => (opts.runner || !created ? flagStatus() : created.refresh());
  const legacy = opts.pipeline === false || (opts.pipeline === undefined && (opts.save !== undefined || opts.allowedPlaceIds !== undefined));
  const pipeline: GenerationPipeline | undefined = legacy ? undefined : (opts.pipeline || createPipeline({ contextClient, planClient, sessions, maxLiveLegs: config.maxLiveLegs }));
  const jobs = new JobManager({
    pipeline,
    onMetrics: opts.onMetrics,
    runner: lazyRunner,
    queueLimit: config.aiQueueLimit,
    timeoutMs: config.aiTimeoutMs,
    allowedPlaceIds: opts.allowedPlaceIds ?? [],
    store: opts.jobStore ?? (config.jobDir ? new FileJobStore(config.jobDir) : undefined),
    // Restart recovery: ask the shared server (K07 by generationId = operationKey) using the owner's upstream session.
    // No such session (e.g. right after a restart, before login) throws, which JobManager counts as lookupFailed.
    findSavedBatch:
      opts.findSavedBatch ??
      (async (ownerId, operationKey) => {
        const s = sessions.findUpstream(ownerId);
        if (!s) throw new Error('no upstream session');
        return planClient.findPlanBatchByGenerationId(s, operationKey);
      }),
    save: opts.save,
    saveTimeoutMs: config.saveTimeoutMs,
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
  app.addHook('onReady', async () => {
    if (!opts.runner) created = await createRunner(config, opts.runnerDeps); // startup preflight, cached
    await jobs.ready; // restart recovery must finish before serving
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
      // available:true only when the factory returned the real runner AND the (cached) preflight is ok.
      aiGeneration: await runnerStatus(),
      storage: 'shared-server',
      // The shared server's real mode; 'fixture' only when it cannot be reached (nothing live is then claimed).
      dataMode: (await capabilitiesClient.getDataMode()) ?? 'fixture',
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
    if (!r.ok) {
      session.upstream = null; // a failed re-login must not keep the previous identity
      return sendError(reply, req.id, r.code, 'Login failed.', r.retryable);
    }
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
    // User strings stay inside constraints as data; no command line is ever built from them. The model input
    // (allowed place IDs, facts) is built later from K05 by the pipeline, never from this request.
    const legacyInput: GenerationInput = {
      schemaVersion: SCHEMA_VERSION,
      constraints: body.data.constraints,
      allowedPlaceIds: [],
      facts: [],
      fixedActivities: [],
      instructions: 'Return a plan blueprint as structured output.',
    };
    // TODO(A06): replan. Never silently run it as generate.
    if (body.data.mode === 'replan') return sendError(reply, req.id, 'VALIDATION_FAILED', 'mode=replan is not supported yet.');
    // TODO(A06): base trips (replan/edit) are checked via the shared server. Until then never accept and drop it.
    if (body.data.baseTripId != null || body.data.expectedRevision != null) {
      return sendError(reply, req.id, 'VALIDATION_FAILED', 'baseTripId is not supported yet.');
    }
    const fingerprint = createHash('sha256').update(JSON.stringify(body.data)).digest('hex');
    const work = pipeline ? { constraints: body.data.constraints, baseTripId: null, baseRevision: null } : legacyInput;
    const r = jobs.submit(owner, key, fingerprint, work, req.id);
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
    // After the save stage the result may already be committed: never claim cancelled (409, batchId shown).
    if (r.committed) return sendError(reply, req.id, 'ALREADY_COMMITTED', 'The result is already being saved.', false, r.batchId ? { batchId: r.batchId } : undefined);
    const { wasActive, committed: _c, ...result } = r;
    return reply.status(wasActive ? 202 : 200).send(CancelResult.parse(result));
  });

  app.get('/local/v1/session', async (req, reply) => {
    const s = sessionOf(req);
    if (!s) return sendError(reply, req.id, 'UNAUTHENTICATED', 'Pairing required.');
    return { csrfToken: s.csrfToken, userId: s.upstream?.userId ?? null };
  });

  return app;
}
