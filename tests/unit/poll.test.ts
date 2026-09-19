/**
 * The cron fan-out: which providers get built, which plants get polled, what
 * happens when one of them fails, and the slower extras' own schedules.
 *
 * The providers themselves are stubbed - their HTTP is tested elsewhere - so
 * what is measured here is the orchestration, which is where a failure quietly
 * costs a reading: a provider that throws must not stop the other, and a
 * hardware list that fails must not cost the reading it came with.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/db';
import { isDue, markDone, recentPolls } from '../../src/db';
import type { Plant, Provider } from '../../src/providers/types';
import { createTestD1, type TestD1 } from '../helpers/d1';

/** Each provider module is replaced by a class the test can steer. */
const solis = vi.hoisted(() => ({ instances: [] as StubProvider[] }));
const solarman = vi.hoisted(() => ({ instances: [] as StubProvider[] }));
const solarmanWeb = vi.hoisted(() => ({ instances: [] as StubProvider[] }));

class StubProvider implements Provider {
  id = 'soliscloud' as const;
  plants: Plant[] = [{ id: 'plant-1', name: 'Stub Plant', capacityW: 10_000 }];
  inverters = [{ id: 'soliscloud:inv-1', provider: 'soliscloud' as const, vendorId: 'inv-1', serial: 'SN', name: '', plantId: 'plant-1', plantName: '', capacityW: null }];
  reading: unknown = { inverterId: 'soliscloud:inv-1', ts: 1_700_000_000, source: 'stub', acPowerW: 1000, dcPowerW: null, todayKwh: null, totalKwh: null, batterySoc: null, batteryPowerW: null, gridPowerW: null, loadPowerW: null, tempC: null, status: null, metrics: null, raw: null };
  failOn: string | null = null;
  calls: string[] = [];

  async listPlants() { this.calls.push('listPlants'); if (this.failOn === 'listPlants') throw new Error('vendor is down'); return this.plants; }
  async listInverters(plantId: string) { this.calls.push(`listInverters:${plantId}`); return this.inverters as never; }
  async getReading() { this.calls.push('getReading'); return this.reading as never; }
  async listDevices() { this.calls.push('listDevices'); if (this.failOn === 'listDevices') throw new Error('device page moved'); return []; }
  async listAlarms() { this.calls.push('listAlarms'); return []; }
  async listPeriods(_p: string, year: number, month?: number) { this.calls.push(`listPeriods:${year}${month ? `-${month}` : ''}`); return []; }
}

vi.mock('../../src/providers/soliscloud', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  SolisCloudProvider: class { constructor() { const p = new StubProvider(); solis.instances.push(p); return p; } },
}));
vi.mock('../../src/providers/solarman', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  SolarmanProvider: class { constructor() { const p = new StubProvider(); p.id = 'solarman' as never; solarman.instances.push(p); return p; } },
}));
vi.mock('../../src/providers/solarman-web', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  SolarmanWebProvider: class { constructor() { const p = new StubProvider(); p.id = 'solarman' as never; solarmanWeb.instances.push(p); return p; } },
}));

const { buildProviders, plantFilter, pollAll, pollExtras, yearsFromMonths } = await import('../../src/poll');

let d1: TestD1;
const envWith = (over: Partial<Env> = {}): Env => ({ DB: d1.db, ASSETS: {} as Fetcher, ...over });

beforeEach(() => {
  d1?.close();
  d1 = createTestD1();
  solis.instances.length = 0;
  solarman.instances.length = 0;
  solarmanWeb.instances.length = 0;
});

describe('buildProviders', () => {
  it('builds nothing without credentials', () => {
    expect(buildProviders(envWith())).toHaveLength(0);
  });

  it('builds SolisCloud only when both halves of the key are present', () => {
    expect(buildProviders(envWith({ SOLIS_KEY_ID: 'id' }))).toHaveLength(0);
    expect(buildProviders(envWith({ SOLIS_KEY_ID: 'id', SOLIS_KEY_SECRET: 'secret' }))).toHaveLength(1);
  });

  it('prefers SolarMan official keys over the browser-session fallback', () => {
    const both = buildProviders(envWith({
      SOLARMAN_APP_ID: 'a', SOLARMAN_APP_SECRET: 'b', SOLARMAN_EMAIL: 'c', SOLARMAN_PASSWORD_SHA256: 'd',
      SOLARMAN_WEB_REFRESH_TOKEN: 'web',
    }));
    expect(both).toHaveLength(1);
    expect(solarman.instances).toHaveLength(1);
    expect(solarmanWeb.instances).toHaveLength(0);
  });

  it('falls back to the browser session when there are no official keys', () => {
    expect(buildProviders(envWith({ SOLARMAN_WEB_REFRESH_TOKEN: 'web' }))).toHaveLength(1);
    expect(solarmanWeb.instances).toHaveLength(1);
  });
});

