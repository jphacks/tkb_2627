// Review mode (`npm run review`): the web dev server listens on the LAN so a phone can open it.
// The shared API stays on 127.0.0.1 and is only reached through the /api proxy. /local (4311) is never proxied.
export interface ReviewEnv {
  TKB_REVIEW_LAN?: string | undefined;
  TKB_API_PORT?: string | undefined;
  TKB_WEB_PORT?: string | undefined;
}

export const DEV_ORIGIN = 'http://127.0.0.1:5173';

function port(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}

export function serverSettings(env: ReviewEnv) {
  const review = env.TKB_REVIEW_LAN === '1';
  const apiPort = port(env.TKB_API_PORT, 4310);
  const proxy: Record<string, string> = { '/api': `http://127.0.0.1:${apiPort}` };
  if (!review) proxy['/local'] = 'http://127.0.0.1:4311';
  return {
    host: review ? '0.0.0.0' : '127.0.0.1',
    port: review ? port(env.TKB_WEB_PORT, 5173) : 5173,
    strictPort: true,
    // Review only: LAN access by IP or hostname. Default dev keeps Vite's host check.
    ...(review ? { allowedHosts: true as const } : {}),
    proxy,
  };
}

/**
 * The shared API accepts only the fixed dev origin. In review mode the page is opened as http://<lan-ip>:<port>,
 * so the proxy rewrites an Origin that equals the page's own Host (same-origin) to the dev origin.
 * Any other Origin is left untouched and the API rejects it as before.
 */
export function rewriteOrigin(origin: string | undefined, host: string | undefined): string | undefined {
  if (!origin || !host) return origin;
  return origin === `http://${host}` ? DEV_ORIGIN : origin;
}
