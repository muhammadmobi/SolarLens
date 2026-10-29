/**
 * What one invocation of the Worker asks of D1: its cron runs and its busiest
 * routes, each held to a budget.
 *
 * A Workers Free plan allows 50 D1 queries per invocation, and a day's reads and
 * writes are a fixed allowance for everything. Until 3.0's review nothing
 * counted them, and one Monday's cron run was measured at ninety-five queries:
 * the week's agents, the weekly summary, the weather and the housekeeping all
 * rode on the five-minute run. They run from an hourly cron now, one heavy job
 * an hour, and these tests hold every run under the limit with room to spare -
 * so a change that adds queries to a run shows here, not in production's logs.
 *
 * The owner here is a realistic one: two systems with twelve weeks behind them,
 * both placed for the weather, a phone signed up for notifications and a
 * channel taking alerts and the weekly summary. The SolarMan web provider is
 * stubbed with a production-like plant: one station, three device records, a
 * fresh fault. Every statement is counted, a batch's one by one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/providers/solarman-web', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  class WebStub {
    id = 'solarman' as const;
    async listPlants() { return [{ id: 'p1', name: 'Garage', capacityW: 4000, tzOffsetSec: 0, tzName: null, location: { lat: 10, lng: 20 } }]; }
    async listInverters() { return [{ id: 'solarman:station:beta', provider: 'solarman', vendorId: 'p1', serial: null, name: 'Garage', plantId: 'p1', plantName: 'Garage', capacityW: 4000, tzOffsetSec: 0, tzName: null }]; }
    async listDevices() {
      const base = { provider: 'solarman', plantId: 'p1', model: null, firmware: null, ratedPowerW: null, status: 'online', signalDbm: null, signalPct: 80, uploadCycleS: null, commissionedAt: null, warrantyUntil: null, lastSeen: null, strings: null, acPhases: null, frequencyHz: null, powerFactor: null, tempC: null, dcBusV: null, battery: null, logger: null, raw: null };
      return [
        { ...base, id: 'solarman:inverter:SN1', kind: 'inverter', sn: 'SN1', name: 'Inverter' },
        { ...base, id: 'solarman:datalogger:LG1', kind: 'datalogger', sn: 'LG1', name: 'Datalogger', network: { operator: null, cellArea: null, cellId: null, mac: 'AA' } },
        { ...base, id: 'solarman:inverter:SN1', kind: 'inverter', sn: 'SN1', name: 'Inverter', strings: [{ index: 1, powerW: 900, voltageV: 300, currentA: 3 }] },
      ];
    }
    async listAlarms() {
      const now = Math.floor(Date.now() / 1000);
      return [{ id: `solarman:p1:F1:${now - 600}`, inverterId: 'solarman:station:beta', provider: 'solarman', code: 'F1', message: 'Grid overvoltage', severity: 'warning', vendorLevel: 1, advice: null, beginTs: now - 600, endTs: null, state: 'active' }];
    }
    async listPeriods() { return []; }
    async getReading(inv: { id: string }) {
      const now = Math.floor(Date.now() / 1000);
      return { inverterId: inv.id, ts: now - 60, source: 'solarman', acPowerW: 1500, dcPowerW: null, todayKwh: 6, totalKwh: 7000, batterySoc: 98, batteryPowerW: 0, gridPowerW: -300, loadPowerW: 400, tempC: null, status: 'online', metrics: null, raw: { generationPower: 1500 } };
    }
  }
  return { ...real, SolarmanWebProvider: class { constructor() { return new WebStub(); } } };
});

const { HOURLY, createHarness, bearer } = await import('../helpers/worker');
const { addDay, addSun, addSystem, dayNumber, isoOf } = await import('../helpers/solar-days');
const { addChannel, parseChannel } = await import('../../src/channels');
const { subscribe } = await import('../../src/push');
const { upsertLocation } = await import('../../src/weather');
type Harness = ReturnType<typeof createHarness>;

/** The Free plan's limit on D1 queries in one invocation. */
const D1_PER_INVOCATION = 50;
const ROOF = 'solarman:station:alpha';
const GARAGE = 'solarman:station:beta';
/** Monday 28 September 2026: 08:07, the first hourly run of the week, and on through the morning. */
const MONDAY_0807 = Date.UTC(2026, 8, 28, 8, 7) / 1000;

async function vapidKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  return JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey));
}

/** Twelve weeks of two placed systems, a phone and a channel listening, the summary last sent the week before. */
async function owner(h: Harness) {
  await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5 });
  await addSystem(h.env.DB, { id: GARAGE, name: 'Garage', kwp: 4 });
  const monday = dayNumber('2026-09-28');
  for (let n = monday - 84; n < monday; n++) {
    await addDay(h.env.DB, ROOF, isoOf(n), 20);
    await addDay(h.env.DB, GARAGE, isoOf(n), 16);
    await addSun(h.env.DB, ROOF, isoOf(n), 5);
    await addSun(h.env.DB, GARAGE, isoOf(n), 5);
  }
  await upsertLocation(h.env.DB, ROOF, { lat: 10, lng: 20 });
  await upsertLocation(h.env.DB, GARAGE, { lat: 10, lng: 20 });
  await subscribe(h.env.DB, 'https://fcm.googleapis.com/fcm/send/made-up-device', 'https://dashboard.test');
  const row = await addChannel(h.env.DB, 'api-token-for-tests', parseChannel({ kind: 'webhook', url: 'https://hooks.example.net/made-up' }) as never, 'https://dashboard.test');
  if (row === 'full') throw new Error('full');
  await h.env.DB.prepare("INSERT INTO kv (k, v, expires_at) VALUES ('summary:week', ?1, ?2)").bind(String(dayNumber('2026-09-21')), MONDAY_0807 + 10 ** 8).run();
}

