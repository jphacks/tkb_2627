import type { FastifyInstance, FastifyReply } from 'fastify';
import { ApiError, ERROR_HTTP_STATUS, PlanningContext, PlanningContextRequest, type ErrorCode } from '@tkb/contracts';
import { PolicyError } from '@tkb/travel-data';
import { requireActor } from '../../platform/auth/index.ts';
import type { SharedConfig } from '../../platform/config.ts';
import { buildPlanningContext } from './context.ts';
import { createContextSources, type ContextSources } from './sources.ts';
import { createUserLimiter, dailyPerUserFromEnv, type UserLimiter } from './user-limit.ts';
import { limitRoutesPerUser, sharedUserRouteBudget, type UserRouteBudget } from './live-route-budget.ts';

export interface PlanningContextDeps {
  sources?: ContextSources;
  limiter?: UserLimiter;
  now?: () => number;
  /** Per-user daily live Routes call budget (shared with A05). Default: the process-wide one. */
  routeBudget?: UserRouteBudget;
}

function fail(reply: FastifyReply, requestId: string, code: ErrorCode, message: string, retryable = false) {
  return reply.status(ERROR_HTTP_STATUS[code]).send(ApiError.parse({ code, message, retryable, requestId }));
}

/** Codes a PolicyError may surface as; anything else is a generic unavailable. */
const POLICY_CODES: ReadonlySet<ErrorCode> = new Set(['VALIDATION_FAILED', 'PROVIDER_UNSUPPORTED_REGION', 'PROVIDER_RATE_LIMIT', 'PROVIDER_UNAVAILABLE']);

/** K05 POST /api/v1/planning-context. Read-only: no DB write, no cache, no Claude, and request content is never logged. */
export function registerPlanningContext(app: FastifyInstance, config: SharedConfig, deps: PlanningContextDeps = {}): void {
  const sources = deps.sources ?? createContextSources(config);
  const routeBudget = deps.routeBudget ?? sharedUserRouteBudget();
  const limiter = deps.limiter ?? createUserLimiter({ perDay: dailyPerUserFromEnv() });

  app.post('/api/v1/planning-context', { preHandler: app.authenticate, onSend: async (_req, reply) => void reply.header('cache-control', 'no-store') }, async (req, reply) => {
    const { userId } = requireActor(req);
    const body = PlanningContextRequest.safeParse(req.body);
    if (!body.success) return fail(reply, req.id, 'VALIDATION_FAILED', 'Invalid request.');
    const slot = limiter.acquire(userId);
    if (slot === 'busy' || slot === 'daily') return fail(reply, req.id, 'RATE_LIMITED', 'Too many requests.', slot === 'busy');

    // The reply socket closing before the response is written means the client gave up: stop provider work.
    const ctl = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableFinished) ctl.abort();
    };
    reply.raw.on('close', onClose);
    try {
      // Live route calls are charged to the user's daily budget; fixture routes cost nothing.
      const src = sources.routes && sources.mode !== 'fixture' ? { ...sources, routes: limitRoutesPerUser(sources.routes, userId, routeBudget) } : sources;
      const ctx = await buildPlanningContext(body.data, src, ctl.signal, deps.now);
      return PlanningContext.parse(ctx);
    } catch (e) {
      if (e instanceof PolicyError) {
        if (e.code === 'CANCELLED') {
          // Nobody is listening: close the socket instead of leaving an unsent reply pending.
          reply.hijack();
          reply.raw.destroy();
          return reply;
        }
        const code: ErrorCode = POLICY_CODES.has(e.code) ? e.code : 'PROVIDER_UNAVAILABLE';
        const retryable = code === 'PROVIDER_UNAVAILABLE' && e.retryable;
        return fail(reply, req.id, code, code === 'VALIDATION_FAILED' ? 'Invalid request.' : 'The data source is not available.', retryable);
      }
      throw e; // generic 500 from the app error handler (no message)
    } finally {
      reply.raw.off('close', onClose);
      slot();
    }
  });
}
