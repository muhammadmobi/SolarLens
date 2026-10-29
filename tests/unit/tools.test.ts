/**
 * The read-only tools behind Ask SolarLens, the agents and the MCP server.
 *
 * Held to what src/tools.ts promises: a period is resolved on the plants'
 * calendar the way a person means it; arguments are checked before anything
 * runs; every figure is the Worker's own, labelled with its period and how
 * fresh the data was; and no internal id is in a result. The figures here are
 * made up to be checked by hand: two systems, Roof (5 kWp) and Garage (4 kWp).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TOOLS, checkArgs, jsonSchemaOf, pickSystems, resolvePeriod, runTool, spanWords, toolByName, type Sys, type ToolResult,
} from '../../src/tools';
import { setTariff } from '../../src/settings';
import { createHarness, type Harness } from '../helpers/worker';
import { DAY, addDay, addFault, addHybridDay, addSun, addSystem, dayNumber, isoOf } from '../helpers/solar-days';

/** Monday 28 September 2026, 09:00 UTC. */
const NOW = Date.UTC(2026, 8, 28, 9) / 1000;
const ROOF = 'solarman:station:alpha';
const GARAGE = 'solarman:station:beta';

const period = (args: Record<string, string>) => {
  const p = resolvePeriod(args, NOW, 0, 'this_month');
  return [p.from, p.to, p.label];
};

describe('a period', () => {
  it('is a named range, the way a person means it, on the plants\' calendar', () => {
    expect(period({ range: 'today' })).toEqual(['2026-09-28', '2026-09-28', 'today (Mon 28 Sep 2026)']);
    expect(period({ range: 'yesterday' })).toEqual(['2026-09-27', '2026-09-27', 'yesterday (Sun 27 Sep 2026)']);
    expect(period({ range: 'this_week' }).slice(0, 2)).toEqual(['2026-09-28', '2026-09-28']);
    expect(period({ range: 'last_week' })).toEqual(['2026-09-21', '2026-09-27', 'last week (21 – 27 Sep 2026)']);
    expect(period({ range: 'this_month' }).slice(0, 2)).toEqual(['2026-09-01', '2026-09-28']);
    expect(period({ range: 'last_month' })).toEqual(['2026-08-01', '2026-08-31', 'last month (1 – 31 Aug 2026)']);
    expect(period({ range: 'this_year' }).slice(0, 2)).toEqual(['2026-01-01', '2026-09-28']);
    expect(period({ range: 'last_year' })).toEqual(['2025-01-01', '2025-12-31', 'last year (1 Jan – 31 Dec 2025)']);
    expect(period({ range: 'last_7_days' }).slice(0, 2)).toEqual(['2026-09-22', '2026-09-28']);
    expect(period({ range: 'last_30_days' }).slice(0, 2)).toEqual(['2026-08-30', '2026-09-28']);
    expect(period({ range: 'last_12_months' })).toEqual(['2025-09-29', '2026-09-28', 'the last 12 months (29 Sep 2025 – 28 Sep 2026)']);
    // Five hours east, it is already Tuesday at 21:00 UTC on Monday.
    expect(resolvePeriod({ range: 'today' }, Date.UTC(2026, 8, 28, 21) / 1000, 5 * 3600, 'today').from).toBe('2026-09-29');
  });

  it('is two dates, either way round, cut off at today, and never more than three years', () => {
    expect(period({ from: '2026-08-31', to: '2026-08-01' })).toEqual(['2026-08-01', '2026-08-31', '1 – 31 Aug 2026']);
    expect(period({ from: '2026-09-20', to: '2026-12-31' }).slice(0, 2)).toEqual(['2026-09-20', '2026-09-28']);
    expect(period({ from: '2026-07-14' })).toEqual(['2026-07-14', '2026-07-14', 'Tue 14 Jul 2026']);
    expect(() => period({ from: '2026-10-01' })).toThrow('has not begun');
    expect(() => period({ from: '2020-01-01', to: '2026-01-01' })).toThrow('three years');
    expect(() => period({ from: 'soon' })).toThrow('YYYY-MM-DD');
  });

  it('is written as a span a person reads', () => {
    expect(spanWords('2025-11-30', '2026-01-03')).toBe('30 Nov 2025 – 3 Jan 2026');
    expect(spanWords('2026-08-28', '2026-09-03')).toBe('28 Aug – 3 Sep 2026');
  });
});

describe('the systems an argument names', () => {
  const all: Sys[] = [
    { id: ROOF, alias: 's1', name: 'Roof', provider: 'solarman', kwp: 5, off: 0 },
    { id: GARAGE, alias: 's2', name: 'Garage roof', provider: 'solarman', kwp: 4, off: 0 },
  ];
  it('is every one, one by alias, by name in any case, or by the one name containing it', () => {
    expect(pickSystems(all, undefined)).toHaveLength(2);
    expect(pickSystems(all, 'all')).toHaveLength(2);
    expect(pickSystems(all, 's2')[0].name).toBe('Garage roof');
    expect(pickSystems(all, 'ROOF')[0].name).toBe('Roof');
    expect(pickSystems(all, 'garage')[0].name).toBe('Garage roof');
  });
  it('names the systems there are when it matches none, or more than one', () => {
    expect(() => pickSystems(all, 'shed')).toThrow('The systems are Roof, Garage roof.');
    expect(() => pickSystems([...all, { ...all[0], id: 'x', alias: 's3', name: 'Roof two' }], 'oof t')).not.toThrow();
  });
});

describe('arguments', () => {
  const energy = toolByName('energy')!;
  it('are checked against what a tool takes, tidied, and the rest dropped', () => {
    expect(checkArgs(energy, { range: 'Last week', measure: 'exported', system: ' Roof ', extra: 'dropped' }))
      .toEqual({ range: 'last_week', measure: 'exported', system: 'Roof' });
    expect(checkArgs(energy, undefined)).toEqual({});
    expect(checkArgs(energy, { range: 'next week' })).toMatch(/range is one of today, yesterday/);
    expect(checkArgs(energy, { from: '1 Aug' })).toMatch(/from does not have the right form/);
    expect(checkArgs(energy, [])).toMatch(/object/);
    expect(checkArgs(energy, { system: { name: 'Roof' } })).toMatch(/system is text/);
    const trend = toolByName('performance_trend')!;
    expect(checkArgs(trend, { weeks: '10' })).toEqual({ weeks: 10 });
    expect(checkArgs(trend, { weeks: 3 })).toMatch(/from 8 to 26/);
    expect(checkArgs(trend, { weeks: 9.5 })).toMatch(/whole number/);
  });

  it('are described as JSON Schema, for a model and for an MCP client', () => {
    const s = jsonSchemaOf(energy) as { properties: Record<string, Record<string, unknown>>; additionalProperties: boolean };
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.range.enum).toContain('last_week');
    expect(s.properties.from.pattern).toBe('^\\d{4}-\\d{2}-\\d{2}$');
    expect((jsonSchemaOf(toolByName('performance_trend')!) as { properties: Record<string, unknown> }).properties.weeks)
      .toMatchObject({ type: 'integer', minimum: 8, maximum: 26 });
    expect(TOOLS.map((t) => t.name)).toEqual(['status_now', 'outages', 'inverter', 'energy', 'power_day', 'chart', 'battery', 'compare_systems', 'stats', 'faults', 'day_report', 'performance_trend', 'analysis', 'figures', 'report', 'app_help']);
  });
});

// ------------------------------------------------------------------ with data

let h: Harness;
beforeEach(() => { h = createHarness(); });
afterEach(() => h.close());

const run = async (name: string, args: Record<string, unknown> = {}) => {
  const out = await runTool(h.env.DB, name, args, NOW);
  if ('error' in out) throw new Error(out.error);
  return out.result;
};
const noIds = (r: ToolResult) => expect(JSON.stringify(r)).not.toMatch(/station|alpha|beta/);

/**
 * August: Roof 20 kWh a day, 5 of it sold; Garage 15, with no export metered.
 * September to the 27th: Roof 18 (5 sold), Garage 12. July only as the
 * vendors' own month totals, from before SolarLens began.
 */
async function months() {
  await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5 });
  await addSystem(h.env.DB, { id: GARAGE, name: 'Garage', kwp: 4 });
  for (let n = dayNumber('2026-08-01'); n <= dayNumber('2026-09-27'); n++) {
    const aug = isoOf(n) < '2026-09-01';
    await addDay(h.env.DB, ROOF, isoOf(n), aug ? 20 : 18, { exported: 5 });
    await addDay(h.env.DB, GARAGE, isoOf(n), aug ? 15 : 12);
  }
  await h.env.DB.prepare(
    `INSERT INTO vendor_periods (inverter_id, period, key, yield_kwh, export_kwh, source, fetched_at) VALUES
       (?1, 'month', '2026-07', 600, 150, 'solarman', 1), (?2, 'month', '2026-07', 450, NULL, 'solarman', 1)`,
  ).bind(ROOF, GARAGE).run();
}

describe('energy', () => {
  it('per month over the year: the vendor\'s totals before SolarLens began, and the best and lowest month', async () => {
    await months();
    const r = await run('energy', { range: 'this_year', group_by: 'month' });
    expect(r.columns).toEqual(['Month', 'Made (kWh)', 'Sold (kWh)']);
    expect(r.rows.slice(6)).toEqual([['Jul 2026', 1050, 150], ['Aug 2026', 1085, 155], ['Sep 2026', 810, 135]]);
    expect(r.rows[0]).toEqual(['Jan 2026', null, null]);
    expect(r.facts).toMatchObject({
      total_made_kwh: 2945, total_exported_kwh: 440,
      highest_made_period: 'Aug 2026', highest_made_kwh: 1085, lowest_made_period: 'Sep 2026', lowest_made_kwh: 810, periods_with_data: 3,
    });
    expect(r.notes).toContain("SolarLens's own record begins on 1 Aug 2026; whole months before that use the vendor's own totals.");
    expect(r.notes).toContain('Garage does not report what was sold.');
    expect(r.summary).toBe('Your systems made 2945 kWh this year (1 Jan – 28 Sep 2026). The best month was Aug 2026 with 1085 kWh; the lowest was Sep 2026 with 810 kWh.');
    expect(r.period).toEqual({ from: '2026-01-01', to: '2026-09-28', label: 'this year (1 Jan – 28 Sep 2026)' });
    noIds(r);
  });

  it('answers "how much did I export last week", and says which system does not report it', async () => {
    await months();
    const r = await run('energy', { range: 'last_week', measure: 'exported' });
    expect(r.facts.total_exported_kwh).toBe(35);
    expect(r.rows).toHaveLength(7);
    expect(r.summary.startsWith('Your systems sold 35 kWh to the grid last week (21 – 27 Sep 2026).')).toBe(true);
    expect(r.notes).toEqual(['Garage does not report what was sold.']);
  });

  it('for one system, day by day, and in total', async () => {
    await months();
    const days = await run('energy', { range: 'last_month', system: 'garage' });
    expect(days.title).toBe('Energy per day, Garage');
    expect(days.rows).toHaveLength(31);
    expect(days.rows[0]).toEqual(['Sat 1 Aug 2026', 15]);
    expect(days.summary.startsWith('Garage made 465 kWh last month (1 – 31 Aug 2026).')).toBe(true);
    const total = await run('energy', { from: '2026-08-01', to: '2026-08-31', group_by: 'total', system: 'Roof' });
    expect(total.rows).toEqual([['1 – 31 Aug 2026', 620, 155]]);
    const weeks = await run('energy', { range: 'last_30_days', group_by: 'week' });
    expect(weeks.rows[0][0]).toBe('week of 30 Aug 2026');
  });

  it("adds the money and the CO2 by the owner's tariff, and says when part of it is an upper bound", async () => {
    await months();
    await setTariff(h.env.DB, { currency: 'EUR', importPrice: 0.3, exportPrice: 0.1, netMetering: false, co2KgPerKwh: 0.4 });
    const r = await run('energy', { range: 'last_week' });
    // Roof: 7 x (13 x 0.3 + 5 x 0.1) = 30.8. Garage: 7 x 12 x 0.3 = 25.2, its export unknown.
    // CO2: (18 + 12) x 7 = 210 kWh, x 0.4.
    expect(r.facts).toMatchObject({ saved: 56, currency: 'EUR', co2_avoided_kg: 84, saved_is_upper_bound: 'yes' });
    expect(r.summary).toContain('That saved about 56 EUR and avoided 84 kg of CO2.');
  });

  it('says so when there is nothing to count', async () => {
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5 });
    const r = await run('energy', { range: 'last_week' });
    expect(r.summary).toBe('There is no record of energy made last week (21 – 27 Sep 2026).');
  });
});

describe('compare_systems', () => {
  it('puts the systems side by side per kWp, best first, and says by how much the lowest trails', async () => {
    await months();
    const r = await run('compare_systems', { range: 'last_month' });
    expect(r.rows).toEqual([['Roof', 5, 620, 124, 31], ['Garage', 4, 465, 116.3, 31]]);
    expect(r.facts).toMatchObject({ best_system: 'Roof', best_kwh_per_kwp: 124, lowest_system: 'Garage', lowest_kwh_per_kwp: 116.3, lowest_below_best_pct: 6 });
    expect(r.summary).toBe('Per kWp of panels last month (1 – 31 Aug 2026), Roof did best with 124 kWh per kWp; Garage made 116.3, 6% less.');
  });

  it('says when a system reported on fewer days, or has no size', async () => {
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5 });
    await addSystem(h.env.DB, { id: GARAGE, name: 'Garage', kwp: null });
    for (const d of ['2026-09-21', '2026-09-22']) await addDay(h.env.DB, ROOF, d, 20);
    await addDay(h.env.DB, GARAGE, '2026-09-21', 10);
    const r = await run('compare_systems', { range: 'last_week' });
    expect(r.notes).toEqual(['Roof reported on 2 of the 7 days, which lowers its figure.', 'Garage reported on 1 of the 7 days, which lowers its figure.', 'Garage has no size recorded, so it has no per-kWp figure.']);
    expect(r.summary).toBe('Per kWp of panels last week (21 – 27 Sep 2026), Roof did best with 8 kWh per kWp.');
  });
});

