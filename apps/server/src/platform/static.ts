import { constants, lstatSync, realpathSync } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { join, resolve, sep, extname } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
};

/** Reads a regular file inside root, or null. Rejects traversal, dot segments and symlinks. */
async function readSafe(root: string, urlPath: string): Promise<{ file: string; body: Buffer } | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const segments = decoded.split('/').filter(s => s !== '');
  if (segments.some(s => s.startsWith('.'))) return null;
  const target = resolve(join(root, ...segments));
  if (target !== root && !target.startsWith(root + sep)) return null;
  const ext = extname(target).toLowerCase();
  if (!(ext in TYPES)) return null;
  try {
    // A symlink anywhere in the path makes realpath differ from the lexical path.
    if ((await realpath(target)) !== target) return null;
    // O_NOFOLLOW closes the window between the check above and the read.
    const fh = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await fh.stat()).isFile()) return null;
      return { file: target, body: await fh.readFile() };
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/** True for /api and /local in any case, percent-encoding or repeated slashes. */
function isReservedPath(urlPath: string): boolean {
  let d: string;
  try {
    d = decodeURIComponent(urlPath);
  } catch {
    return true;
  }
  d = d.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase();
  return /^\/(api|local)(\/|$)/.test(d);
}

export interface StaticHandler {
  /** Returns true when the request was answered (a file or the SPA shell). */
  handle(req: FastifyRequest, reply: FastifyReply): Promise<boolean>;
}

/** Same-origin static delivery of the web build. Returns null when dist does not exist. */
export function createStaticHandler(staticDir: string | null): StaticHandler | null {
  if (!staticDir) return null;
  let root: string;
  try {
    root = realpathSync(resolve(staticDir));
    if (!lstatSync(join(root, 'index.html')).isFile()) return null;
  } catch {
    return null;
  }
  return {
    async handle(req, reply) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return false;
      const urlPath = req.url.split('?')[0]!.split('#')[0]!;
      // The shared entrance never exposes personal-entry (/local/) or API paths as pages.
      if (isReservedPath(urlPath)) return false;
      let hit = await readSafe(root, urlPath);
      let spa = false;
      if (!hit) {
        // SPA fallback only for extension-less, well-formed paths (never for traversal or missing assets).
        let decoded = '';
        try {
          decoded = decodeURIComponent(urlPath);
        } catch {
          return false;
        }
        if (extname(decoded) !== '' || decoded.split('/').some(s => s.startsWith('.')) || decoded.includes('\\') || decoded.includes('\0')) return false;
        hit = await readSafe(root, '/index.html');
        spa = true;
        if (!hit) return false;
      }
      const { file, body } = hit;
      const isIndex = spa || file === join(root, 'index.html');
      reply
        .status(200)
        .header('content-type', TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream')
        .header('cache-control', isIndex ? 'no-cache' : 'public, max-age=31536000, immutable');
      await reply.send(req.method === 'HEAD' ? undefined : body);
      return true;
    },
  };
}
