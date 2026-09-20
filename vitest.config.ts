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
      // Branches were the last to come up, and they came up by walking the
      // arms rather than by lowering the bar: the fallbacks in the vendor
      // normalisers - pick(r, 'stationName', 'name') ?? r.id - each got a
      // payload that takes them. One of those arms turned out to store the
      // string "null" as a plant id.
      thresholds: {
        statements: 97,
        branches: 90,
        functions: 97,
        lines: 99,
      },
    },
  },
});
