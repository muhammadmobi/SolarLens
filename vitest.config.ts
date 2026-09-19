import { defineConfig } from 'vitest/config';

// The unit suite covers the Worker itself, not only the pure parts of it.
//
// Until 2.7 this measured the vendor adapters and the public-view redactor and
// left out index.ts, db.ts and poll.ts - the routing, the SQL and the cron
// fan-out - because those need a Worker and a database. They are covered now:
// `tests/helpers/d1.ts` puts SQLite behind the D1 interface, and
// `tests/helpers/worker.ts` calls the exported fetch and scheduled handlers
// with it, so a test makes the same request the dashboard does and reads the
// rows that came out the other side. What still cannot be reached from here is
// workerd itself - `crypto.subtle`'s MD5, the asset binding, real network -
// which the end-to-end suite, `npm run probe:solis` and the deploy's smoke test
// cover instead.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    reporters: 'default',
    // node:sqlite is stable from Node 24 and behind a flag in 22, which is the
    // version the checks run. Passed here rather than in an environment
    // variable so `npx vitest` behaves the same as `npm test`, on any shell.
    pool: 'forks',
    poolOptions: { forks: { execArgv: ['--experimental-sqlite'] } },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      // Everything the Worker ships, now that everything can be reached.
      include: ['src/**/*.ts'],
      // Type declarations compile to nothing, so they only skew the figures.
      exclude: ['src/providers/types.ts'],
      // Files at 100% are left out of the printed table, not the measurement.
      skipFull: true,
      //
      // Set just under what the suite achieves, so a regression trips them and
      // ordinary refactoring does not. Raise these when you add tests; never
      // lower one to make a red build go green.
      //
      // Branches sits lower than the rest on purpose, and honestly. The vendor
      // payloads are long chains of optional fields - pick(r, 'stationName',
      // 'name') ?? r.id - and v8 counts every arm of every chain. Covering the
      // last few points means a fixture per arm for figures already proved on
      // the path that matters. The other three are held above 95.
      thresholds: {
        statements: 95,
        branches: 82,
        functions: 95,
        lines: 97,
      },
    },
  },
});