describe('faults', () => {
  it('lists each, counts the ones still active, and names the most common', async () => {
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5 });
    await addSystem(h.env.DB, { id: GARAGE, name: 'Garage', kwp: 4 });
    const at = (iso: string, hh: number) => dayNumber(iso) * DAY + hh * 3600;
    await addFault(h.env.DB, ROOF, 'f1', at('2026-09-10', 11), at('2026-09-10', 11) + 2280, 'DC voltage low');
    await addFault(h.env.DB, ROOF, 'f2', at('2026-09-24', 12), null, 'DC voltage low', 'fault');
    await addFault(h.env.DB, GARAGE, 'f3', at('2026-09-12', 9), at('2026-09-12', 10), 'Grid lost');
    await addFault(h.env.DB, GARAGE, 'f4', at('2026-07-01', 9), at('2026-07-01', 10), 'Long ago');
    const r = await run('faults', {});
    expect(r.rows).toEqual([
      ['Thu 10 Sep 2026 11:00', 'Roof', 'DC voltage low', 'warning', 'cleared after 38 min'],
      ['Sat 12 Sep 2026 09:00', 'Garage', 'Grid lost', 'warning', 'cleared after 1 h'],
      ['Thu 24 Sep 2026 12:00', 'Roof', 'DC voltage low', 'fault', 'still active'],
    ]);
    expect(r.facts).toEqual({ faults: 3, still_active: 1, most_common: 'DC voltage low', most_common_times: 2 });
    expect(r.summary).toBe('3 faults were recorded the last 30 days (30 Aug – 28 Sep 2026), 1 still active; the most common was DC voltage low, 2 times.');
    expect((await run('faults', { system: 'Garage', range: 'last_week' })).summary).toBe('No faults were recorded last week (21 – 27 Sep 2026).');
  });
});

describe('status_now', () => {
  it('says what each is doing now, counting a system that has stopped reporting as making nothing', async () => {
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5 });
    await addSystem(h.env.DB, { id: GARAGE, name: 'Garage', kwp: 4 });
    await addDay(h.env.DB, GARAGE, '2026-09-27', 12);
    await h.env.DB.prepare(`INSERT INTO readings (inverter_id, ts, source, ac_power_w, today_kwh, battery_soc, tz_offset_sec) VALUES (?1, ?2, 'test', 2400, 3.2, 81, 0)`)
      .bind(ROOF, NOW - 120).run();
    const r = await run('status_now', {});
    expect(r.rows).toEqual([['Roof', 'reporting', 2400, 3.2, 81, '08:58'], ['Garage', 'offline', 0, null, null, '19:39']]);
    expect(r.facts).toEqual({ power_now_w: 2400, made_today_kwh: 3.2, reporting: 1, systems: 2 });
    expect(r.summary).toBe("Your 2 systems are making 2.4 kW now, and 3.2 kWh so far today; 1 of 2 reporting. Roof's battery is at 81%.");
    expect(r.freshness).toEqual({ newest: NOW - 120, offline: ['Garage'] });
    expect(r.notes).toEqual(['Not reporting now: Garage. An offline system counts as making nothing.']);
  });
});

// ------------------------------------------------------------------ why a day was low

describe('day_report', () => {
  /** Fourteen ordinary days before Sunday 27 September: Roof 20 kWh in 5 kWh/m² of sun, Garage 16. */
  async function fortnight() {
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5 });
    await addSystem(h.env.DB, { id: GARAGE, name: 'Garage', kwp: 4 });
    for (let n = dayNumber('2026-09-13'); n <= dayNumber('2026-09-26'); n++) {
      for (const [id, kwh] of [[ROOF, 20], [GARAGE, 16]] as const) {
        await addDay(h.env.DB, id, isoOf(n), kwh);
        await addSun(h.env.DB, id, isoOf(n), 5);
      }
    }
  }

  it('finds a gap in the readings, a dull day and a fault, and knows an ordinary day when it sees one', async () => {
    await fortnight();
    await addDay(h.env.DB, ROOF, '2026-09-27', 8, { skip: ['10:00', '13:00'] });
    await addSun(h.env.DB, ROOF, '2026-09-27', 2, 90);
    await addFault(h.env.DB, ROOF, 'f1', dayNumber('2026-09-27') * DAY + 11 * 3600, dayNumber('2026-09-27') * DAY + 12 * 3600, 'DC voltage low');
    await addDay(h.env.DB, GARAGE, '2026-09-27', 15.5);
    await addSun(h.env.DB, GARAGE, '2026-09-27', 5);
    const r = await run('day_report', { date: 'yesterday' });
    expect(r.period).toEqual({ from: '2026-09-27', to: '2026-09-27', label: 'Sun 27 Sep 2026' });
    expect(r.rows).toEqual([
      ['Roof', 8, 20, 40, 2, 5, 8, 195, 1],
      ['Garage', 15.5, 16, 97, 5, 5, 16, 0, 0],
    ]);
    expect(r.facts).toMatchObject({ s1_of_usual_pct: 40, s1_not_reporting_min: 195, s1_cloud_pct: 90, s2_of_usual_pct: 97 });
    expect(r.summary).toBe(
      'Roof made 8 kWh, 40% of a usual day (20 kWh): no readings for 3 h 15 min (09:54–13:09), so part of the day was not recorded; '
      + 'less sun: 2 kWh/m² of sunlight against a usual 5, with 90% cloud; a fault: DC voltage low, from 11:00 to 12:00. '
      + 'Garage made 15.5 kWh, 97% of a usual day (16 kWh): not a low day: 97% of a usual day.',
    );
    noIds(r);
  });

  it('says a system fell short of its sunlight when the sun was normal and it was reporting', async () => {
    await fortnight();
    await addDay(h.env.DB, ROOF, '2026-09-27', 10);
    await addSun(h.env.DB, ROOF, '2026-09-27', 5);
    const r = await run('day_report', { date: '2026-09-27', system: 'Roof' });
    expect(r.facts).toMatchObject({ made_kwh: 10, expected_kwh: 20, of_expected_pct: 50, not_reporting_min: 0 });
    expect(r.summary).toBe('Roof made 10 kWh, 50% of a usual day (20 kWh): it made 50% of what its sunlight allowed: shading, dirt, snow or a string down.');
  });

  it('calls a day well below usual so, and says when there was no sunlight to judge the weather by', async () => {
    await fortnight();
    await addDay(h.env.DB, ROOF, '2026-09-27', 8);
    const r = await run('day_report', { date: '2026-09-27', system: 'Roof' });
    expect(r.summary).toBe('Roof made 8 kWh, 40% of a usual day (20 kWh): well below usual (40%), and there is no sunlight on record for that day to tell whether it was the weather.');
  });

  it('says when there were no readings at all, and refuses a day not yet come or too long ago', async () => {
    await fortnight();
    const r = await run('day_report', { date: '2026-09-27', system: 'Roof' });
    expect(r.summary).toBe('Roof has no total for that day: no readings at all that day: the feed was down, or the system was off.');
    await expect(run('day_report', { date: '2026-09-29' })).rejects.toThrow('not happened yet');
    await expect(run('day_report', { date: '2025-01-01' })).rejects.toThrow('about a year');
  });
});

// ------------------------------------------------------------------ slow decline

describe('performance_trend', () => {
  /**
   * Twelve weeks before this one: Roof 20 kWh a day in 5 kWh/m² of sun (a ratio
   * of 0.8) for eight weeks, then 16 (0.64) for the last four; Garage 16 kWh
   * throughout (0.8, steady).
   */
  async function quarter() {
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5 });
    await addSystem(h.env.DB, { id: GARAGE, name: 'Garage', kwp: 4 });
    const first = dayNumber('2026-09-28') - 7 * 12;
    for (let n = first; n < dayNumber('2026-09-28'); n++) {
      const late = n >= dayNumber('2026-09-28') - 28;
      await addDay(h.env.DB, ROOF, isoOf(n), late ? 16 : 20);
      await addDay(h.env.DB, GARAGE, isoOf(n), 16);
      await addSun(h.env.DB, ROOF, isoOf(n), 5);
      await addSun(h.env.DB, GARAGE, isoOf(n), 5);
    }
  }

  it('finds a system slowly making less for its sunlight, and one holding steady', async () => {
    await quarter();
    const r = await run('performance_trend', {});
    expect(r.rows).toHaveLength(12);
    expect(r.rows[0]).toEqual(['6 Jul 2026', 0.8, 0.8]);
    expect(r.rows[11]).toEqual(['21 Sep 2026', 0.64, 0.8]);
    expect(r.facts).toMatchObject({
      s1_verdict: 'declining', s1_change_pct: -20, s1_recent_ratio: 0.64, s1_earlier_ratio: 0.8,
      s2_verdict: 'steady', s2_change_pct: 0,
    });
    expect(r.summary).toBe(
      'Roof: for its sunlight it is making 20% less (performance ratio 0.64 over the last 4 weeks, against 0.8 in the 8 before) - worth a look for dirt, shade or a string down. '
      + 'Garage: steady (performance ratio 0.8 over the last 4 weeks, against 0.8 in the 8 before).',
    );
    expect(r.period?.label).toBe('the 12 weeks from 6 Jul – 27 Sep 2026');
  });

  it('will not guess without enough sunny, fully recorded weeks', async () => {
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5 });
    await addSystem(h.env.DB, { id: GARAGE, name: 'Garage', kwp: null });
    await addDay(h.env.DB, ROOF, '2026-09-21', 20);
    const r = await run('performance_trend', { weeks: 8 });
    expect(r.facts).toMatchObject({ s1_verdict: 'not enough data', s2_verdict: 'not enough data' });
    expect(r.summary).toBe('Roof: not enough sunny, fully recorded weeks yet to tell. Garage: not enough sunny, fully recorded weeks yet to tell (and no size recorded).');
  });
});

describe('running a tool by name', () => {
  it('says what is wrong rather than running with arguments it does not take', async () => {
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5 });
    expect(await runTool(h.env.DB, 'delete_everything', {}, NOW)).toEqual({ error: 'There is no tool called delete_everything.' });
    expect(await runTool(h.env.DB, 'energy', { range: 'someday' }, NOW)).toEqual({ error: expect.stringContaining('range is one of') });
    expect(await runTool(h.env.DB, 'energy', { system: 'Shed' }, NOW)).toEqual({ error: expect.stringContaining('no one system called "Shed"') });
  });
});

// ------------------------------------------------------------------ statistics, reports, and the app itself

describe('stats', () => {
  it("gives each system's days in figures: total, average, median, best and worst, spread, per kWp, capacity factor", async () => {
    await months();
    const r = await run('stats', { range: 'last_month' });
    expect(r.rows).toEqual([
      ['Roof', 31, 620, 20, 20, 'Sat 1 Aug 2026: 20', 'Sat 1 Aug 2026: 20', 0, 124, 16.7, 0, null],
      ['Garage', 31, 465, 15, 15, 'Sat 1 Aug 2026: 15', 'Sat 1 Aug 2026: 15', 0, 116.3, 15.6, 0, null],
    ]);
    expect(r.facts).toMatchObject({ s1_total_kwh: 620, s1_capacity_factor_pct: 16.7, s2_kwh_per_kwp: 116.3, s1_change_pct: null });
    expect(r.summary).toContain('Roof: 31 days, 620 kWh - 20 kWh on an average day (median 20); best Sat 1 Aug 2026 with 20 kWh');
    noIds(r);
  });

  it('leaves today out, and sets the period against as many days before it', async () => {
    await months();
    const r = await run('stats', { range: 'this_month', system: 'Roof' });
    expect(r.period).toMatchObject({ from: '2026-09-01', to: '2026-09-27', label: 'this month (1 – 28 Sep 2026), to yesterday' });
    expect(r.notes[0]).toBe('Today is left out: it is not over yet.');
    // September to the 27th, 18 a day, against 5 to 31 August, 20 a day: 10% less.
    expect(r.facts).toMatchObject({ days: 27, total_kwh: 486, change_pct: -10 });
    expect(r.summary).toContain('10% less a day than in the 27 days before');
    await expect(run('stats', { range: 'today' })).rejects.toThrow('at least one whole day');
  });

  it('counts whole days only: a first evening with one reading is no worst day, and is named', async () => {
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5 });
    // The first reading comes after dark and says nothing was made; the next two days are whole.
    await addDay(h.env.DB, ROOF, '2026-09-20', 0, { readings: 1 });
    await addDay(h.env.DB, ROOF, '2026-09-21', 20);
    await addDay(h.env.DB, ROOF, '2026-09-22', 16);
    const r = await run('stats', { from: '2026-09-20', to: '2026-09-22' });
    expect(r.rows[0]).toEqual(['Roof', 2, 36, 18, 18, 'Mon 21 Sep 2026: 20', 'Tue 22 Sep 2026: 16', 2, 7.2, 15, 0, null]);
    expect(r.notes[0]).toBe('Left out, with too few readings to be whole days (under 60): Roof: Sun 20 Sep 2026.');
    // A system with no whole day at all says so.
    const none = await run('stats', { from: '2026-09-20', to: '2026-09-20' });
    expect(none.summary).toBe('Roof: no whole day recorded.');
    // Energy keeps the evening in its table and total, but not as the lowest day.
    const e = await run('energy', { from: '2026-09-20', to: '2026-09-22', group_by: 'day' });
    expect(e.rows.map((x) => x[1])).toEqual([0, 20, 16]);
    expect(e.facts).toMatchObject({ total_made_kwh: 36, lowest_made_period: 'Tue 22 Sep 2026', highest_made_period: 'Mon 21 Sep 2026', periods_with_data: 2 });
    expect(e.notes).toContain('Not wholly recorded, so left out of the best and lowest day: Sun 20 Sep 2026.');
  });
});

