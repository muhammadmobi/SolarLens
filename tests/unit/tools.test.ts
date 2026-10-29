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
import { DAY, addDay, addFault, addSun, addSystem, dayNumber, isoOf } from '../helpers/solar-days';

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
    expect(TOOLS.map((t) => t.name)).toEqual(['status_now', 'outages', 'energy', 'power_day', 'battery', 'compare_systems', 'stats', 'faults', 'day_report', 'performance_trend', 'report', 'app_help']);
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

describe('app_help', () => {
  it("answers how to do something in the app from the guide, with where it is", async () => {
    const r = await run('app_help', { question: 'How do I get alerts on Telegram?' });
    expect(r.rows[0]).toEqual(['Alerts on ntfy, Telegram, Discord or a webhook', expect.stringContaining('Settings → Alerts elsewhere'), '#/settings']);
    expect(r.summary).toBe(r.rows[0][1]);
    expect((await run('app_help', { question: 'turn on phone notif' })).rows[0][0]).toBe('Notifications on a phone');
    expect((await run('app_help', { question: 'why is my garage offline?' })).rows[0][0]).toBe('A system reads offline');
    const nothing = await run('app_help', { question: 'blue elephants' });
    expect(nothing.notes).toEqual(['Nothing in the guide matched the question; this is what the assistant can do.']);
    expect(nothing.rows[0][0]).toBe('The assistant, and reports');
    await expect(run('app_help', {})).rejects.toThrow('question is needed');
  });
});
