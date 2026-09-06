import { defineConfig, devices } from '@playwright/test';

// End-to-end tests load the real dashboard HTML from a tiny static server and
// stub the /api/* endpoints with fixtures, so they run anywhere in a few
// seconds without Cloudflare, D1 or vendor credentials.
const PORT = Number(process.env.E2E_PORT ?? 4173);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 20_000,
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    // `channel: 'chrome'` uses the Google Chrome already on the machine, so no
    // browser download is needed. Drop it to use Playwright's bundled Chromium.
    { name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
    { name: 'mobile', use: { ...devices['Pixel 7'], channel: 'chrome' } },
  ],
  webServer: {
    command: `node scripts/serve-static.mjs`,
    url: `http://127.0.0.1:${PORT}/`,
    env: { PORT: String(PORT) },
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});