describe('report', () => {
  it('puts a period together: the headline figures, and each part as a section of its own', async () => {
    await months();
    const r = await run('report', { range: 'last_month' });
    expect(r.title).toBe('Report');
    expect(r.sections?.map((s) => s.tool)).toEqual(['energy', 'compare_systems', 'stats', 'faults', 'performance_trend']);
    expect(r.rows).toEqual(expect.arrayContaining([['Made (kWh)', 1085], ['Sold (kWh)', 155], ['Best per kWp', 'Roof: 124 kWh/kWp'], ['Faults', '0']]));
    expect(r.rows.find((x) => x[0] === 'Health')?.[1]).toBe('Roof: not enough data; Garage: not enough data');
    expect(r.facts).toMatchObject({ total_made_kwh: 1085, best_system: 'Roof', faults: 0 });
    expect(r.summary.startsWith('Your systems made 1085 kWh last month (1 – 31 Aug 2026).')).toBe(true);
    expect(r.summary).toContain('No faults were recorded');
    noIds(r);
  });

  it('for one system: its best and worst day in the headline, and no comparison', async () => {
    await months();
    const r = await run('report', { range: 'last_month', system: 'Roof' });
    expect(r.title).toBe('Report: Roof');
    expect(r.sections?.map((s) => s.tool)).toEqual(['energy', 'stats', 'faults', 'performance_trend']);
    expect(r.rows).toEqual(expect.arrayContaining([['Best day', 'Sat 1 Aug 2026: 20 kWh'], ['Worst day', 'Sat 1 Aug 2026: 20 kWh']]));
  });
});

/** Readings as given: a day, a clock time on UTC (the systems here keep it), watts, and the day counter. */
async function addReadings(id: string, points: [string, string, number, number | null][]) {
  for (const [iso, hhmm, w, kwh] of points) {
    const ts = dayNumber(iso) * DAY + Number(hhmm.slice(0, 2)) * 3600 + Number(hhmm.slice(3, 5)) * 60;
    await h.env.DB.prepare("INSERT INTO readings (inverter_id, ts, source, ac_power_w, today_kwh, metrics, tz_offset_sec) VALUES (?1, ?2, 'test', ?3, ?4, '{}', 0)")
      .bind(id, ts, w, kwh).run();
  }
}

/** Sun 27 Sep: a cloud at 12:30 takes the power from 4 kW to 1 kW, one reading every quarter of an hour. */
const CLOUDY: [string, number, number][] = [
  ['11:45', 2000, 10], ['12:00', 3000, 10.6], ['12:15', 4000, 11.5], ['12:30', 1000, 12.1], ['12:45', 3500, 12.7],
  ['13:00', 3000, 13.5], ['13:15', 2500, 14.2], ['13:30', 2000, 14.8], ['13:45', 1500, 15.2], ['14:00', 1000, 15.5], ['14:15', 500, 15.7],
];

describe('power_day', () => {
  it('gives what was made between two times, from the day counter, and how steady the power was', async () => {
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5 });
    await addReadings(ROOF, CLOUDY.map(([t, w, k]): [string, string, number, number] => ['2026-09-27', t, w, k]));
    const r = await run('power_day', { date: '2026-09-27', start: '12:00', end: '14:00' });
    expect(r.period).toEqual({ from: '2026-09-27', to: '2026-09-27', label: 'Sun 27 Sep 2026, 12:00–14:00' });
    // 15.5 at 14:00 less 10.6 at 12:00; one fall of a quarter of the peak or more (4 kW to 1 kW);
    // 9 kW of rises and falls against 4 kW for one smooth rise and fall.
    expect(r.rows).toEqual([['Roof', 4.9, 2.39, 4, '12:15', 1, 1, 3, 2.3, '12:00–14:00', 9]]);
    expect(r.facts).toMatchObject({ made_kwh: 4.9, peak_at: '12:15', sharp_drops: 1, biggest_drop_at: '12:30', up_and_down: 2.3 });
    expect(r.summary).toBe('Roof made 4.9 kWh between 12:00 and 14:00, 2.39 kW on average while making power, highest 4 kW at 12:15: '
      + '1 sharp drop (the biggest 3 kW at 12:30), going up and down 2.3 times as much as a smooth stretch.');
    expect(r.sections?.[0]).toMatchObject({ title: 'Hour by hour', columns: ['Hour', 'Roof (kW)'], rows: [['12:00', 2.88], ['13:00', 2.25], ['14:00', 1]] });
    noIds(r);
  });

  it('takes the whole day when no time is named, and says when it was making power', async () => {
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5 });
    await addReadings(ROOF, CLOUDY.map(([t, w, k]): [string, string, number, number] => ['2026-09-27', t, w, k]));
    const r = await run('power_day', { date: 'yesterday' });
    expect(r.facts).toMatchObject({ made_kwh: 15.7, making_from: '11:45', making_to: '14:15', up_and_down: 1.9, readings: 11 });
    expect(r.summary).toContain('making power from 11:45 to 14:15');
  });

  it('says so when a time has no readings, and refuses a time that runs backwards or a day to come', async () => {
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5 });
    await addReadings(ROOF, CLOUDY.map(([t, w, k]): [string, string, number, number] => ['2026-09-27', t, w, k]));
    const r = await run('power_day', { date: '2026-09-27', start: '20:00', end: '22:00' });
    expect(r.summary).toBe('Roof: no readings between 20:00 and 22:00.');
    // At 09:00, ten o'clock has not come yet today.
    expect((await run('power_day', { start: '10:00', end: '12:00' })).summary).toBe('It is not yet 10:00 today where Roof is.');
    await expect(run('power_day', { start: '16:00', end: '14:00' })).rejects.toThrow('comes after its start');
    await expect(run('power_day', { date: '2026-09-29' })).rejects.toThrow('has not happened yet');
    await expect(run('power_day', { start: '2pm' })).rejects.toThrow('right form');
  });

  it('adds systems together, and reads a system with no day counter from its power, from the first reading it has', async () => {
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5 });
    await addSystem(h.env.DB, { id: GARAGE, name: 'Garage', kwp: 4 });
    await addReadings(ROOF, CLOUDY.map(([t, w, k]): [string, string, number, number] => ['2026-09-27', t, w, k]));
    // Garage keeps no day counter, misses one power figure, and its readings begin and end inside the time.
    await addReadings(GARAGE, [['2026-09-27', '12:40', null as unknown as number, null], ['2026-09-27', '12:50', 1000, null], ['2026-09-27', '13:00', 1200, null], ['2026-09-27', '13:30', 800, null]]);
    const r = await run('power_day', { date: '2026-09-27', start: '12:00', end: '14:00' });
    // 12:40-12:50 at 500 W on average and 12:50-13:00 at 1100 W: 267 Wh; 13:00-13:30 is too far apart to count.
    expect(r.facts).toMatchObject({ s1_made_kwh: 4.9, s2_made_kwh: 0.3, total_made_kwh: 5.2, s2_peak_at: '13:00', s2_sharp_drops: 0, s2_biggest_drop_kw: null, s2_up_and_down: 0.8 });
    expect(r.summary.startsWith('Together 5.2 kWh between 12:00 and 14:00 on Sun 27 Sep 2026. Roof made 4.9 kWh')).toBe(true);
    expect(r.summary).toContain('Garage made 0.3 kWh between 12:00 and 14:00, 1 kW on average while making power, highest 1.2 kW at 13:00: steady, with no sharp drops.');
    expect(r.notes).toEqual(expect.arrayContaining(["Garage's readings that day begin at 12:40, so it is counted from then.", "Garage's readings stop at 13:30."]));
    expect(r.sections?.[0].columns).toEqual(['Hour', 'All systems (kW)', 'Roof (kW)', 'Garage (kW)']);
    expect(r.sections?.[0].rows).toEqual([['12:00', 3.38, 2.88, 0.5], ['13:00', 3.25, 2.25, 1], ['14:00', 1, 1, null]]);
  });

  it('says a stretch made no power, and refuses a date that is not one', async () => {
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5 });
    await addReadings(ROOF, [['2026-09-27', '20:00', 0, 30], ['2026-09-27', '20:15', 0, 30]]);
    const r = await run('power_day', { date: '2026-09-27', start: '19:00', end: '21:00' });
    expect(r.summary).toBe('Roof made no power between 19:00 and 21:00.');
    expect(r.facts).toMatchObject({ made_kwh: 0, peak_at: null, making_from: null, average_kw: null });
    await expect(run('power_day', { date: '2026-13-45' })).rejects.toThrow('A date is written YYYY-MM-DD');
  });
});

describe('outages', () => {
  it('finds each stretch of daylight with no readings, the one still going, and the last power', async () => {
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5 });
    const every10 = (iso: string, from: number, to: number, w: number) =>
      Array.from({ length: (to - from) / 10 + 1 }, (_, i) => [iso, `${String(Math.floor((from + i * 10) / 60)).padStart(2, '0')}:${String((from + i * 10) % 60).padStart(2, '0')}`, w, null] as [string, string, number, null]);
    // Sunday: 07:00 to 11:00, nothing until 13:00, then to 19:00 - dark from 17:00. Monday from 06:30 to 08:00, then nothing.
    await addReadings(ROOF, [...every10('2026-09-27', 420, 660, 2000), ...every10('2026-09-27', 780, 1020, 2000), ...every10('2026-09-27', 1030, 1140, 0),
      ...every10('2026-09-28', 390, 480, 500)]);
    const r = await run('outages', {});
    expect(r.period?.label).toBe('the last 7 days (22 – 28 Sep 2026)');
    expect(r.rows).toEqual([
      ['Roof', 'Mon 28 Sep 2026 08:00', 'not yet', '1 h'],
      ['Roof', 'Sun 27 Sep 2026 11:00', 'Sun 27 Sep 2026 13:00', '2 h'],
    ]);
    expect(r.facts).toMatchObject({ reporting_now: 'no', quiet_since: 'Mon 28 Sep 2026 08:00', last_power_at: 'Mon 28 Sep 2026 08:00', last_power_kw: 0.5, outages: 2 });
    // The night between them, 19:00 to 06:30, is not an outage.
    expect(r.summary).toBe('Roof has not reported since Mon 28 Sep 2026 08:00, 1 h ago, in daylight. The vendor may be down, or the logger may have lost its network. '
      + 'It last made power at Mon 28 Sep 2026 08:00 (500 W). In the last 7 days (22 – 28 Sep 2026) it went quiet in daylight 2 times, 3 h of daylight in all; '
      + 'the longest from Sun 27 Sep 2026 11:00 to Sun 27 Sep 2026 13:00.');
    noIds(r);
  });

  it('says a system is reporting, one has never reported, and reads daylight from the sunlight', async () => {
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5 });
    await addSystem(h.env.DB, { id: GARAGE, name: 'Garage', kwp: 4 });
    await addSun(h.env.DB, ROOF, '2026-09-28', 5);
    await addReadings(ROOF, Array.from({ length: 36 }, (_, i): [string, string, number, null] =>
      ['2026-09-28', `${String(6 + Math.floor(i / 12)).padStart(2, '0')}:${String((i % 12) * 5).padStart(2, '0')}`, 1500, null]));
    const r = await run('outages', {});
    expect(r.facts).toMatchObject({ s1_reporting_now: 'yes', s1_outages: 0, s2_reporting_now: 'no', s2_last_reading: null, s2_last_power_at: null });
    expect(r.summary).toBe('Roof is reporting now (last reading 08:55). It last made power at Mon 28 Sep 2026 08:55 (1.5 kW). '
      + 'In the last 7 days (22 – 28 Sep 2026) it never went quiet in daylight. '
      + 'Garage has not reported at all. It made no power in the last 7 days (22 – 28 Sep 2026). In the last 7 days (22 – 28 Sep 2026) it never went quiet in daylight.');
  });

  it('lists the 20 most recent stretches when there are more', async () => {
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5 });
    // Two readings a day, at 07:00 and noon: every afternoon and every morning is a stretch of daylight without one.
    const days = Array.from({ length: 12 }, (_, i) => isoOf(dayNumber('2026-09-16') + i));
    await addReadings(ROOF, days.flatMap((d): [string, string, number, null][] => [[d, '07:00', 2000, null], [d, '12:00', 2000, null]]));
    const r = await run('outages', { from: '2026-09-16', to: '2026-09-27' });
    expect(r.rows).toHaveLength(20);
    expect(r.notes.at(-1)).toMatch(/^The 20 most recent of 2\d are listed\.$/);
    expect(r.rows[0]).toEqual(['Roof', 'Sun 27 Sep 2026 12:00', 'not yet', '5 h']);
  });

  it('calls silence after dark expected for a system with no battery, and points a relay-fed one at the relay by day', async () => {
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5, provider: 'soliscloud' });
    const hours = Array.from({ length: 13 }, (_, i) => ['2026-09-27', `${String(7 + i).padStart(2, '0')}:00`, i < 10 ? 3000 : 0, null] as [string, string, number, null]);
    await addReadings(ROOF, hours.flatMap(([d, t, w]) => [[d, t, w, null], [d, t.replace(':00', ':20'), w, null], [d, t.replace(':00', ':40'), w, null]] as [string, string, number, null][]));
    const night = await runTool(h.env.DB, 'outages', {}, Date.UTC(2026, 8, 27, 22) / 1000);
    if ('error' in night) throw new Error(night.error);
    expect(night.result.summary).toContain('has not reported since Sun 27 Sep 2026 19:40, 2 h 20 min ago: it went quiet after dark, when an inverter without a battery switches off, so this is expected until sunrise.');
    expect(night.result.summary).toContain('It last made power at Sun 27 Sep 2026 16:40 (3 kW).');
    const morning = await runTool(h.env.DB, 'outages', {}, Date.UTC(2026, 8, 28, 10) / 1000);
    if ('error' in morning) throw new Error(morning.error);
    expect(morning.result.summary).toContain('after dark, and it has not come back. No relay has reported: check the relay laptop is on and its SolisCloud login is current (Devices tab).');
    // Days later, the silence is said in days, and its daylight in hours.
    const later = await runTool(h.env.DB, 'outages', {}, Date.UTC(2026, 8, 30, 12) / 1000);
    if ('error' in later) throw new Error(later.error);
    expect(later.result.summary).toContain('has not reported since Sun 27 Sep 2026 19:40, 2 days 16 h ago');
    expect(later.result.facts.daylight_without_readings).toBe('25 h');
    await expect(run('outages', { from: '2026-07-01', to: '2026-09-27' })).rejects.toThrow('a month at most');
  });
});

