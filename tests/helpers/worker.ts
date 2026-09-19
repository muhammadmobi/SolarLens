/**
 * A Worker to make requests against, with a real database behind it.
 *
 * `src/index.ts` exports the fetch handler and the cron handler, and both take
 * their bindings as arguments, so a test can call them directly: a SQLite-backed
 * D1 (see ./d1), a stub for the static-assets binding, and whichever tokens the
 * case is about. Nothing here talks to Cloudflare or to a vendor.
 */
import worker from '../../src/index';
import type { Env } from '../../src/db';
import { createTestD1, type TestD1 } from './d1';

export interface Harness {
  env: Env;
  d1: TestD1;
  /** Request the Worker the way the edge would. Paths are relative: '/api/health'. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Run the scheduled handler and wait for the work it hands to waitUntil. */
  cron(): Promise<void>;
  close(): void;
}

/** The static-assets binding, which in production serves public/. */
function assetsStub(): Fetcher {
  return {
    fetch: async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return new Response(`<!doctype html><title>dashboard</title><!-- ${new URL(url).pathname} -->`, {
        headers: { 'content-type': 'text/html' },
      });
    },
  } as unknown as Fetcher;
}

export function createHarness(overrides: Partial<Env> = {}): Harness {
  const d1 = createTestD1();
  const env: Env = {
    DB: d1.db,
    ASSETS: assetsStub(),
    API_TOKEN: 'api-token-for-tests',
    INGEST_TOKEN: 'ingest-token-for-tests',
    ...overrides,
  };

  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => { pending.push(p); },
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;

  return {
    env,
    d1,
    fetch: (path, init) => worker.fetch(new Request(`https://dashboard.test${path}`, init), env, ctx) as Promise<Response>,
    async cron() {
      await worker.scheduled?.({ cron: '*/5 * * * *', scheduledTime: Date.now(), noRetry() {} } as ScheduledController, env, ctx);
      await Promise.all(pending);
    },
    close: () => d1.close(),
  };
}

/** Authorization header for a route that wants one. */
export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** A plant-level inverter row, the shape both vendors end up producing. */
export const testInverter = (over: Record<string, unknown> = {}) => ({
  id: 'solarman:station:s-test',
  provider: 'solarman' as const,
  vendorId: 's-test',
  serial: 'SERIAL1234',
  name: 'Test Plant',
  plantId: 's-test',
  plantName: 'Test Plant',
  capacityW: 3500,
  tzOffsetSec: 0,
  ...over,
});

/** A reading with only the fields a test cares about set. */
export const testReading = (over: Record<string, unknown> = {}) => ({
  inverterId: 'solarman:station:s-test',
  ts: 1_700_000_000,
  source: 'test',
  acPowerW: 1200,
  dcPowerW: 1300,
  todayKwh: 4.5,
  totalKwh: 9000,
  batterySoc: 80,
  batteryPowerW: -200,
  gridPowerW: 100,
  loadPowerW: 900,
  tempC: 31,
  status: 'normal',
  metrics: null,
  raw: null,
  ...over,
});
