import { describe, expect, it } from 'vitest';
import { pollExtras, yearsFromMonths } from '../../src/poll';
import type { Env } from '../../src/db';
import type { Alarm, Period } from '../../src/providers/events';
import type { Provider } from '../../src/providers/types';

/**
 * Just enough of D1 to watch what pollExtras does: the kv schedule table, and
 * the rows it writes. Nothing here parses SQL beyond telling the three kinds of
 * statement apart.
 */
function fakeDb() {
  const kv = new Map<string, number>();
  const alarms: unknown[][] = [];
  const periods: unknown[][] = [];
  // A D1 statement stand-in: remembers the SQL and arguments, and answers from the maps above.
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => (sql.includes('FROM kv') && kv.has(String(args[0])) ? { expires_at: kv.get(String(args[0])) } : null),
    run: async () => { if (sql.includes('INTO kv')) kv.set(String(args[0]), Number(args[2])); return {}; },
    all: async () => ({ results: [] }),
    sql, args,
  });
  const db = {
    prepare: (sql: string) => stmt(sql),
    batch: async (stmts: { sql: string; args: unknown[] }[]) => {
      for (const s of stmts) (s.sql.includes('INTO alarms') ? alarms : periods).push(s.args);
      return [];
    },
  };
  return { env: { DB: db } as unknown as Env, kv, alarms, periods };
}

const alarm = (code: string): Alarm => ({
  id: `solarman:1:${code}:100`, inverterId: 'solarman:station:1', provider: 'solarman', code,
  message: null, severity: 'fault', vendorLevel: 2, advice: null, beginTs: 100, endTs: null, state: 'unknown',
});

const month = (key: string, y: number): Period => ({
  inverterId: 'solarman:station:1', period: 'month', key, yieldKwh: y, loadKwh: y / 2, importKwh: null,
  exportKwh: 1, chargeKwh: null, dischargeKwh: null, fullHours: 2, source: 'solarman-web',
});

/** A provider whose history begins in 2025. */
function provider(calls: string[]): Provider {
  return {
    id: 'solarman',
    listPlants: async () => [],
    listInverters: async () => [],
    getReading: async () => null,
    listAlarms: async () => { calls.push('alarms'); return [alarm('7'), alarm('8')]; },
    listPeriods: async (_plant, year, m) => {
      calls.push(m ? `month ${year}-${m}` : `year ${year}`);
      if (m) return [{ ...month(`${year}-0${m}-01`, 9), period: 'day' }];
      return year >= 2025 ? [month(`${year}-01`, 100), month(`${year}-02`, 120)] : [];
    },
  };
}

const NOW = new Date(Date.UTC(2026, 8, 16, 10));

describe('pollExtras', () => {
  it('first run: alarms, then years walked back until the first empty one, then this month', async () => {
    const { env, alarms, periods } = fakeDb();
    const calls: string[] = [];
    await pollExtras(env, provider(calls), '1', NOW);
    expect(calls).toEqual(['alarms', 'year 2026', 'year 2025', 'year 2024', 'month 2026-9']);
    expect(alarms).toHaveLength(2);
    // Four months, one day, and a year total for each of the two years.
    expect(periods).toHaveLength(4 + 1 + 2);
  });

  it('within the hour and the day, it asks the vendor for nothing', async () => {
    const { env } = fakeDb();
    const calls: string[] = [];
    const p = provider(calls);
    await pollExtras(env, p, '1', NOW);
    calls.length = 0;
    await pollExtras(env, p, '1', NOW);
    expect(calls).toEqual([]);
  });

  it('once backfilled, a daily refresh reads only this year and this month', async () => {
    const { env, kv } = fakeDb();
    const calls: string[] = [];
    const p = provider(calls);
    await pollExtras(env, p, '1', NOW);
    // Expire the daily and hourly keys but not the year-long backfill marker.
    kv.set('periods:solarman:1', 0);
    kv.set('alarms:solarman:1', 0);
    calls.length = 0;
    await pollExtras(env, p, '1', NOW);
    expect(calls).toEqual(['alarms', 'year 2026', 'month 2026-9']);
  });

  it('an empty current year does not stop the walk before the history it has', async () => {
    const { env } = fakeDb();
    const calls: string[] = [];
    const p = provider(calls);
    // Early January: nothing yet this year, but last year is full.
    p.listPeriods = async (_plant, year, m) => {
      calls.push(m ? `month ${year}-${m}` : `year ${year}`);
      if (m) return [];
      return year === 2025 ? [month('2025-12', 80)] : [];
    };
    await pollExtras(env, p, '1', new Date(Date.UTC(2026, 0, 2)));
    expect(calls.filter((c) => c.startsWith('year')).slice(0, 3)).toEqual(['year 2026', 'year 2025', 'year 2024']);
  });

  it('a provider with neither method is left alone', async () => {
    const { env, alarms, periods } = fakeDb();
    const bare: Provider = { id: 'soliscloud', listPlants: async () => [], listInverters: async () => [], getReading: async () => null };
    await pollExtras(env, bare, '1', NOW);
    expect(alarms).toHaveLength(0);
    expect(periods).toHaveLength(0);
  });
});

describe('yearsFromMonths', () => {
  it('sums a year\'s months, keeping unmeasured figures unmeasured', () => {
    const [y] = yearsFromMonths([month('2025-01', 100), month('2025-02', 120)]);
    expect(y).toMatchObject({ period: 'year', key: '2025', yieldKwh: 220, loadKwh: 110, exportKwh: 2, fullHours: 4 });
    expect(y.importKwh).toBeNull();
  });

  it('keeps each year and each system apart', () => {
    const other = { ...month('2025-01', 50), inverterId: 'solarman:station:2' };
    const years = yearsFromMonths([month('2025-01', 100), month('2026-01', 10), other]);
    expect(years.map((y) => `${y.inverterId} ${y.key} ${y.yieldKwh}`).sort()).toEqual([
      'solarman:station:1 2025 100', 'solarman:station:1 2026 10', 'solarman:station:2 2025 50',
    ]);
  });

  it('ignores day rows', () => {
    expect(yearsFromMonths([{ ...month('2025-01-01', 5), period: 'day' }])).toEqual([]);
  });
});