describe('plantFilter', () => {
  it('lets everything through when INCLUDE_PLANTS is unset or blank', () => {
    expect(plantFilter(envWith())('anything')).toBe(true);
    expect(plantFilter(envWith({ INCLUDE_PLANTS: '  ,  ' }))('anything')).toBe(true);
  });

  it('keeps only the named plants, ignoring spacing', () => {
    const wanted = plantFilter(envWith({ INCLUDE_PLANTS: ' a , b ' }));
    expect([wanted('a'), wanted('b'), wanted('c')]).toEqual([true, true, false]);
  });
});

describe('pollAll', () => {
  it('says so in the poll log when nothing is configured', async () => {
    const env = envWith();
    expect(await pollAll(env)).toEqual([]);
    const [logged] = await recentPolls(env.DB);
    expect(logged).toMatchObject({ provider: 'none', ok: 0 });
    expect(logged.detail).toContain('no provider credentials');
  });

  it('stores a reading, names the plant it came from, and logs the poll', async () => {
    const env = envWith({ SOLIS_KEY_ID: 'id', SOLIS_KEY_SECRET: 'secret' });
    const [summary] = await pollAll(env);
    expect(summary).toMatchObject({ provider: 'soliscloud', ok: true, inverters: 1, newReadings: 1 });

    const [logged] = await recentPolls(env.DB);
    expect(logged.detail).toBe('plants=1 inverters=1 new=1');
    // The inverter arrived with no name; the plant's is filled in.
    const row = d1.raw.prepare('SELECT name, plant_name, capacity_w FROM inverters').get() as Record<string, unknown>;
    expect(row).toMatchObject({ name: 'Stub Plant', plant_name: 'Stub Plant', capacity_w: 10_000 });
  });

  it('polls only the plants INCLUDE_PLANTS names', async () => {
    const env = envWith({ SOLIS_KEY_ID: 'id', SOLIS_KEY_SECRET: 'secret', INCLUDE_PLANTS: 'somewhere-else' });
    const [summary] = await pollAll(env);
    expect(summary).toMatchObject({ ok: true, inverters: 0, newReadings: 0 });
  });

  it('records a provider failure instead of throwing, and keeps the other provider', async () => {
    const env = envWith({
      SOLIS_KEY_ID: 'id', SOLIS_KEY_SECRET: 'secret',
      SOLARMAN_APP_ID: 'a', SOLARMAN_APP_SECRET: 'b', SOLARMAN_EMAIL: 'c', SOLARMAN_PASSWORD_SHA256: 'd',
    });
    const built = buildProviders(env) as unknown as StubProvider[];
    built[0].failOn = 'listPlants';
    solis.instances.length = 0;
    solarman.instances.length = 0;
    // pollAll builds its own providers; make the next SolisCloud one fail too.
    const originalPlants = StubProvider.prototype.listPlants;
    let first = true;
    StubProvider.prototype.listPlants = async function (this: StubProvider) {
      if (first && this.id === 'soliscloud') { first = false; throw new Error('vendor is down'); }
      return originalPlants.call(this);
    };
    try {
      const summaries = await pollAll(env);
      expect(summaries).toHaveLength(2);
      const failed = summaries.find((s) => !s.ok);
      expect(failed?.error).toBe('vendor is down');
      expect(summaries.find((s) => s.ok)).toBeTruthy();
      const logs = await recentPolls(env.DB);
      expect(logs.some((l) => l.ok === 0 && l.detail === 'vendor is down')).toBe(true);
    } finally {
      StubProvider.prototype.listPlants = originalPlants;
    }
  });

  it('keeps the reading when the hardware list fails', async () => {
    const env = envWith({ SOLIS_KEY_ID: 'id', SOLIS_KEY_SECRET: 'secret' });
    const originalDevices = StubProvider.prototype.listDevices;
    StubProvider.prototype.listDevices = async () => { throw new Error('device page moved'); };
    try {
      const [summary] = await pollAll(env);
      expect(summary).toMatchObject({ ok: true, newReadings: 1 });
    } finally {
      StubProvider.prototype.listDevices = originalDevices;
    }
  });

  it('counts an inverter even when the vendor has no reading for it', async () => {
    const env = envWith({ SOLIS_KEY_ID: 'id', SOLIS_KEY_SECRET: 'secret' });
    const originalReading = StubProvider.prototype.getReading;
    StubProvider.prototype.getReading = async () => null as never;
    try {
      const [summary] = await pollAll(env);
      expect(summary).toMatchObject({ ok: true, inverters: 1, newReadings: 0 });
    } finally {
      StubProvider.prototype.getReading = originalReading;
    }
  });
});

