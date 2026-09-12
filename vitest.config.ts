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
      // Branches sits lower than the rest on purpose. The vendor payloads are
      // full of optional fields, each read through a fallback chain - pick(r,
      // 'stationName', 'name') ?? r.id - and covering every arm means a fixture
      // per arm for figures that are already covered on the path that matters.
      // The three that count are held at 80.
      //
      // What remains uncovered is the deep paging and device-detail fan-out in
      // the vendor clients, and the parts of the browser-session fallback that
      // only run without official keys. `npm run probe:solis` checks the
      // signature against the live endpoint, which no mock can.
      thresholds: {
        statements: 80,
        branches: 63,
        functions: 80,
        lines: 80,
      },
    },
  },
});