describe('battery', () => {
  /** Garage keeps a battery: Saturday it ran from 30% to full, Sunday from 60% to 95%, and it reads 81% now. */
  async function charged() {
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5 });
    await addSystem(h.env.DB, { id: GARAGE, name: 'Garage', kwp: 4 });
    const put = (ts: number, soc: number, m: Record<string, number> = {}) => h.env.DB
      .prepare("INSERT INTO readings (inverter_id, ts, source, ac_power_w, today_kwh, battery_soc, metrics, tz_offset_sec) VALUES (?1, ?2, 'test', 500, 1, ?3, ?4, 0)")
      .bind(GARAGE, ts, soc, JSON.stringify(m)).run();
    const at = (iso: string, h: number) => dayNumber(iso) * DAY + h * 3600;
    await put(at('2026-09-26', 7), 30, { battChargeTodayKwh: 0, battDischargeTodayKwh: 0 });
    await put(at('2026-09-26', 15), 100, { battChargeTodayKwh: 4, battDischargeTodayKwh: 3.1 });
    await put(at('2026-09-27', 7), 60, { battChargeTodayKwh: 0, battDischargeTodayKwh: 0 });
    await put(at('2026-09-27', 15), 95, { battChargeTodayKwh: 2.5, battDischargeTodayKwh: 1.2 });
    await put(NOW - 120, 81);
  }

  it("gives the battery's charge now, what it took in and gave out, and its lowest and highest", async () => {
    await charged();
    const r = await run('battery', {});
    expect(r.facts).toMatchObject({ charge_now_pct: 81, charged_kwh: 6.5, discharged_kwh: 4.3, lowest_pct: 30, lowest_day: 'Sat 26 Sep 2026', highest_pct: 100 });
    expect(r.summary).toBe("Garage's battery is at 81% now. Over the last 7 days (22 – 28 Sep 2026), it took in 6.5 kWh and gave out 4.3 kWh, "
      + 'and its charge went from 30% at its lowest, on Sat 26 Sep 2026, to 100% at its highest.');
    expect(r.rows).toContainEqual(['Garage', 'Sun 27 Sep 2026', 2.5, 1.2, 60, 95]);
    noIds(r);
  });

  it('says a single day in its own words, and when a system has no battery', async () => {
    await charged();
    expect((await run('battery', { range: 'yesterday' })).summary).toBe("Garage's battery is at 81% now. "
      + 'Yesterday (Sun 27 Sep 2026), it took in 2.5 kWh and gave out 1.2 kWh, and its charge went from 60% at its lowest to 95% at its highest.');
    expect((await run('battery', { system: 'Roof' })).summary).toBe('Roof reports no battery.');
  });
});

describe('energy: the money, and the share used at home', () => {
  it('says what was used at home over the systems that report their sales, and that no tariff means no money', async () => {
    await months();
    const self = await run('energy', { range: 'last_month', measure: 'self' });
    // Roof made 620 and sold 155 in August: 465 used at home. Garage reports no sales, so it is left out.
    expect(self.facts).toMatchObject({ made_by_systems_reporting_sales_kwh: 620, used_at_home_pct: 75, sold_pct: 25 });
    expect(self.summary).toBe('Of the 620 kWh made last month (1 – 31 Aug 2026) by Roof, which reports what it sold, 75% was used at home and 25% sold to the grid.');
    const unset = await run('energy', { range: 'last_month', measure: 'saved' });
    expect(unset.summary.startsWith('No tariff is set yet, so SolarLens cannot work out the money saved: the owner sets the prices under Settings → Tariff. Your systems made 1085 kWh')).toBe(true);
    await setTariff(h.env.DB, { currency: 'EUR', importPrice: 0.3, exportPrice: 0.1, netMetering: false, co2KgPerKwh: 0.4 });
    const saved = await run('energy', { range: 'last_month', measure: 'saved' });
    expect(saved.summary).toBe(`Your systems saved about ${saved.facts.saved} EUR last month (1 – 31 Aug 2026), and avoided ${saved.facts.co2_avoided_kg} kg of CO2, from 1085 kWh made.`);
  });

  it('calls a day of the most bought or used its highest, not its best, and names the house', async () => {
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5 });
    for (const [iso, used] of [['2026-09-25', 9], ['2026-09-26', 12]] as const) await addDay(h.env.DB, ROOF, iso, 20, { used });
    const r = await run('energy', { from: '2026-09-25', to: '2026-09-26', measure: 'used' });
    expect(r.summary).toBe('The house used 21 kWh 25 – 26 Sep 2026, as Roof measured it. The highest day was Sat 26 Sep 2026 with 12 kWh; the lowest was Fri 25 Sep 2026 with 9 kWh.');
  });
});

describe('outages: why a system went quiet', () => {
  /** Roof, fed by the relay, read until Sunday 10:00 and not since; its datalogger went offline at 09:55. */
  async function quiet(relay: { lastSeen: number; loginUntil: number } | null) {
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5, provider: 'soliscloud' });
    await h.env.DB.prepare("UPDATE inverters SET plant_id = 'plant-a' WHERE id = ?1").bind(ROOF).run();
    await addReadings(ROOF, [['2026-09-27', '09:50', 3000, null], ['2026-09-27', '10:00', 3000, null]]);
    await h.env.DB.prepare("INSERT INTO devices (id, provider, plant_id, kind, status, last_seen, temp_c, updated_at) VALUES ('d-logger', 'soliscloud', 'plant-a', 'datalogger', 'offline', ?1, NULL, ?1)")
      .bind(dayNumber('2026-09-27') * DAY + 9 * 3600 + 55 * 60).run();
    if (relay) {
      await h.env.DB.prepare("INSERT INTO relays (id, provider, name, state, login_expires_at, first_seen, last_seen, last_ok_at) VALUES ('r1', 'soliscloud', NULL, 'ok', ?1, ?2, ?2, ?2)")
        .bind(relay.loginUntil, relay.lastSeen).run();
    }
  }

  it("names the datalogger, and clears the relay when it is still reporting with its login good", async () => {
    await quiet({ lastSeen: NOW - 300, loginUntil: NOW + 3 * DAY });
    const r = await run('outages', {});
    expect(r.summary).toContain('Roof has not reported since Sun 27 Sep 2026 10:00, 23 h ago, in daylight. '
      + "Its datalogger has been offline since Sun 27 Sep 2026 09:55, so the vendor has nothing new to send: check the datalogger's Wi-Fi and power at the site. "
      + 'The relay is running - it last reported at 08:55, and its SolisCloud login is good until Thu 1 Oct 2026 09:00 - so the relay laptop is not the cause.');
    expect(r.facts).toMatchObject({ datalogger: 'offline', datalogger_last_seen: 'Sun 27 Sep 2026 09:55' });
  });

  it("says the relay's login ran out, or that no relay has reported", async () => {
    await quiet({ lastSeen: NOW - 2 * DAY, loginUntil: NOW - DAY });
    expect((await run('outages', {})).summary).toContain("The relay's SolisCloud login ran out on Sun 27 Sep 2026 09:00: renew it with renew-solis-login.cmd on the relay laptop.");
    await h.env.DB.prepare('UPDATE relays SET login_expires_at = ?1').bind(NOW + 3 * DAY).run();
    expect((await run('outages', {})).summary).toContain('No relay has reported since Sat 26 Sep 2026 09:00: check the relay laptop is on - its SolisCloud login is good until Thu 1 Oct 2026 09:00.');
  });

  it("says how long the relay's login is good for while a system reports", async () => {
    await quiet({ lastSeen: NOW - 300, loginUntil: NOW + 3 * DAY });
    await addReadings(ROOF, [['2026-09-28', '08:59', 1200, null]]);
    expect((await run('outages', {})).summary).toContain("Roof is reporting now (last reading 08:59). Its relay's SolisCloud login is good until Thu 1 Oct 2026 09:00.");
  });
});

describe('status_now: the inverter temperature', () => {
  it("gives each inverter's temperature as last read, with its day when that was not today", async () => {
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5 });
    await h.env.DB.prepare("UPDATE inverters SET plant_id = 'plant-a' WHERE id = ?1").bind(ROOF).run();
    await h.env.DB.prepare("INSERT INTO devices (id, provider, plant_id, kind, status, last_seen, temp_c, updated_at) VALUES ('d-inv', 'solarman', 'plant-a', 'inverter', 'online', ?1, 41.24, ?1)")
      .bind(dayNumber('2026-09-27') * DAY + 18 * 3600 + 27 * 60).run();
    const r = await run('status_now', {});
    expect(r.facts).toMatchObject({ inverter_temp_c: 41.2 });
    expect(r.summary).toContain('Inverter temperature, as last read: Roof 41.2 °C (Sun 27 Sep 2026 18:27).');
    expect(r.notes).toContain("An inverter's temperature is kept as last read, not through the day.");
  });
});

describe('stats: days over or under an amount', () => {
  it('counts the whole days above and below it', async () => {
    await months();
    const r = await run('stats', { range: 'last_month', above: 18, below: 16 });
    expect(r.facts).toMatchObject({ s1_days_above_18_kwh: 31, s2_days_above_18_kwh: 0, s1_days_below_16_kwh: 0, s2_days_below_16_kwh: 31 });
    expect(r.summary).toContain('Roof: 31 days, 620 kWh - 20 kWh on an average day (median 20); more than 18 kWh on 31 of its 31 whole days; less than 16 kWh on 0 of its 31 whole days; best');
  });
});

describe('the new answers at their edges', () => {
  it('counts every house when each system reports its sales and its purchases, and says so when none reports sales', async () => {
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5 });
    await addSystem(h.env.DB, { id: GARAGE, name: 'Garage', kwp: 4 });
    for (const id of [ROOF, GARAGE]) await addDay(h.env.DB, id, '2026-09-26', 20, { exported: 5, used: 10 });
    // Purchases ride in the same metrics as the rest of the day's counters.
    await h.env.DB.prepare("UPDATE readings SET metrics = json_set(metrics, '$.gridImportTodayKwh', 4) WHERE ts = (SELECT MAX(ts) FROM readings r2 WHERE r2.inverter_id = readings.inverter_id)").run();
    const both = await run('energy', { from: '2026-09-26', to: '2026-09-26', measure: 'self' });
    expect(both.summary).toBe('Of the 40 kWh made Sat 26 Sep 2026, 75% was used at home and 25% sold to the grid. The sun covered 60% of what the houses used.');
    const garage = await run('energy', { from: '2026-09-25', to: '2026-09-25', measure: 'self', system: 'Garage' });
    expect(garage.summary.startsWith('SolarLens cannot tell how much was used at home Fri 25 Sep 2026: no system here reports what it sold.')).toBe(true);
  });

  it('gives two batteries apart: one silent since its last reading, one that reports only its charge', async () => {
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5 });
    await addSystem(h.env.DB, { id: GARAGE, name: 'Garage', kwp: 4 });
    const put = (id: string, ts: number, soc: number, m = '{}') => h.env.DB
      .prepare("INSERT INTO readings (inverter_id, ts, source, ac_power_w, today_kwh, battery_soc, metrics, tz_offset_sec) VALUES (?1, ?2, 'test', 0, 0, ?3, ?4, 0)")
      .bind(id, ts, soc, m).run();
    await put(ROOF, dayNumber('2026-09-27') * DAY + 20 * 3600, 55, '{"battChargeTodayKwh":3,"battDischargeTodayKwh":2}');
    await put(GARAGE, NOW - 60, 64);
    await put(GARAGE, NOW - 3600, 40);
    const r = await run('battery', {});
    expect(r.facts).toMatchObject({ s1_charge_now_pct: 55, s2_charge_now_pct: 64, s2_lowest_pct: 40, s2_charged_kwh: null });
    expect(r.summary).toContain("Roof's battery was at 55% at its last reading, Sun 27 Sep 2026 20:00.");
    expect(r.summary).toContain("Garage's battery is at 64% now. Over the last 7 days (22 – 28 Sep 2026), its charge went from 40% at its lowest, on Mon 28 Sep 2026, to 64% at its highest.");
    // Long before these readings, there is nothing to say of either battery but its charge now.
    expect((await run('battery', { from: '2026-08-01', to: '2026-08-02' })).summary).toContain("Garage's battery is at 64% now. There is no record of it over 1 – 2 Aug 2026.");
    // Right now names both batteries, the silent one with its day.
    const now = await run('status_now', {});
    expect(now.summary).toContain("Roof's battery was at 55% at its last reading, Sun 27 Sep 2026 20:00. Garage's battery is at 64%.");
  });

  it("names a SolarMan system's offline datalogger, and a relay with no login date on record", async () => {
    await addSystem(h.env.DB, { id: GARAGE, name: 'Garage', kwp: 4 });
    await h.env.DB.prepare("UPDATE inverters SET plant_id = 'plant-b' WHERE id = ?1").bind(GARAGE).run();
    await addReadings(GARAGE, [['2026-09-28', '07:00', 900, null]]);
    await h.env.DB.prepare("INSERT INTO devices (id, provider, plant_id, kind, status, last_seen, updated_at) VALUES ('d-l2', 'solarman', 'plant-b', 'datalogger', 'offline', ?1, ?1)")
      .bind(NOW - 2 * 3600).run();
    const r = await run('outages', { system: 'Garage' });
    expect(r.summary).toContain("Garage has not reported since Mon 28 Sep 2026 07:00, 2 h ago, in daylight. Its datalogger has been offline since Mon 28 Sep 2026 07:00, so the vendor has nothing new to send: check the datalogger's Wi-Fi and power at the site. It last made power");
    expect(r.summary).not.toContain('The vendor may be down');

    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5, provider: 'soliscloud' });
    await addReadings(ROOF, [['2026-09-28', '07:00', 900, null]]);
    await h.env.DB.prepare("INSERT INTO relays (id, provider, name, state, login_expires_at, first_seen, last_seen, last_ok_at) VALUES ('r2', 'soliscloud', NULL, 'ok', NULL, ?1, ?1, ?1)").bind(NOW - 120).run();
    expect((await run('outages', { system: 'Roof' })).summary).toContain('The relay is running - it last reported at 08:58 - so the relay laptop is not the cause.');
  });
});

