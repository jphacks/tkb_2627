import { randomBytes } from 'node:crypto';

export const SESSION_COOKIE = 'tkb_local_sid';

/** Upstream (shared server) session kept server-side only, bound to the local session. */
export interface UpstreamSession {
  userId: string;
  displayName: string;
  cookie: string;
  csrfToken: string;
}

export interface LocalSession {
  id: string;
  csrfToken: string;
  expiresAt: number;
  upstream: UpstreamSession | null;
}

const token = () => randomBytes(32).toString('base64url');

export class SessionStore {
  private readonly sessions = new Map<string, LocalSession>();
  constructor(
    private readonly ttlMs = 12 * 3600_000,
    private readonly now: () => number = Date.now,
  ) {}

  create(): LocalSession {
    const s: LocalSession = { id: token(), csrfToken: token(), expiresAt: this.now() + this.ttlMs, upstream: null };
    this.sessions.set(s.id, s);
    return s;
  }

  /** A live session that holds an upstream login for `userId` (used by restart recovery). Never returns another user's. */
  findUpstream(userId: string): LocalSession | null {
    for (const [id, s] of this.sessions) {
      if (this.now() > s.expiresAt) {
        this.sessions.delete(id);
        continue;
      }
      if (s.upstream?.userId === userId) return s;
    }
    return null;
  }

  get(id: string | undefined): LocalSession | null {
    if (!id) return null;
    const s = this.sessions.get(id);
    if (!s) return null;
    if (this.now() > s.expiresAt) {
      this.sessions.delete(id);
      return null;
    }
    return s;
  }
}

/** Tiny cookie parser (no @fastify/cookie dependency). */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

export function sessionCookieHeader(id: string): string {
  // No Secure: the entry is http loopback only.
  return `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/local`;
}