describe('pollExtras', () => {
  it('reads alarms when due, and not again until the hour is up', async () => {
    const env = envWith();
    const p = new StubProvider();
    await pollExtras(env, p, 'plant-1');
    expect(p.calls).toContain('listAlarms');

    p.calls.length = 0;
    await pollExtras(env, p, 'plant-1');
    expect(p.calls).not.toContain('listAlarms');
  });

  it('walks back year by year on the first run, and stops at the first empty year', async () => {
    const env = envWith();
    const p = new StubProvider();
    const years: number[] = [];
    p.listPeriods = async (_plant: string, year: number, month?: number) => {
      if (month) return [];
      years.push(year);
      // Two years of history, then nothing: the year before the array existed.
      return years.length <= 2 ? [{ inverterId: 'soliscloud:station:plant-1', provider: 'soliscloud', period: 'month', key: `${year}-01`, yieldKwh: 10, loadKwh: null, importKwh: null, exportKwh: null, chargeKwh: null, dischargeKwh: null, fullHours: null, source: 'stub' }] as never : [];
    };
    await pollExtras(env, p, 'plant-1', new Date('2026-09-19T00:00:00Z'));
    expect(years.slice(0, 3)).toEqual([2026, 2025, 2024]);
    expect(years).toHaveLength(3);
  });

  it('later runs read only this year and this month', async () => {
    const env = envWith();
    const p = new StubProvider();
    await pollExtras(env, p, 'plant-1', new Date('2026-09-19T00:00:00Z'));
    // Let the daily key expire, but keep the year-long backfill key.
    await markDone(env.DB, 'periods:soliscloud:plant-1', -1);
    expect(await isDue(env.DB, 'periods-backfill:soliscloud:plant-1')).toBe(false);

    p.calls.length = 0;
    await pollExtras(env, p, 'plant-1', new Date('2026-09-19T00:00:00Z'));
    expect(p.calls.filter((c) => c.startsWith('listPeriods'))).toEqual(['listPeriods:2026', 'listPeriods:2026-9']);
  });

  it('does nothing for a provider that has neither list', async () => {
    const env = envWith();
    const bare = { id: 'soliscloud', listPlants: async () => [], listInverters: async () => [], getReading: async () => null } as unknown as Provider;
    await expect(pollExtras(env, bare, 'plant-1')).resolves.toBeUndefined();
  });
});

describe('yearsFromMonths', () => {
  const month = (key: string, yieldKwh: number | null, over: Record<string, unknown> = {}) => ({
    inverterId: 'soliscloud:station:plant-1', provider: 'soliscloud', period: 'month' as const, key,
    yieldKwh, loadKwh: null, importKwh: null, exportKwh: null, chargeKwh: null, dischargeKwh: null,
    fullHours: null, source: 'stub', ...over,
  });

  it('adds a year\'s months into that year, by the vendor\'s own numbers', () => {
    const [year] = yearsFromMonths([month('2026-01', 100), month('2026-02', 50)] as never);
    expect(year).toMatchObject({ period: 'year', key: '2026', yieldKwh: 150 });
  });

  it('keeps years apart, and ignores anything that is not a month', () => {
    const years = yearsFromMonths([month('2025-12', 10), month('2026-01', 20), month('2026', 5, { period: 'year' })] as never);
    expect(years.map((y) => [y.key, y.yieldKwh])).toEqual([['2025', 10], ['2026', 20]]);
  });

  it('null plus null stays null: a figure the vendor never reported is not zero', () => {
    const [year] = yearsFromMonths([month('2026-01', null), month('2026-02', null)] as never);
    expect(year.yieldKwh).toBeNull();
  });
});
