import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { rewriteOrigin, serverSettings } from './src/lib/review-mode.ts';

const settings = serverSettings(process.env);
const review = process.env.TKB_REVIEW_LAN === '1';

export default defineConfig({
  plugins: [react()],
  // U04: read the repo-root .env and expose only the referrer-restricted Maps browser key
  // (PUBLIC_MAPS_BROWSER_KEY) to the client. GOOGLE_MAPS_SERVER_KEY and other variables stay server-side.
  envDir: fileURLToPath(new URL('../..', import.meta.url)),
  envPrefix: ['PUBLIC_MAPS_BROWSER_KEY'],
  server: {
    ...settings,
    // `npm run review` (TKB_REVIEW_LAN=1): LAN-visible web server, /api only, Origin of the page itself mapped to the dev origin.
    proxy: review
      ? {
          '/api': {
            target: settings.proxy['/api']!,
            configure: proxy => {
              proxy.on('proxyReq', (proxyReq, req) => {
                const o = rewriteOrigin(req.headers.origin, req.headers.host);
                if (o && o !== req.headers.origin) proxyReq.setHeader('origin', o);
              });
            },
          },
        }
      : settings.proxy,
  },
  build: { outDir: 'dist' },
});
