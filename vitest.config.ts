import { defineConfig } from 'vitest/config';

// App unit tests. The design-kit tests stay on `npm test` (node --test tests/*.test.mjs).
export default defineConfig({
  test: {
    include: ['apps/*/{src,test}/**/*.test.{ts,tsx}', 'packages/*/{src,test}/**/*.test.{ts,tsx}'],
    environment: 'node',
    // Unit tests never call paid or live providers; see docs/08_POLICY_AND_COST.md.
    env: { PROVIDER_MODE: 'fixture', ALLOW_CLAUDE_EXECUTION: 'false' },
  },
});