describe('chart', () => {
  /** One reading at a time of a day, on the clock the systems keep here (UTC). */
  const reading = (id: string, day: string, hhmm: string, w: number, load: number | null, grid: number | null, soc: number | null, batt: number | null) => h.env.DB
    .prepare("INSERT INTO readings (inverter_id, ts, source, ac_power_w, load_power_w, grid_power_w, battery_soc, battery_power_w, tz_offset_sec) VALUES (?1, ?2, 'test', ?3, ?4, ?5, ?6, ?7, 0)")
    .bind(id, dayNumber(day) * DAY + Number(hhmm.slice(0, 2)) * 3600 + Number(hhmm.slice(3)) * 60, w, load, grid, soc, batt).run();

  /** Sunday: both systems every 15 minutes from 10:00 to 11:45, and the garage's house, grid and battery. */
  async function sunday() {
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5 });
    await addSystem(h.env.DB, { id: GARAGE, name: 'Garage', kwp: 4 });
    for (const [hhmm, roof, garage, load, grid, soc, batt] of [
      ['10:00', 2000, 1000, 500, -400, 60, 100], ['10:15', 2400, 1200, 500, -600, 62, 100], ['10:30', 2800, 1400, 700, -500, 64, 200], ['10:45', 3200, 1600, 700, -700, 66, 200],
      ['11:00', 3000, 1500, 1800, 300, 66, -300], ['11:15', 2600, 1300, 1800, 200, 64, -300], ['11:30', 2200, 1100, 600, -300, 63, 20], ['11:45', 1800, 900, 600, -100, 63, -20],
    ] as const) {
      await reading(ROOF, '2026-09-27', hhmm, roof, null, null, null, null);
      await reading(GARAGE, '2026-09-27', hhmm, garage, load, grid, soc, batt);
    }
  }

  it('adds the systems together every hour, and sets a second measure beside the first', async () => {
    await sunday();
    const r = await run('chart', { metric: 'power', versus: 'load', from: '2026-09-27', to: '2026-09-27', every: 'hour' });
    // 10:00-10:59: Roof 2600 on average, Garage 1300: 3.9 kW; the load 600 W. 11:00-11:59: 3.6 kW against 1.2 kW.
    expect(r.columns).toEqual(['Time', 'Power made (kW)', 'House load (kW)']);
    expect(r.rows).toEqual([['10:00', 3.9, 0.6], ['11:00', 3.6, 1.2]]);
    expect(r.chart).toEqual({ kind: 'line', columns: [1, 2] });
    expect(r.facts).toMatchObject({ power_average: 3.75, power_highest: 3.9, power_highest_at: '10:00', load_highest: 1.2, power_above_load_points: 2 });
    expect(r.summary).toBe('The power made on Sun 27 Sep 2026: 3.75 kW on average; highest 3.9 kW at 10:00, lowest 3.6 kW at 11:00. '
      + 'The house load on Sun 27 Sep 2026: 900 W on average; highest 1.2 kW at 11:00, lowest 600 W at 10:00. The power made was above the house load in 2 of 2 points.');
    expect(r.notes).toContain('Roof has no readings of the house load in that time.');
    noIds(r);
  });

  it('says the grid and the battery by their direction, idle battery drift left out', async () => {
    await sunday();
    const grid = await run('chart', { metric: 'grid', from: '2026-09-27', to: '2026-09-27', system: 'Garage' });
    // Every 15 minutes: selling at 10:00-10:45 and 11:30-11:45, buying at 11:00 and 11:15.
    expect(grid.summary).toBe('The grid power on Sun 27 Sep 2026: buying in 2 of 8 points, at most 300 W at 11:00; selling in 6, at most 700 W at 10:45.');
    expect(grid.notes).toContain('Grid power is above zero while buying from the grid, and below zero while selling to it.');
    const battery = await run('chart', { metric: 'battery', from: '2026-09-27', to: '2026-09-27', system: 'Garage' });
    // 20 W either way is drift: neither charging nor discharging.
    expect(battery.facts).toMatchObject({ battery_charging_points: 4, battery_discharging_points: 2 });
  });

  it('draws the average day hour by hour across days, naming the hours each way', async () => {
    await sunday();
    await addSystem(h.env.DB, { id: 'solarman:station:gamma', name: 'Shed', kwp: 2 });
    const r = await run('chart', { metric: 'grid', profile: 'hour_of_day', from: '2026-09-26', to: '2026-09-27', system: 'Garage' });
    expect(r.title).toBe('Grid power, on an average day, Garage');
    expect(r.rows).toEqual([['10:00', -0.55], ['11:00', 0.03]]);
    expect(r.summary).toBe('On an average day over 26 – 27 Sep 2026, you buy from the grid at 11:00 (most at 11:00, 25 W), and sell to it at 10:00 (most at 10:00, 550 W).');
    // With no period, the average day is of the last seven.
    expect((await run('chart', { metric: 'grid', profile: 'hour_of_day', system: 'Garage' })).period?.label).toBe('the last 7 days (22 – 28 Sep 2026)');
    // Over one day, the same asked for is that day hour by hour.
    const one = await run('chart', { metric: 'load', profile: 'hour_of_day', from: '2026-09-27', to: '2026-09-27', system: 'Garage' });
    expect(one.title).toBe('House load, hour by hour, Garage');
    expect(one.summary.startsWith('The house load on Sun 27 Sep 2026: 900 W on average')).toBe(true);
  });

  it("averages a battery's charge rather than adding it, takes the highest when asked, and bars a chart of days", async () => {
    await sunday();
    const soc = await run('chart', { metric: 'soc', stat: 'highest', from: '2026-09-27', to: '2026-09-27', every: 'hour' });
    expect(soc.rows).toEqual([['10:00', 66], ['11:00', 66]]);
    expect(soc.notes).toContain("Each point adds the systems together, but for a battery's charge, which is their average.");
    const days = await run('chart', { metric: 'power', from: '2026-09-21', to: '2026-09-27', system: 'Roof' });
    expect(days.chart).toEqual({ kind: 'line', columns: [1] });
    // A week is hour by hour, each time on its day.
    expect(days.summary).toBe('The power made over 21 – 27 Sep 2026: 2.5 kW on average; highest 2.6 kW on 27 Sep 2026 at 10:00, lowest 2.4 kW on 27 Sep 2026 at 11:00.');
    const weeks = await run('chart', { metric: 'power', from: '2026-07-01', to: '2026-09-27', every: 'day', system: 'Roof' });
    expect(weeks.chart).toEqual({ kind: 'bar', columns: [1] });
    // The day's average: Roof's eight readings, 20 kW over 8.
    expect(weeks.rows).toEqual([['Sun 27 Sep 2026', 2.5]]);
    expect(weeks.title).toBe('Power made, day by day, Roof');
  });

  it('steps by the week, Monday to Sunday, takes the lowest, and says a way a measure never went', async () => {
    await sunday();
    const weeks = await run('chart', { metric: 'power', every: 'week', stat: 'lowest', from: '2026-09-21', to: '2026-09-27', system: 'Roof' });
    expect(weeks.title).toBe('Lowest power made, week by week, Roof');
    expect(weeks.rows).toEqual([['week of 21 Sep 2026', 1.8]]);
    expect(weeks.summary).toBe('The lowest power made each week over 21 – 27 Sep 2026: 1.8 kW on average; highest 1.8 kW in the week of 21 Sep 2026, lowest 1.8 kW in the week of 21 Sep 2026.');
    expect(weeks.notes).toContain('Times are on the clock where the panels are. Each point is the lowest reading in it.');
    // With no period named, a week at a time covers the last twelve weeks, and a day at a time the last 30 days.
    expect((await run('chart', { metric: 'power', every: 'week', system: 'Roof' })).period?.label).toBe('7 Jul – 28 Sep 2026');
    const daily = await run('chart', { metric: 'power', every: 'day', stat: 'highest', system: 'Roof' });
    expect(daily.period?.label).toBe('the last 30 days (30 Aug – 28 Sep 2026)');
    expect(daily.summary).toBe('The highest power made each day over the last 30 days (30 Aug – 28 Sep 2026): 3.2 kW on average; highest 3.2 kW on Sun 27 Sep 2026, lowest 3.2 kW on Sun 27 Sep 2026.');
    // Power made at night is nothing, and its lowest says only that: left out.
    await reading(ROOF, '2026-09-27', '05:00', 0, null, null, null, null);
    expect((await run('chart', { metric: 'power', every: 'hour', from: '2026-09-27', to: '2026-09-27', system: 'Roof' })).summary)
      .toBe('The power made on Sun 27 Sep 2026: 1.67 kW on average; highest 2.6 kW at 10:00.');
    // Saturday: the garage selling all morning, never buying.
    for (const [hhmm, grid] of [['10:00', -400], ['10:30', -600], ['11:00', -600], ['11:30', -200]] as const) {
      await reading(GARAGE, '2026-09-26', hhmm, 1000, 300, grid, null, null);
    }
    expect((await run('chart', { metric: 'grid', every: 'hour', from: '2026-09-26', to: '2026-09-26', system: 'Garage' })).summary)
      .toBe('The grid power on Sat 26 Sep 2026: buying in 0 of 2 points; selling in 2, at most 500 W at 10:00.');
    // On the average day, the hours one after another are one span.
    expect((await run('chart', { metric: 'grid', profile: 'hour_of_day', from: '2026-09-25', to: '2026-09-26', system: 'Garage' })).summary)
      .toBe('On an average day over 25 – 26 Sep 2026, you buy from the grid at no hour, and sell to it at 10:00–12:00 (most at 10:00, 500 W).');
    expect((await run('chart', { metric: 'battery', profile: 'hour_of_day', from: '2026-09-26', to: '2026-09-27', system: 'Garage' })).summary)
      .toBe('On an average day over 26 – 27 Sep 2026, the battery charges at 10:00 (most at 10:00, 150 W), and discharges at 11:00 (most at 11:00, 150 W).');
    // A measure that runs one way only: its highest and lowest hours.
    expect((await run('chart', { metric: 'load', profile: 'hour_of_day', from: '2026-09-26', to: '2026-09-27', system: 'Garage' })).summary)
      .toBe('On an average day over 26 – 27 Sep 2026, the house load is highest at 11:00 (900 W) and lowest at 10:00 (500 W), 700 W on average.');
  });

  it('leaves out a total a system would leave short, and says so, while a system with no readings at all adds nothing', async () => {
    await sunday();
    // Roof reads the grid once, at 10:05, and at 11:00 has readings without it - as SolisCloud's history rows are.
    await reading(ROOF, '2026-09-27', '10:05', 2100, null, -1000, null, null);
    // Before dawn only the garage reads anything: Roof is asleep, and adds nothing.
    await reading(GARAGE, '2026-09-27', '05:00', 0, 300, 300, 55, null);
    const r = await run('chart', { metric: 'grid', every: 'hour', from: '2026-09-27', to: '2026-09-27' });
    expect(r.rows).toEqual([['05:00', 0.3], ['10:00', -1.55], ['11:00', null]]);
    expect(r.summary).toBe('The grid power on Sun 27 Sep 2026: buying in 1 of 2 points, at most 300 W at 05:00; selling in 1, at most 1.55 kW at 10:00.');
    expect(r.notes).toContain('Roof has readings but none of the grid power at 11:00: the total there is left out, rather than shown short.');
    expect(r.facts.grid_points_left_out).toBe(1);
  });

  it('names every system without a measure, charts a measure asked beside itself once, and a second with no points beside none', async () => {
    await sunday();
    await addSystem(h.env.DB, { id: 'solarman:station:gamma', name: 'Shed', kwp: 2 });
    const load = await run('chart', { metric: 'load', versus: 'load', from: '2026-09-27', to: '2026-09-27' });
    expect(load.columns).toEqual(['Time', 'House load (kW)']);
    expect(load.notes).toContain('Roof and Shed have no readings of the house load in that time.');
    const roof = await run('chart', { metric: 'power', versus: 'soc', from: '2026-09-27', to: '2026-09-27', system: 'Roof' });
    expect(roof.rows[0]).toEqual(['10:00', 2, null]);
    expect(roof.summary).not.toContain('was above');
    const quarter = await run('chart', { metric: 'battery', every: '15min', from: '2026-09-27', to: '2026-09-27', system: 'Roof' });
    expect(quarter.title).toBe('Battery power, every 15 minutes, Roof');
    expect(quarter.summary).toBe('There are no readings of the battery power on Sun 27 Sep 2026.');
  });

  it('refuses more than three months, or more points than a chart can show, and says when there is nothing', async () => {
    await sunday();
    await expect(run('chart', { from: '2026-05-01', to: '2026-09-27' })).rejects.toThrow('three months at most');
    await expect(run('chart', { from: '2026-08-01', to: '2026-09-27', every: '15min' })).rejects.toThrow('too many points');
    expect((await run('chart', { metric: 'soc', from: '2026-09-20', to: '2026-09-20' })).summary).toBe('There are no readings of the battery charge on Sun 20 Sep 2026.');
  });
});

