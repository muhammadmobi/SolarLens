import { defineConfig } from 'vitest/config';

// Unit tests cover the pure parts of the Worker (unit scaling, vendor payload
// normalisation, the call queue, the weather lookup). Anything that needs the
// Workers runtime (D1, crypto.subtle MD5) is exercised by the probe scripts and
// the e2e suite instead.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    reporters: 'default',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      // The modules a unit test can meaningfully reach. index.ts and poll.ts
      // are Worker wiring - request routing, cron fan-out - and are covered
      // end-to-end rather than here; counting them would report a low number
      // for code that is deliberately tested elsewhere.
      include: ['src/providers/**/*.ts', 'src/weather.ts'],
      // Type declarations compile to nothing, so they only skew the figures.
      exclude: ['src/providers/types.ts'],
      // Set just under what the suite actually achieves, so a regression trips
      // them and ordinary refactoring does not. Raise these when you add
      // tests; never lower them to make a red build go green.
      //
      // The gap to 100% is almost entirely the vendor HTTP clients - signing,
      // paging, token refresh - which need a live endpoint or a large mock to
      // exercise. `npm run probe:solis` and the e2e suite cover that ground.
      thresholds: {
        statements: 58,
        branches: 50,
        functions: 48,
        lines: 58,
      },
    },
  },
});
