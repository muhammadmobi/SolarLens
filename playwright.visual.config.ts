import { defineConfig, devices } from '@playwright/test';

// Screenshot comparison: each view of the demo, at a fixed moment, compared
// pixel by pixel with the picture recorded before. A change nobody meant - a
// colour gone, a card collapsed, a chart off its axis - fails here even when
// every text-based test still passes.
//
// The pictures are recorded on Linux, in CI, and only compared there: fonts
// render differently on Windows and macOS, and a baseline from one would fail
// on the other for no reason. `npm run test:visual` locally records a separate
// set for your own machine under tests/visual/__screenshots__/<platform>/.
const PORT = Number(process.env.E2E_PORT ?? 4174);

export default defineConfig({
  testDir: 'tests/visual',
  snapshotPathTemplate: '{testDir}/__screenshots__/{platform}/{arg}{ext}',
  timeout: 30_000,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  expect: {
    toHaveScreenshot: {
      // Anti-aliasing moves a few pixels between runs; a real change moves many.
      maxDiffPixelRatio: 0.002,
      animations: 'disabled',
    },
  },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ...devices['Desktop Chrome'],
    channel: 'chrome',
    viewport: { width: 1280, height: 900 },
  },
  webServer: {
    command: `node scripts/build-demo.mjs && node scripts/serve-static.mjs`,
    url: `http://127.0.0.1:${PORT}/`,
    env: { PORT: String(PORT) },
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});
