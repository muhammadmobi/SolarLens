import { defineConfig } from 'vitest/config';

// Unit tests cover the pure parts of the Worker (unit scaling, vendor payload
// normalisation, the call queue). Anything that needs the
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
      // The modules a unit test can meaningfully reach: the vendor adapters and
      // the public-view redactor, which are pure functions over payloads.
      //
      // index.ts, db.ts and poll.ts are left out deliberately - request
      // routing, D1 SQL and cron fan-out need a Worker and a database, and the
      // Playwright suite covers them through HTTP instead. Counting them here
      // reports a low number for code that is tested, just not here: the same
      // suite measures 38% with them and 60% without. To see that view per
      // file when you want it:
      //   npx vitest run --coverage --coverage.include='src/**/*.ts'
      //
      // public-view.ts was missing from this list until 2026-09-11, which meant
      // the one file deciding which vendor identifiers leave the Worker was the
      // one file not being measured. It sits at 100% statements.
      include: ['src/providers/**/*.ts', 'src/public-view.ts'],
      // Type declarations compile to nothing, so they only skew the figures.
      exclude: ['src/providers/types.ts'],
      // Lowered on 2026-09-09 when src/weather.ts was removed - not broken.
      // It was 95% covered, so taking it out left the same tests measured
      // against a less-covered remainder. Nothing stopped being tested.
      //
      // Set just under what the suite actually achieves, so a regression trips
      // them and ordinary refactoring does not. Raise these when you add
      // tests; never lower them to make a red build go green.
      //
      // The gap to 100% is almost entirely the vendor HTTP clients - signing,
      // paging, token refresh - which need a live endpoint or a large mock to
      // exercise. `npm run probe:solis` and the e2e suite cover that ground.
      thresholds: {
        statements: 57,
        branches: 49,
        functions: 53,
        lines: 57,
      },
    },
  },
});
