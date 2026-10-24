/**
 * Browser key for the Maps JavaScript API. Only the referrer-restricted PUBLIC_MAPS_BROWSER_KEY is used
 * (apps/web/vite.config.ts exposes exactly that variable from the repo .env); the server key is never
 * exposed to the browser. Returns null when not configured (tests, CI, fixture) so the screen shows the
 * static fallback instead of loading Google.
 */
export function readBrowserMapsKey(env: Record<string, unknown> | undefined = viteEnv()): string | null {
  const v = env?.PUBLIC_MAPS_BROWSER_KEY;
  if (typeof v !== 'string') return null;
  const key = v.trim();
  return key.length > 0 ? key : null;
}

function viteEnv(): Record<string, unknown> | undefined {
  return (import.meta as unknown as { env?: Record<string, unknown> }).env;
}
