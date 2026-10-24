import { defineConfig } from 'vitest/config';

// App unit tests. The design-kit tests stay on `npm test` (node --test tests/*.test.mjs).
export default defineConfig({
  test: {
    include: ['apps/*/{src,test}/**/*.test.{ts,tsx}', 'packages/*/{src,test}/**/*.test.{ts,tsx}', 'tests/access/**/*.test.ts', 'tests/contracts/**/*.test.ts', 'tests/{ai,jobs}/**/*.test.ts', 'tests/security/**/*.test.ts'],
    environment: 'node',
    // Unit tests never call paid or live providers; see docs/08_POLICY_AND_COST.md.
    env: { PROVIDER_MODE: 'fixture', ALLOW_CLAUDE_EXECUTION: 'false' },
  },
});