describe('inverter', () => {
  /** Roof's inverter, read five minutes ago: two strings (the second far weaker), three phases, and no battery; Garage's with a battery, read long ago. */
  async function devices(stringTwo = 400) {
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5 });
    await addSystem(h.env.DB, { id: GARAGE, name: 'Garage', kwp: 4 });
    await h.env.DB.prepare("UPDATE inverters SET plant_id = 'plant-' || name").run();
    const put = (id: string, provider: string, plant: string, seen: number, strings: unknown, phases: unknown, battery: unknown, extra: Record<string, number | null>) => h.env.DB
      .prepare(`INSERT INTO devices (id, provider, plant_id, kind, status, last_seen, strings, ac_phases, battery, frequency_hz, power_factor, temp_c, dc_bus_v, updated_at)
                VALUES (?1, ?2, ?3, 'inverter', 'online', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?4)`)
      .bind(id, provider, plant, seen, JSON.stringify(strings), JSON.stringify(phases), battery ? JSON.stringify(battery) : null,
        extra.frequency_hz, extra.power_factor, extra.temp_c, extra.dc_bus_v).run();
    await put('dev-roof', 'solarman', 'plant-Roof', NOW - 300,
      [{ index: 1, voltageV: 380.2, currentA: 5.1, powerW: 1940 }, { index: 2, voltageV: 370.4, currentA: 1.1, powerW: stringTwo }],
      [{ index: 1, voltageV: 231, currentA: 3.1 }, { index: 2, voltageV: 233, currentA: 3 }, { index: 3, voltageV: 232, currentA: 3.2 }],
      null, { frequency_hz: 50.02, power_factor: 0.99, temp_c: 44.5, dc_bus_v: 612 });
    await put('dev-garage', 'solarman', 'plant-Garage', NOW - 3 * DAY, [{ index: 1, voltageV: 0.5, currentA: 0, powerW: 0 }], [{ index: 1, voltageV: 233, currentA: 0.2 }],
      { voltageV: 27.21, currentA: -0.82, tempC: 30.2, status: 'Static', bmsSocPct: 100, chemistry: 'lithium' }, { frequency_hz: 49.93, power_factor: 0, temp_c: 46.9, dc_bus_v: null });
  }

  it("gives every reading the inverter shows, names a weak string, and keeps a stale record's time", async () => {
    await devices();
    const r = await run('inverter', {});
    expect(r.rows).toContainEqual(['Roof', 'PV2', 370.4, 1.1, 400]);
    expect(r.rows).toContainEqual(['Roof', 'Phase L3', 232, 3.2, null]);
    expect(r.summary).toContain("Roof's inverter, now: PV1 380.2 V, 5.1 A, 1940 W; PV2 370.4 V, 1.1 A, 400 W; the grid L1 231 V, L2 233 V, L3 232 V at 50.02 Hz, power factor 0.99; "
      + 'the inverter at 44.5 °C; the DC bus at 612 V. PV2 is making far less than PV1 (400 W against 1940 W): shade, dirt, or a fault on that string.');
    expect(r.summary).toContain("Garage's inverter, as last read, Fri 25 Sep 2026 09:00: PV1 0.5 V, 0 A, 0 W; the grid 233 V at 49.93 Hz; the inverter at 46.9 °C. "
      + 'Its battery: 27.2 V, -0.82 A (discharging), 30.2 °C; the BMS says 100%.');
    expect(r.facts).toMatchObject({ s1_weak_strings: 'PV2', s1_frequency_hz: 50.02, s2_bms_soc_pct: 100 });
    expect(r.sections?.[0].rows).toContainEqual(['Garage', 'Chemistry', 'lithium']);
    noIds(r);
  });

  it('answers only the part asked about, and says whether the strings are even', async () => {
    await devices(1900);
    expect((await run('inverter', { part: 'temperature', system: 'Roof' })).summary).toBe("Roof's inverter, now: the inverter at 44.5 °C.");
    expect((await run('inverter', { part: 'strings', system: 'Roof' })).summary).toContain('The strings are even: none is making far less than the others.');
    expect((await run('inverter', { part: 'battery' })).summary).toBe("Roof reports no battery readings of its own. Garage's battery, as last read, Fri 25 Sep 2026 09:00: "
      + '27.2 V, -0.82 A (discharging), 30.2 °C; the BMS says 100%.');
    expect((await run('inverter', { part: 'grid', system: 'Garage' })).summary).toBe("Garage's inverter, as last read, Fri 25 Sep 2026 09:00: the grid 233 V at 49.93 Hz.");
  });

  it('reads a record with parts missing, a single phase, a battery charging, and more than one weak string', async () => {
    await devices();
    await h.env.DB.prepare("UPDATE devices SET strings = ?1 WHERE id = 'dev-roof'").bind(JSON.stringify([
      { index: 1, voltageV: 380, currentA: 5, powerW: 1900 }, { index: 2, voltageV: 300, currentA: 1, powerW: 300 }, { index: 3, voltageV: 310, powerW: 250 }])).run();
    await h.env.DB.prepare("UPDATE devices SET strings = NULL, ac_phases = ?1, battery = ?2, frequency_hz = NULL, temp_c = NULL, last_seen = NULL WHERE id = 'dev-garage'")
      .bind(JSON.stringify([{ index: 1, voltageV: 229.6 }]), JSON.stringify({ voltageV: 53.1, currentA: 12.5 })).run();
    const r = await run('inverter', {});
    expect(r.summary).toContain('PV2 and PV3 are making far less than PV1 (300 W, 250 W against 1900 W): shade, dirt, or a fault on those strings.');
    expect(r.summary).toContain("Garage's inverter, as last read: the grid 229.6 V. Its battery: 53.1 V, 12.5 A (charging).");
    expect(r.rows).toContainEqual(['Roof', 'PV3', 310, null, 250]);
    expect(r.rows).toContainEqual(['Garage', 'Grid (AC)', 229.6, null, null]);
    expect(r.facts).toMatchObject({ s1_weak_strings: 'PV2, PV3', s2_strings: 0, s2_frequency_hz: null, s2_read_at: null, s2_battery_voltage_v: 53.1, s2_bms_soc_pct: null });
    expect((await run('inverter', { part: 'temperature', system: 'Garage' })).summary).toBe("Garage's inverter, as last read: no temperature readings.");
  });

  it('says when the strings cannot be compared: old readings, or none producing', async () => {
    await devices();
    await h.env.DB.prepare("UPDATE devices SET strings = ?1 WHERE id = 'dev-garage'")
      .bind(JSON.stringify([{ index: 1, voltageV: 300, currentA: 2, powerW: 600 }, { index: 2, voltageV: 300, currentA: 0.2, powerW: 60 }])).run();
    expect((await run('inverter', { part: 'strings', system: 'Garage' })).summary).toBe("Garage's inverter, as last read, Fri 25 Sep 2026 09:00: "
      + 'PV1 300 V, 2 A, 600 W; PV2 300 V, 0.2 A, 60 W. Those are old readings, so they say nothing of the strings now.');
    await h.env.DB.prepare("UPDATE devices SET strings = ?1 WHERE id = 'dev-roof'")
      .bind(JSON.stringify([{ index: 1, voltageV: 12, currentA: 0, powerW: 0 }, { index: 2, voltageV: 11, currentA: 0, powerW: 0 }])).run();
    expect((await run('inverter', { part: 'strings', system: 'Roof' })).summary).toBe("Roof's inverter, now: PV1 12 V, 0 A, 0 W; PV2 11 V, 0 A, 0 W. "
      + 'No string is producing at the moment, so they cannot be compared.');
  });

  it('says so when a system has no inverter record', async () => {
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5 });
    expect((await run('inverter', {})).summary).toBe('Roof has no inverter record: its vendor has not sent one.');
  });
});

