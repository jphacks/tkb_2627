import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, ERROR_HTTP_STATUS, LoginRequest, LoginResponse, type ErrorCode } from '@tkb/contracts';
import { createSession, findActiveSessionUser, getUserByLoginId, revokeSession, type Db } from '@tkb/db';
import type { SharedConfig } from '../config.ts';
import { hashPassword, prepareDummy, verifyDummy, verifyPassword } from './password.ts';
import { FailureLimiter } from './rateLimit.ts';

export { hashPassword, verifyPassword };

/** Dev (http) cookie name. Over https the `__Host-` prefixed name is used instead. */
export const SESSION_COOKIE = 'tkb_session';
export const SECURE_SESSION_COOKIE = '__Host-tkb_session';
export const CSRF_HEADER = 'x-csrf-token';
const DEV_ORIGINS = ['http://127.0.0.1:5173', 'http://localhost:5173'];
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export interface ActorContext {
  userId: string;
  displayName: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    actor?: ActorContext;
    sessionToken?: string;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** GET-only routes that anonymous users may call: sets req.actor when a valid session exists, never 401s. */
    optionalAuthenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/** The authenticated user of this request. Throws if `authenticate` did not run (programming error). */
export function requireActor(req: FastifyRequest): ActorContext {
  if (!req.actor) throw new Error('requireActor called on a route without the authenticate preHandler');
  return req.actor;
}

/** The signed-in user on a route using `optionalAuthenticate`, or null for anonymous. */
export function optionalActor(req: FastifyRequest): ActorContext | null {
  return req.actor ?? null;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const nowIso = () => new Date().toISOString();

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function fail(
  reply: FastifyReply,
  req: FastifyRequest,
  code: ErrorCode,
  message: string,
  retryable = false,
  details?: Record<string, unknown>,
) {
  return reply.status(ERROR_HTTP_STATUS[code]).send(ApiError.parse({ code, message, retryable, requestId: req.id, details }));
}

export function registerAuth(app: FastifyInstance, db: Db, config: SharedConfig): void {
  void app.register(fastifyCookie);
  const secure = config.publicOrigin.startsWith('https://');
  const allowedOrigins = new Set(
    config.publicOrigin ? [config.publicOrigin] : DEV_ORIGINS, // dev exception never applies once PUBLIC_ORIGIN is set
  );
  const cookieName = secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
  const byLogin = new FailureLimiter(5);
  // Higher than the per-login limit: behind a tunnel many users may share one client IP.
  const byIp = new FailureLimiter(50);
  prepareDummy().catch(() => undefined);

  // Default deny: every /api/v1 route except these must run `authenticate`.
  const PUBLIC_ROUTES = new Set(['GET /api/v1/health', 'GET /api/v1/capabilities', 'POST /api/v1/auth/login', 'GET /api/v1/amenities', 'GET /api/v1/guides']);
  const OPTIONAL_AUTH_ROUTES = new Set(['/api/v1/posts', '/api/v1/posts/:id']);
  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/api/v1/')) return;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const hooks = [route.preHandler, route.onRequest].flat().filter(Boolean);
    const guarded = hooks.includes(app.authenticate);
    const optional = hooks.includes(app.optionalAuthenticate);
    for (const m of methods) {
      if (m === 'HEAD' || m === 'OPTIONS') continue;
      if (optional) {
        // Anonymous access is read-only and limited to an explicit allow-list of URLs.
        if (m !== 'GET' || !OPTIONAL_AUTH_ROUTES.has(route.url)) {
          throw new Error(`route ${m} ${route.url} must not use optionalAuthenticate`);
        }
        continue;
      }
      if (!guarded && !PUBLIC_ROUTES.has(`${m} ${route.url}`)) {
        throw new Error(`route ${m} ${route.url} must use app.authenticate (or be added to the public allowlist)`);
      }
    }
  });
  const csrfFor = (token: string) => createHmac('sha256', config.sessionSecret).update(token).digest('base64url');
  const cookieOpts = { httpOnly: true, sameSite: 'lax' as const, path: '/', secure };

  const readToken = (req: FastifyRequest): string | null => {
    const raw = fastifyCookie.parse(req.headers.cookie ?? '')[cookieName];
    return raw && TOKEN_RE.test(raw) ? raw : null;
  };

  const isAuthPath = (req: FastifyRequest) => req.url.startsWith('/api/v1/auth/');

  app.addHook('onSend', async (req, reply) => {
    if (isAuthPath(req)) reply.header('cache-control', 'no-store');
  });

  // Origin + CSRF for state-changing requests (login is exempt from the token, not from Origin).
  app.addHook('onRequest', async (req, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      return fail(reply, req, 'FORBIDDEN', 'Request rejected.');
    }
    if (req.method === 'POST' && req.url.split('?')[0] === '/api/v1/auth/login') return;
    const token = readToken(req);
    // Without a session cookie there is no ambient authority to abuse; authenticate will 401.
    if (!token) return;
    const sent = req.headers[CSRF_HEADER];
    if (typeof sent !== 'string' || !safeEqual(sent, csrfFor(token))) {
      return fail(reply, req, 'FORBIDDEN', 'Request rejected.');
    }
  });

  app.decorateRequest('actor');
  app.decorateRequest('sessionToken');
  app.decorate('authenticate', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = readToken(req);
    const user = token ? findActiveSessionUser(db, sha256(token), nowIso()) : null;
    if (!token || !user) {
      await fail(reply, req, 'UNAUTHENTICATED', 'Authentication required.');
      return;
    }
    req.actor = { userId: user.id, displayName: user.displayName };
    req.sessionToken = token;
  });

  app.decorate('optionalAuthenticate', async (req: FastifyRequest) => {
    const token = readToken(req);
    const user = token ? findActiveSessionUser(db, sha256(token), nowIso()) : null;
    if (token && user) {
      req.actor = { userId: user.id, displayName: user.displayName };
      req.sessionToken = token;
    }
  });

  const GENERIC = 'Invalid loginId or password.';

  app.post('/api/v1/auth/login', async (req, reply) => {
    const parsed = LoginRequest.safeParse(req.body);
    if (!parsed.success) return fail(reply, req, 'VALIDATION_FAILED', 'Invalid request.');
    const { password } = parsed.data;
    const loginId = parsed.data.loginId.toLowerCase();
    const loginKey = loginId;
    const ipKey = req.ip;
    const wait = Math.max(byLogin.retryAfterMs(loginKey), byIp.retryAfterMs(ipKey));
    if (wait > 0) {
      reply.header('retry-after', String(Math.ceil(wait / 1000)));
      return fail(reply, req, 'RATE_LIMITED', 'Too many attempts. Try again later.', true, { retryAfterMs: wait });
    }
    // Count before the slow scrypt await so parallel attempts cannot all pass the check above.
    byLogin.fail(loginKey);
    byIp.fail(ipKey);
    const user = getUserByLoginId(db, loginId);
    const ok = user ? await verifyPassword(password, user.passwordHash) : await verifyDummy(password);
    if (!user || !ok) return fail(reply, req, 'UNAUTHENTICATED', GENERIC);
    byLogin.reset(loginKey);
    byIp.undo(ipKey);
    const previous = readToken(req);
    if (previous) revokeSession(db, sha256(previous), nowIso());
    const token = randomBytes(32).toString('base64url');
    createSession(db, {
      idHash: sha256(token),
      userId: user.id,
      expiresAt: new Date(Date.now() + config.sessionTtlMs).toISOString(),
    });
    reply.setCookie(cookieName, token, { ...cookieOpts, maxAge: Math.floor(config.sessionTtlMs / 1000) });
    return LoginResponse.parse({ userId: user.id, displayName: user.displayName, csrfToken: csrfFor(token) });
  });

  app.post('/api/v1/auth/logout', { preHandler: app.authenticate }, async (req, reply) => {
    revokeSession(db, sha256(req.sessionToken!), nowIso());
    reply.clearCookie(cookieName, cookieOpts);
    return reply.status(204).send();
  });

  app.get('/api/v1/auth/me', { preHandler: app.authenticate }, async (req) => {
    const actor = requireActor(req);
    return LoginResponse.parse({ ...actor, csrfToken: csrfFor(req.sessionToken!) });
  });
}
