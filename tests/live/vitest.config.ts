import { defineConfig } from 'vitest/config';

// CI-safe T06 tests only (the root config's include does not cover tests/live). Run: npx vitest run --config tests/live/vitest.config.ts
export default defineConfig({ test: { include: ['tests/live/**/*.test.ts'], environment: 'node', env: { PROVIDER_MODE: 'fixture' } } });
