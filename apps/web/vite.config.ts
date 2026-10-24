import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  // U04: read the repo-root .env and expose only the referrer-restricted Maps browser key
  // (PUBLIC_MAPS_BROWSER_KEY) to the client. GOOGLE_MAPS_SERVER_KEY and other variables stay server-side.
  envDir: fileURLToPath(new URL('../..', import.meta.url)),
  envPrefix: ['PUBLIC_MAPS_BROWSER_KEY'],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:4310',
      '/local': 'http://127.0.0.1:4311',
    },
  },
  build: { outDir: 'dist' },
});