/** Push services, channels and the weather answer as they would. */
function network() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('open-meteo')) return Response.json({ hourly: { time: [], shortwave_radiation: [], temperature_2m: [], cloud_cover: [] } });
    return new Response('', { status: 201 });
  }));
}

/** The D1 statements one step ran, counting a batch's one by one. */
async function counted(h: Harness, step: () => Promise<unknown>): Promise<string[]> {
  const before = h.d1.sql.length;
  await step();
  return h.d1.sql.slice(before);
}

describe('D1 queries in one invocation', () => {
  let h: Harness;
  afterEach(() => { h?.close(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  async function at(ts: number) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(ts * 1000));
  }

  async function start() {
    await at(MONDAY_0807);
    h = createHarness({ SOLARMAN_WEB_REFRESH_TOKEN: 'web', VAPID_KEY: await vapidKey(), AI: { async run() { return { response: 'A steady week.' }; } } });
    await owner(h);
    network();
  }

  it('keeps the five-minute run - the readings and the alerts - well inside the limit', async () => {
    await start();
    const run = await counted(h, () => h.cron());
    expect(run.length).toBeGreaterThan(10);
    expect(run.length).toBeLessThanOrEqual(D1_PER_INVOCATION - 10);
  });

  it("keeps each of Monday morning's hourly runs inside it: the agents, then the summary with the rest", async () => {
    await start();
    const agents = await counted(h, () => h.cron(HOURLY));
    expect(agents.some((s) => /INTO agent_reports/.test(s))).toBe(true);
    expect(agents.length).toBeLessThanOrEqual(D1_PER_INVOCATION);
    await at(MONDAY_0807 + 3600);
    const rest = await counted(h, () => h.cron(HOURLY));
    expect(rest.some((s) => /UPDATE kv SET v = \?2 WHERE k = \?1/.test(s))).toBe(true);
    expect(rest.length).toBeLessThanOrEqual(D1_PER_INVOCATION);
    // An ordinary hour after that: the weather and the housekeeping.
    await at(MONDAY_0807 + 2 * 3600);
    expect((await counted(h, () => h.cron(HOURLY))).length).toBeLessThanOrEqual(D1_PER_INVOCATION - 20);
  });

  it("stores a relay's backfilled day inside the limit, however much of it is new or already stored", async () => {
    await start();
    // Today's curve as the portal draws it: a point every five minutes from midnight UTC.
    const midnight = Date.UTC(2026, 8, 28);
    const chart = (n: number) => ({
      provider: 'soliscloud', plantId: 'p9',
      raw: { code: '0', data: { time: Array.from({ length: n }, (_, i) => midnight + i * 300_000), power: Array.from({ length: n }, (_, i) => 1000 + i), powerStr: 'W' } },
    });
    const post = async (n: number) => {
      let stored = -1;
      const sql = await counted(h, async () => {
        const res = await h.fetch('/api/ingest/history', { method: 'POST', headers: { 'content-type': 'application/json', ...bearer('ingest-token-for-tests') }, body: JSON.stringify(chart(n)) });
        stored = ((await res.json()) as { stored: number }).stored;
      });
      expect(sql.length).toBeLessThanOrEqual(D1_PER_INVOCATION);
      return stored;
    };
    expect(await post(20)).toBe(20);
    // A laptop that slept until the evening wakes to 150 points, 130 of them new: forty a post, oldest first.
    expect(await post(150)).toBe(40);
    expect(await post(150)).toBe(40);
    expect(await post(150)).toBe(40);
    expect(await post(150)).toBe(10);
    // And after that, a post adds nothing - two reads - as the day's points are all there.
    expect(await post(150)).toBe(0);
    expect(h.d1.raw.prepare("SELECT COUNT(*) AS n FROM readings WHERE source = 'soliscloud-history'").get()).toEqual({ n: 150 });
  });

  it('answers the heaviest question - a report on a month - inside it', async () => {
    await start();
    let reply: { kind?: string; results?: unknown[] } = {};
    const chat = await counted(h, async () => {
      const res = await h.fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'a report on last month' }] }) });
      reply = await res.json();
    });
    // The report itself ran - energy, the systems compared, statistics, faults, the trend - not a refusal.
    expect(reply.kind).toBe('report');
    expect(reply.results?.length).toBeGreaterThan(0);
    expect(chat.length).toBeLessThanOrEqual(D1_PER_INVOCATION);
  });
});