describe('analysis', () => {
  const SHED = 'solarman:station:gamma';
  /** A reading just now, so a system counts as reporting. */
  const fresh = (id: string) => h.env.DB.prepare("INSERT INTO readings (inverter_id, ts, source, ac_power_w, today_kwh, metrics, tz_offset_sec) VALUES (?1, ?2, 'test', 800, 0.4, '{}', 0)")
    .bind(id, NOW - 120).run();
  const said = (r: ToolResult, area: string) => r.rows.filter((x) => x[1] === area).map((x) => x[2]);
  const week = async (id: string, o: Parameters<typeof addHybridDay>[3] = {}) => {
    for (let n = dayNumber('2026-09-21'); n <= dayNumber('2026-09-27'); n++) await addHybridDay(h.env.DB, id, isoOf(n), o);
  };

  it('finds a battery kept full while the house buys at night, power sold that could be used, and an always-on load', async () => {
    await addSystem(h.env.DB, { id: GARAGE, name: 'Garage', kwp: 4 });
    await week(GARAGE);
    await fresh(GARAGE);
    const r = await run('analysis', { range: 'last_week' });
    expect(r.title).toBe('Analysis: Garage');
    expect(r.columns).toEqual(['How it stands', 'Area', 'What stands out', 'What to do']);
    // What needs a look comes first, then what is worth knowing, then what is fine.
    expect(r.rows.map((x) => [x[0], x[1]])).toEqual([
      ['Needs a look', 'The battery'], ['Worth knowing', 'Using your own power'], ['Worth knowing', 'The house'],
      ['Fine', 'Production'], ['Fine', 'The lowest day'], ['Fine', 'Faults'],
    ]);
    expect(said(r, 'The battery')[0]).toMatch(/^Garage's battery was full on 7 of 7 days and on a typical day went no lower than 97%; it gave out 0 kWh in all, while the house bought [\d.]+ kWh from the grid, mostly at 00:00–06:00, 18:00–24:00: it is kept full rather than used at night\.$/);
    expect(r.rows[0][3]).toMatch(/^Check the inverter's battery setting\. In a self-use \(solar first\) mode/);
    expect(said(r, 'Using your own power')[0]).toMatch(/^Garage used \d+% of what it made at home and sold \d+% \([\d.]+ kWh\); the sun covered \d+% of what the house used, and [\d.]+ kWh was bought, most of it at 00:00–06:00, 18:00–24:00, when the sun is down\.$/);
    expect(r.rows[1][3]).toBe('Run what can wait - washing, water heating, pumping, charging - at 07:00–18:00, when the panels make more than the house uses and the rest is sold.');
    expect(said(r, 'The house')).toEqual(["Garage's house never draws less than about 300 W on an average day - 7.2 kWh a day, 75% of what it uses - and draws most at 18:00 (900 W), when the sun is down."]);
    expect(said(r, 'The lowest day')[0]).toMatch(/^No day was far below the rest: the lowest, Mon 21 Sep 2026, made 100% of the median day/);
    expect(r.facts).toMatchObject({ needs_a_look: 1, worth_knowing: 2, battery_typical_low_pct: 97, battery_full_days: 7, always_on_w: 300, always_on_share_pct: 75, peak_load_at: '18:00' });
    // The summary lists what stands out, then what to do; the evidence is the day hour by hour, each day, and the battery.
    expect(r.summary.split('\n')[0]).toBe('Garage last week (21 – 27 Sep 2026): 1 thing to look at, 2 worth knowing.');
    expect(r.summary).toContain("\nWhat to do:\n- Check the inverter's battery setting.");
    expect(r.sections?.map((s) => s.title)).toEqual(['Made and used, on an average day, Garage', 'Grid and battery, on an average day, Garage', 'Energy day by day', 'The battery, day by day']);
    expect(r.sections?.[0].chart).toEqual({ kind: 'line', columns: [1, 2] });
    expect(r.sections?.[0].rows[12]).toEqual(['12:00', 2.98, 0.3]);
    noIds(r);
  });

  it('says a battery that runs the house at night is used, and one that runs low is worth knowing', async () => {
    await addSystem(h.env.DB, { id: GARAGE, name: 'Garage', kwp: 4 });
    await week(GARAGE, { cycle: 15 });
    await fresh(GARAGE);
    const r = await run('analysis', { range: 'last_week' });
    expect(said(r, 'The battery')[0]).toMatch(/^Garage's battery ran down to 20% or less on 7 of 7 days, as low as 15% and gave out [\d.]+ kWh\.$/);
    expect(r.rows.find((x) => x[1] === 'The battery')?.[0]).toBe('Worth knowing');
  });

  it('compares the systems per kWp, blames the sun for a day every system was low, and says what else needs a look', async () => {
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5 });
    await addSystem(h.env.DB, { id: SHED, name: 'Shed', kwp: 4 });
    for (let n = dayNumber('2026-09-21'); n <= dayNumber('2026-09-27'); n++) {
      const dull = isoOf(n) === '2026-09-23';
      await addDay(h.env.DB, ROOF, isoOf(n), dull ? 6 : 20);
      await addDay(h.env.DB, SHED, isoOf(n), dull ? 3 : 10);
      await addSun(h.env.DB, ROOF, isoOf(n), dull ? 1.5 : 5);
      await addSun(h.env.DB, SHED, isoOf(n), dull ? 1.5 : 5);
    }
    await fresh(ROOF);
    await h.env.DB.prepare("UPDATE inverters SET plant_id = 'plant-' || name").run();
    const device = (id: string, plant: string, kind: string, status: string, seen: number, strings: unknown) => h.env.DB
      .prepare("INSERT INTO devices (id, provider, plant_id, kind, status, last_seen, strings, updated_at) VALUES (?1, 'solarman', ?2, ?3, ?4, ?5, ?6, ?5)")
      .bind(id, plant, kind, status, seen, strings ? JSON.stringify(strings) : null).run();
    await device('dev-roof', 'plant-Roof', 'inverter', 'online', NOW - 300, [{ index: 1, voltageV: 380, currentA: 5, powerW: 1900 }, { index: 2, voltageV: 360, currentA: 0.8, powerW: 300 }]);
    await device('log-shed', 'plant-Shed', 'datalogger', 'offline', dayNumber('2026-09-27') * DAY + 16 * 3600, null);
    await addFault(h.env.DB, SHED, 'f-shed', dayNumber('2026-09-25') * DAY + 10 * 3600, null, 'Grid overvoltage');
    await setTariff(h.env.DB, { currency: 'EUR', importPrice: 0.3, exportPrice: 0.1, netMetering: false, co2KgPerKwh: 0.4 });
    const r = await run('analysis', { range: 'last_week' });
    expect(r.title).toBe('Analysis');
    expect(r.rows.map((x) => [x[0], x[1]])).toEqual([
      ['Needs a look', 'Reporting'], ['Needs a look', 'Systems compared'], ['Needs a look', 'Strings'], ['Needs a look', 'Faults'],
      ['Worth knowing', 'The lowest day'], ['Fine', 'Production'], ['Fine', 'Production'], ['Fine', 'Money'],
    ]);
    expect(said(r, 'Reporting')).toEqual(['Shed has not reported since Sun 27 Sep 2026 19:39, 13 h ago: its datalogger has been offline since Sun 27 Sep 2026 16:00.']);
    expect(said(r, 'Systems compared')).toEqual(['Per kWp of panels, Shed made 38% less than Roof on an average whole day (2.25 against 3.6 kWh per kWp).']);
    expect(said(r, 'Strings')).toEqual(['On Roof, PV2 is making far less than PV1 (300 W against 1900 W), as last read at 08:55.']);
    expect(said(r, 'Faults')).toEqual(['1 fault is still active: Grid overvoltage on Shed.']);
    expect(said(r, 'The lowest day')).toEqual(['The lowest day was Wed 23 Sep 2026, with 9 kWh against a median day of 30 kWh - Roof 6 kWh (30% of its median day) and Shed 3 kWh (30% of its median day): '
      + 'less sun at Roof, 1.5 kWh/m² against a usual 5; less sun at Shed, 1.5 kWh/m² against a usual 5.']);
    expect(said(r, 'Money')).toEqual(['By your tariff, the power made saved about 56.7 EUR and avoided 75.6 kg of CO2.']);
    expect(r.rows.map((x) => x[3]).filter(Boolean)).toEqual([
      "Check Shed's datalogger at the site - its Wi-Fi and its power.",
      'If the two face the same way under the same sky, look for shade, dirt or a string down on Shed; a different tilt or direction explains some of it.',
      'Look at PV2 on Roof: shade, dirt, or a loose or failed connection.',
      "See what each one means, and the vendor's advice, on the Alerts tab.",
    ]);
    expect(r.summary.split('\n')[0]).toBe('Your systems last week (21 – 27 Sep 2026): 4 things to look at, 1 worth knowing.');
    expect(r.sections?.map((s) => s.title)).toEqual(['Energy day by day', 'Systems per kWp, on an average whole day', 'Output for the sunlight, week by week', 'Faults']);
    noIds(r);
  });

  it('puts a day one system alone was low down to that system', async () => {
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5 });
    await addSystem(h.env.DB, { id: SHED, name: 'Shed', kwp: 4 });
    for (let n = dayNumber('2026-09-21'); n <= dayNumber('2026-09-27'); n++) {
      await addDay(h.env.DB, ROOF, isoOf(n), isoOf(n) === '2026-09-23' ? 6 : 20);
      await addDay(h.env.DB, SHED, isoOf(n), 16);
    }
    await fresh(ROOF);
    await fresh(SHED);
    const r = await run('analysis', { range: 'last_week' });
    const low = r.rows.find((x) => x[1] === 'The lowest day')!;
    expect(low.slice(0, 3)).toEqual(['Needs a look', 'The lowest day', 'The lowest day was Wed 23 Sep 2026, with 22 kWh against a median day of 36 kWh - Roof 6 kWh (30% of its median day) and Shed 16 kWh (100% of its median day): '
      + 'only Roof was low, so the cause was its own - a fault, shade, or a gap in its record.']);
    expect(low[3]).toBe('Ask "why was 23 Sep 2026 low?" for the whole of that day at Roof.');
  });

  it('tells a system slowly making less for its sunlight from one that only had less sun', async () => {
    // Twelve weeks: Roof makes 20 kWh a day in 5 kWh/m² of sun for eight weeks, then 16; Garage makes 16 throughout.
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5 });
    await addSystem(h.env.DB, { id: GARAGE, name: 'Garage', kwp: 4 });
    const monday = dayNumber('2026-09-28');
    for (let n = monday - 84; n < monday; n++) {
      await addDay(h.env.DB, ROOF, isoOf(n), n >= monday - 28 ? 16 : 20);
      await addDay(h.env.DB, GARAGE, isoOf(n), 16);
      await addSun(h.env.DB, ROOF, isoOf(n), 5);
      await addSun(h.env.DB, GARAGE, isoOf(n), 5);
    }
    await fresh(ROOF);
    await fresh(GARAGE);
    const r = await run('analysis', {});
    expect(r.period?.label).toBe('the last 30 days (30 Aug – 28 Sep 2026), to yesterday');
    expect(said(r, 'Production')).toEqual([
      'Roof made 468 kWh over 29 whole days, 16.1 kWh on an average day - 19% less a day than in the 29 days before, and for its sunlight it is making 20% less over the last 4 weeks than in the 8 before: the system itself, not only the weather.',
      'Garage made 464 kWh over 29 whole days, 16 kWh on an average day; for its sunlight it is steady.',
    ]);
    expect(r.rows[0].slice(0, 2)).toEqual(['Needs a look', 'Production']);
    expect(r.rows[0][3]).toBe("Look at Roof's panels for dirt or new shade, and at its strings for one down: cleaning often brings the output back.");
    expect(r.facts).toMatchObject({ s1_health: 'declining', s1_health_change_pct: -20, s1_against_before_pct: -19, s2_health: 'steady' });
    expect(r.notes[0]).toContain('today is left out, as it is not over yet');
  });

  it('says what power sold is worth used at home, for a house with no battery whose load peaks by day, in a sunnier week than the one before', async () => {
    await addSystem(h.env.DB, { id: GARAGE, name: 'Garage', kwp: 4 });
    for (let n = dayNumber('2026-09-14'); n <= dayNumber('2026-09-20'); n++) await addHybridDay(h.env.DB, GARAGE, isoOf(n), { battery: false, peakW: 2000, baseW: 100, middayW: 1200 });
    await week(GARAGE, { battery: false, baseW: 100, middayW: 1200 });
    await fresh(GARAGE);
    await setTariff(h.env.DB, { currency: 'EUR', importPrice: 0.3, exportPrice: 0.1, netMetering: false, co2KgPerKwh: 0.4 });
    const r = await run('analysis', { range: 'last_week' });
    expect(said(r, 'Production')[0]).toMatch(/^Garage made [\d.]+ kWh over 7 whole days, [\d.]+ kWh on an average day - 50% more a day than in the 7 days before\.$/);
    expect(said(r, 'The house')).toEqual(["Garage's house never draws less than about 100 W on an average day - 2.4 kWh a day, 24% of what it uses - and draws most at 10:00 (1.2 kW)."]);
    expect(r.rows.find((x) => x[1] === 'The house')?.[3]).toBeNull();
    expect(r.rows.find((x) => x[1] === 'Using your own power')?.[3]).toBe('Run what can wait - washing, water heating, pumping, charging - at 06:00–18:00, when the panels make more than the house uses and the rest is sold. '
      + 'By your tariff, each kWh used then rather than bought later is worth 0.2 EUR.');
    // No battery: the grid alone on its chart, and no battery day by day.
    const grid = r.sections!.find((s) => s.title.startsWith('Grid and battery'))!;
    expect(grid.columns).toEqual(['Hour', 'Grid power (kW)']);
    expect(grid.chart).toEqual({ kind: 'line', columns: [1] });
    expect(r.sections!.some((s) => s.title === 'The battery, day by day')).toBe(false);
    // One day: its pattern is that day's own.
    expect((await run('analysis', { range: 'yesterday' })).notes[0]).toContain('The average day, hour by hour, is from every reading of Sun 27 Sep 2026.');
  });

  it("finds a day a system made far less than its sunlight gives, and a fault that keeps coming back", async () => {
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5 });
    for (let n = dayNumber('2026-09-21'); n <= dayNumber('2026-09-27'); n++) {
      const iso = isoOf(n);
      await addDay(h.env.DB, ROOF, iso, iso === '2026-09-23' ? 6 : iso === '2026-09-22' ? 8 : 20);
      await addSun(h.env.DB, ROOF, iso, 5);
    }
    await fresh(ROOF);
    for (const [key, day] of [['f1', '2026-09-22'], ['f2', '2026-09-23'], ['f3', '2026-09-25']]) {
      await addFault(h.env.DB, ROOF, key, dayNumber(day) * DAY + 11 * 3600, dayNumber(day) * DAY + 12 * 3600, 'DC voltage low');
    }
    const r = await run('analysis', { range: 'last_week' });
    expect(said(r, 'The lowest day')).toEqual(['The lowest day was Wed 23 Sep 2026, with 6 kWh against a median day of 20 kWh: Roof made 30% of what its sunlight usually gives; a fault: DC voltage low.']);
    expect(r.rows.find((x) => x[1] === 'The lowest day')?.slice(0, 1)).toEqual(['Needs a look']);
    expect(said(r, 'Faults')).toEqual(['3 faults were recorded and none is still active; the most common was DC voltage low, 3 times.']);
    expect(r.rows.find((x) => x[1] === 'Faults')?.[3]).toBe('A fault that keeps coming back is worth raising with the installer.');
    expect(said(r, 'Production')[0]).toBe('Roof made 114 kWh over 7 whole days, 16.3 kWh on an average day. 2 days were under half its median day of 20 kWh.');
  });

  it('says what the SolisCloud relay tells of a system gone quiet, and nothing of one asleep after dark', async () => {
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5, provider: 'soliscloud' });
    for (let n = dayNumber('2026-09-21'); n <= dayNumber('2026-09-27'); n++) await addDay(h.env.DB, ROOF, isoOf(n), 20);
    const quiet = async () => said(await run('analysis', { range: 'last_week' }), 'Reporting')[0];
    const relay = (lastSeen: number, loginUntil: number | null) => h.env.DB
      .prepare("INSERT OR REPLACE INTO relays (id, provider, name, state, login_expires_at, first_seen, last_seen, last_ok_at) VALUES ('r1', 'soliscloud', NULL, 'ok', ?1, ?2, ?2, ?2)")
      .bind(loginUntil, lastSeen).run();
    expect(await quiet()).toBe('Roof has not reported since Sun 27 Sep 2026 19:39, 13 h ago: no relay has reported.');
    await relay(NOW - 300, NOW + 3 * DAY);
    expect(await quiet()).toBe('Roof has not reported since Sun 27 Sep 2026 19:39, 13 h ago: the relay is running, so SolisCloud has nothing new to send.');
    await relay(NOW - 2 * DAY, NOW - DAY);
    expect(await quiet()).toBe("Roof has not reported since Sun 27 Sep 2026 19:39, 13 h ago: the relay's SolisCloud login ran out on Sun 27 Sep 2026 09:00.");
    await relay(NOW - 2 * DAY, NOW + 3 * DAY);
    const r = await run('analysis', { range: 'last_week' });
    expect(said(r, 'Reporting')[0]).toBe('Roof has not reported since Sun 27 Sep 2026 19:39, 13 h ago: no relay has reported since Sat 26 Sep 2026 09:00.');
    expect(r.rows.find((x) => x[1] === 'Reporting')?.[3]).toBe('Check the relay laptop is on, and its SolisCloud login is current (Devices tab).');
    // At 21:00 the same silence is an inverter asleep since dusk: nothing to say.
    const night = await runTool(h.env.DB, 'analysis', { range: 'last_week' }, NOW + 12 * 3600);
    expect('result' in night && night.result.rows.some((x) => x[1] === 'Reporting')).toBe(false);
  });

  it('tells a fall the weather explains from one the system does, and says a system doing better for its sunlight', async () => {
    // Twelve weeks: Roof makes 20 kWh in 5 kWh/m² of sun, then 16 in 4 - the same for its sunlight. Garage makes 16, then 20 in the same sun.
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5 });
    await addSystem(h.env.DB, { id: GARAGE, name: 'Garage', kwp: 4 });
    const monday = dayNumber('2026-09-28');
    for (let n = monday - 84; n < monday; n++) {
      const late = n >= monday - 28;
      await addDay(h.env.DB, ROOF, isoOf(n), late ? 16 : 20);
      await addDay(h.env.DB, GARAGE, isoOf(n), late ? 20 : 16);
      await addSun(h.env.DB, ROOF, isoOf(n), late ? 4 : 5);
      await addSun(h.env.DB, GARAGE, isoOf(n), 5);
    }
    await fresh(ROOF);
    await fresh(GARAGE);
    const r = await run('analysis', {});
    expect(said(r, 'Production')).toEqual([
      'Roof made 468 kWh over 29 whole days, 16.1 kWh on an average day - 19% less a day than in the 29 days before; for its sunlight it is steady, so the weather or the season made the difference, not the system.',
      'Garage made 576 kWh over 29 whole days, 19.9 kWh on an average day - 24% more a day than in the 29 days before; for its sunlight it is making 25% more over the last 4 weeks than in the 8 before.',
    ]);
    expect(r.rows.find((x) => x[2] === said(r, 'Production')[0])?.[0]).toBe('Worth knowing');
  });

  it('needs a whole day, a year at most, and says so when a system was not wholly recorded', async () => {
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5 });
    await expect(run('analysis', { range: 'today' })).rejects.toThrow('at least one whole day');
    await expect(run('analysis', { from: '2025-01-01', to: '2026-06-30' })).rejects.toThrow('a year at most');
    for (const d of ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27']) await addDay(h.env.DB, ROOF, d, 20);
    // The 23rd recorded only from 15:05, a reading every two and a half minutes, as a relay started late leaves it:
    // readings enough to pass for a whole day, and a day short of most of its sun.
    for (let i = 0; i < 91; i++) {
      await h.env.DB.prepare("INSERT INTO readings (inverter_id, ts, source, ac_power_w, today_kwh, metrics, tz_offset_sec) VALUES (?1, ?2, 'test', 500, ?3, '{}', 0)")
        .bind(ROOF, dayNumber('2026-09-23') * DAY + 15 * 3600 + 300 + i * 150, Math.round(((i + 1) / 91) * 3 * 1000) / 1000).run();
    }
    const r = await run('analysis', { range: 'last_week', system: 'Roof' });
    expect(said(r, 'Reporting')).toEqual(['Roof has not reported since Sun 27 Sep 2026 19:39, 13 h ago.']);
    expect(r.facts.days_not_wholly_recorded).toBe(1);
    // The late day is left out of the average: 120 kWh over the 6 whole days.
    expect(said(r, 'Production')).toEqual(['Roof made 120 kWh over 6 whole days, 20 kWh on an average day.']);
  });
});

