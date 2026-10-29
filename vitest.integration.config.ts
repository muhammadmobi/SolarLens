import { defineConfig } from 'vitest/config';

// The integration suite: the real Worker, in workerd, started once by
// tests/integration/setup.ts and asked over HTTP. Slower than the unit suite -
// wrangler has to start - and so kept apart from it: `npm run test:integration`.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    globalSetup: ['tests/integration/setup.ts'],
    environment: 'node',
    // One Worker and one database, shared: the files run one after another.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