describe('figures', () => {
  /** Last week: Garage a hybrid with a house and a battery kept full, Roof panels only; both reporting now, with their lifetime counters. */
  async function week() {
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5 });
    await addSystem(h.env.DB, { id: GARAGE, name: 'Garage', kwp: 4 });
    for (let n = dayNumber('2026-09-21'); n <= dayNumber('2026-09-27'); n++) {
      await addDay(h.env.DB, ROOF, isoOf(n), 20);
      await addHybridDay(h.env.DB, GARAGE, isoOf(n));
    }
    const now = (id: string, total: number, extra: string, values: number[]) => h.env.DB
      .prepare(`INSERT INTO readings (inverter_id, ts, source, ac_power_w, today_kwh, total_kwh, metrics, tz_offset_sec${extra}) VALUES (?1, ?2, 'test', 800, 0.4, ?3, '{}', 0${values.map((_, i) => `, ?${i + 4}`).join('')})`)
      .bind(id, NOW - 120, total, ...values).run();
    await now(ROOF, 12345.6, '', []);
    await now(GARAGE, 7831.4, ', load_power_w, grid_power_w', [450, -1200]);
  }

  it('counts the days a battery was full, leaving a system with no battery to a note', async () => {
    await week();
    const r = await run('figures', { measure: 'battery_high', stat: 'count', above: 97, range: 'last_week' });
    expect(r.columns).toEqual(['System', 'Days it was above 97%', 'Of days']);
    expect(r.rows).toEqual([['Garage', 7, 7]]);
    expect(r.summary).toBe("Garage: the battery's highest charge in a day was above 97% on 7 of the 7 days wholly recorded last week (21 – 27 Sep 2026).");
    expect(r.notes[0]).toBe("Roof has no record of the battery's highest charge in a day last week (21 – 27 Sep 2026).");
    noIds(r);
  });

  it('says the first time the grid was bought from above an amount, and how often it was sold to', async () => {
    await week();
    const first = await run('figures', { measure: 'grid', stat: 'first', above: 0.2, range: 'last_week' });
    expect(first.summary).toBe('Garage: the grid power was first buying more than 0.2 kW on Mon 21 Sep 2026 at 00:00 (300 W), last week (21 – 27 Sep 2026).');
    expect(first.rows).toEqual([['Garage', 0.3, 'Mon 21 Sep 2026 00:00', 7]]);
    const sold = await run('figures', { measure: 'grid', stat: 'count', below: -2, range: 'last_week' });
    expect(sold.summary).toBe('Garage: the grid power was selling more than 2 kW on 7 of the 7 days it was read last week (21 – 27 Sep 2026).');
    expect(sold.notes).toContain('Grid power is above zero while buying from the grid, and below zero while selling to it.');
  });

  it('adds energy up day by day with every system together, and charts the total', async () => {
    await week();
    const r = await run('figures', { measure: 'made', by: 'day', range: 'last_week' });
    expect(r.columns).toEqual(['Day', 'Roof (kWh)', 'Garage (kWh)', 'Together (kWh)']);
    expect(r.rows[0]).toEqual(['Mon 21 Sep 2026', 20, expect.any(Number), expect.any(Number)]);
    expect(r.rows[0][3]).toBeCloseTo(20 + (r.rows[0][2] as number), 1);
    expect(r.chart).toEqual({ kind: 'line', columns: [3] });
    expect(r.title).toBe('Energy made: total, by day');
  });

  it("averages each weekday, finds a moment's highest with its time, and gives what was made since installed", async () => {
    await week();
    const weekday = await run('figures', { measure: 'used', by: 'weekday', range: 'last_week' });
    expect(weekday.rows.map((x) => x[0])).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
    expect(weekday.rows[0][1]).toBe(9.6);
    expect(weekday.chart).toEqual({ kind: 'bar', columns: [1] });
    await h.env.DB.prepare("INSERT INTO readings (inverter_id, ts, source, ac_power_w, metrics, tz_offset_sec) VALUES (?1, ?2, 'test', 3500, '{}', 0)")
      .bind(GARAGE, dayNumber('2026-09-24') * DAY + 12 * 3600 + 600).run();
    const top = await run('figures', { measure: 'power', stat: 'highest', range: 'last_week', system: 'Garage' });
    expect(top.summary).toBe('Garage: the power made was at its highest, 3.5 kW, on Thu 24 Sep 2026 at 12:10, last week (21 – 27 Sep 2026).');
    const life = await run('figures', { measure: 'lifetime_made' });
    expect(life.summary).toBe('Roof has made 12.3 MWh since it was installed, by its inverter\'s own counter as last read, Mon 28 Sep 2026 08:58. '
      + "Garage has made 7831 kWh since it was installed, by its inverter's own counter as last read, Mon 28 Sep 2026 08:58. Together, 20.2 MWh.");
    expect(life.facts).toMatchObject({ s1_lifetime_kwh: 12345.6, s2_lifetime_kwh: 7831.4, together_lifetime_kwh: 20177 });
    noIds(life);
  });

  it('answers every measure, every way, by every step - in words with no gap in them', async () => {
    await week();
    const measures = ['made', 'used', 'bought', 'sold', 'battery_in', 'battery_out', 'peak_power', 'battery_low', 'battery_high', 'power', 'load', 'grid', 'battery_power', 'battery_charge'];
    const stats = ['total', 'average', 'highest', 'lowest', 'count', 'first', 'last'];
    const asked: Record<string, unknown>[] = [
      ...measures.flatMap((measure) => stats.map((stat) => ({ measure, stat }))),
      ...['weekday', 'day', 'week', 'month', 'year'].flatMap((by) => ['made', 'load', 'battery_high'].flatMap((measure) => ['average', 'highest', 'count'].map((stat) => ({ measure, stat, by })))),
      ...measures.map((measure) => ({ measure, by: 'hour_of_day' })),
      ...measures.flatMap((measure) => [{ measure, stat: 'count', above: 0.1 }, { measure, stat: 'first', below: 50 }, { measure, stat: 'total', above: 1 }, { measure, stat: 'average', above: 1, below: 1000 }]),
    ];
    for (const a of asked) {
      const r = await run('figures', { ...a, range: 'last_week' });
      expect(r.summary.length, JSON.stringify(a)).toBeGreaterThan(20);
      expect(r.summary, JSON.stringify(a)).not.toMatch(/undefined|NaN|null|\[object/);
      expect(r.rows.length, JSON.stringify(a)).toBeGreaterThan(0);
      noIds(r);
    }
  });

  it('says a battery and the grid by the way they flow, a day as it is named, and never when it never was', async () => {
    await week();
    const flow = async (a: Record<string, unknown>) => (await run('figures', { measure: 'battery_power', stat: 'count', range: 'last_week', system: 'Garage', ...a })).summary;
    expect(await flow({ above: 0.5 })).toContain('was charging at more than 0.5 kW on');
    expect(await flow({ below: -0.5 })).toContain('was discharging at more than 0.5 kW on');
    expect(await flow({ above: -1, below: 1 })).toContain('was between -1 kW and 1 kW on');
    // Beyond zero is simply charging or discharging, buying or selling.
    expect(await flow({ above: 0 })).toContain('was charging on');
    expect(await flow({ below: 0 })).toContain('was discharging on');
    // The most sold is the lowest figure, and said as sold; the most bought, and the battery's fastest charge, likewise.
    const sold = await run('figures', { measure: 'grid', stat: 'lowest', below: 0, range: 'last_week', system: 'Garage' });
    expect(sold.title).toBe('The grid power: lowest, selling');
    expect(sold.summary).toMatch(/^Garage: the most sold to the grid at once was [\d.]+ k?W, on \w{3} \d\d Sep 2026 at \d\d:\d\d, last week \(21 – 27 Sep 2026\)\.$/);
    expect((await run('figures', { measure: 'grid', stat: 'highest', range: 'last_week', system: 'Garage' })).summary)
      .toMatch(/^Garage: the most bought from the grid at once was [\d.]+ k?W, on /);
    // The week's battery is idle, kept full: one charge and one discharge between its readings.
    const battery = (iso: string, at: number, w: number) => h.env.DB
      .prepare("INSERT INTO readings (inverter_id, ts, source, ac_power_w, battery_power_w, battery_soc, metrics, tz_offset_sec) VALUES (?1, ?2, 'test', 0, ?3, 98, '{}', 0)")
      .bind(GARAGE, dayNumber(iso) * DAY + at, w).run();
    await battery('2026-09-23', 9 * 3600 + 600, 1200);
    await battery('2026-09-25', 21 * 3600 + 600, -900);
    const fastest = async (stat: string) => (await run('figures', { measure: 'battery_power', stat, range: 'last_week', system: 'Garage' })).summary;
    expect(await fastest('highest')).toBe('Garage: the battery charged fastest at 1.2 kW, on Wed 23 Sep 2026 at 09:10, last week (21 – 27 Sep 2026).');
    expect(await fastest('lowest')).toBe('Garage: the battery discharged fastest at 900 W, on Fri 25 Sep 2026 at 21:10, last week (21 – 27 Sep 2026).');
    expect((await run('figures', { measure: 'grid', stat: 'count', above: 0, range: 'last_week', system: 'Garage' })).summary).toContain('was buying on');
    const high = await run('figures', { measure: 'made', stat: 'first', above: 10, range: 'last_week', system: 'Roof' });
    expect(high.summary).toBe('Roof: energy made was first above 10 kWh on Mon 21 Sep 2026 (20 kWh), last week (21 – 27 Sep 2026).');
    const never = await run('figures', { measure: 'made', stat: 'last', above: 1000, range: 'last_week', system: 'Roof' });
    expect(never.summary).toBe('Roof: energy made was never above 1000 kWh last week (21 – 27 Sep 2026).');
    const byMonth = await run('figures', { measure: 'made', by: 'month', from: '2026-08-01', to: '2026-09-27', system: 'Roof' });
    expect(byMonth.rows).toEqual([['Sep 2026', 140]]);
    const byHour = await run('figures', { measure: 'load', by: 'hour_of_day', range: 'last_week', system: 'Garage' });
    expect(byHour.rows[19]).toEqual(['19:00', 0.9]);
    expect(byHour.summary).toBe('Garage: the house load, average by hour last week (21 – 27 Sep 2026) - highest 900 W (18:00), lowest 300 W (00:00).');
  });

  it("gives a day's figure by the hour as the moment's, refuses too long a span, says a total of power is its average, and one sentence for nothing on record", async () => {
    await week();
    // The energy the house used, by the hour, is its load at each hour; a day's peak by the hour is the highest power at each.
    const used = await run('figures', { measure: 'used', by: 'hour_of_day', range: 'last_week', system: 'Garage' });
    expect(used.title).toBe('The house load: average, by hour');
    expect(used.rows[19]).toEqual(['19:00', 0.9]);
    expect(used.notes[0]).toBe("Energy the house used is one figure a day: by the hour, this is the house load at each hour instead. An hour's average in kW is that hour's energy in kWh.");
    const peak = await run('figures', { measure: 'peak_power', by: 'hour_of_day', range: 'last_week', system: 'Garage' });
    expect(peak.title).toBe('The power made: highest, by hour');
    expect(peak.notes[0]).toBe("A day's highest power is one figure a day: by the hour, this is the power made at each hour instead.");
    await expect(run('figures', { measure: 'load', from: '2026-05-01', to: '2026-09-27' })).rejects.toThrow('three months at most');
    await expect(run('figures', { measure: 'made', from: '2025-01-01', to: '2026-09-27' })).rejects.toThrow('a year at most');
    const total = await run('figures', { measure: 'load', stat: 'total', range: 'last_week', system: 'Garage' });
    expect(total.notes).toContain('The house load does not add up over time, so this is its average.');
    expect(total.summary.startsWith('Garage: the house load averaged 400 W last week (21 – 27 Sep 2026)')).toBe(true);
    expect((await run('figures', { measure: 'sold', range: 'last_month' })).summary).toBe('There is no record of energy sold to the grid last month (1 – 31 Aug 2026).');
  });

  it('names a day or a span as it was asked, nothing as asked in one sentence, and an inverter with no lifetime counter', async () => {
    await week();
    const day = await run('figures', { measure: 'made', from: '2026-09-24', to: '2026-09-24', system: 'Roof' });
    expect(day.summary).toBe('Roof: 20 kWh of energy made on Thu 24 Sep 2026, from 1 day.');
    const span = await run('figures', { measure: 'made', above: 10, from: '2026-09-21', to: '2026-09-23', system: 'Roof' });
    expect(span.summary).toBe('Roof: 60 kWh of energy made over 21 – 23 Sep 2026, on the 3 days it was above 10 kWh.');
    const yesterday = await run('figures', { measure: 'load', stat: 'highest', range: 'yesterday', system: 'Garage' });
    expect(yesterday.summary).toMatch(/^Garage: the house load was at its highest, [\d.]+ k?W, on Sun 27 Sep 2026 at \d\d:\d\d, yesterday \(.*27 Sep 2026\)\.$/);
    expect((await run('figures', { measure: 'sold', above: 1, range: 'last_month' })).summary)
      .toBe('There is no record of energy sold to the grid above 1 kWh last month (1 – 31 Aug 2026).');
    // A third system reporting, with no lifetime counter: said so, and left out of the total of the other two.
    await addSystem(h.env.DB, { id: 'solarman:station:gamma', name: 'Shed', kwp: 2 });
    await h.env.DB.prepare("INSERT INTO readings (inverter_id, ts, source, ac_power_w, metrics, tz_offset_sec) VALUES ('solarman:station:gamma', ?1, 'test', 100, '{}', 0)").bind(NOW - 60).run();
    const life = await run('figures', { measure: 'lifetime_made' });
    expect(life.summary).toContain("Shed's inverter has not reported a lifetime total.");
    expect(life.rows.find((r) => r[0] === 'Shed')).toEqual(['Shed', null, 'Mon 28 Sep 2026 08:59']);
    expect(life.facts.together_lifetime_kwh).toBe(20177);
  });
});

describe('status_now: the house and the grid, now', () => {
  it('says what the house draws and which way the grid flows, for a system reporting now', async () => {
    await addSystem(h.env.DB, { id: GARAGE, name: 'Garage', kwp: 4 });
    await h.env.DB.prepare("INSERT INTO readings (inverter_id, ts, source, ac_power_w, today_kwh, load_power_w, grid_power_w, metrics, tz_offset_sec) VALUES (?1, ?2, 'test', 2000, 6.2, 450, -1200, '{}', 0)")
      .bind(GARAGE, NOW - 60).run();
    const r = await run('status_now', {});
    expect(r.summary).toBe('Garage is making 2 kW now, and 6.2 kWh so far today. At Garage, the house is drawing 450 W, selling 1.2 kW to the grid.');
    expect(r.facts).toMatchObject({ load_now_w: 450, grid_now_w: -1200 });
  });
});

describe('app_help', () => {
  it("answers how to do something in the app from the guide, with where it is", async () => {
    const r = await run('app_help', { question: 'How do I get alerts on Telegram?' });
    expect(r.rows[0]).toEqual(['Alerts on ntfy, Telegram, Discord or a webhook', expect.stringContaining('Settings → Alerts elsewhere'), '#/settings']);
    expect(r.summary).toBe(r.rows[0][1]);
    expect((await run('app_help', { question: 'turn on phone notif' })).rows[0][0]).toBe('Notifications on a phone');
    expect((await run('app_help', { question: 'why is my garage offline?' })).rows[0][0]).toBe('A system reads offline');
    expect((await run('app_help', { question: 'how do I get a graph of the grid power?' })).rows[0][0]).toBe('Graphs and charts');
    expect((await run('app_help', { question: 'where do I see the PV1 voltage?' })).rows[0][0]).toBe('PV strings and voltages');
    expect((await run('app_help', { question: 'where do I get recommendations and insights?' })).rows[0][0]).toBe('An analysis of your systems');
    const nothing = await run('app_help', { question: 'blue elephants' });
    expect(nothing.notes).toEqual(['Nothing in the guide matched the question; this is what the assistant can do.']);
    expect(nothing.rows[0][0]).toBe('The assistant, and reports');
    await expect(run('app_help', {})).rejects.toThrow('question is needed');
  });
});
