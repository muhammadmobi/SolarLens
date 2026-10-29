/**
 * The read-only tools: every question SolarLens can answer, as a query the
 * Worker runs and a result it computes.
 *
 * Ask SolarLens (./ask) lets a language model choose one and put its result in
 * words; the agents (./agents) call them directly; the MCP server of phase 12
 * offers the same list to AI apps outside SolarLens. One layer, so all three
 * answer the same question with the same figures.
 *
 * Three rules make it safe to let a model choose:
 *
 * - **Every tool only reads.** None writes, spends a vendor call, or reaches
 *   anything but this Worker's own database.
 * - **A model never writes a query.** It picks a tool by name and fills in
 *   named arguments, each checked against its type, its choices and its range
 *   (checkArgs) before anything runs. A system is named as the dashboard names
 *   it; a period is a named range or two dates.
 * - **Every figure is computed here**, rounded here, and labelled with the
 *   period it covers and how fresh the data was, and each result carries a
 *   sentence that says it plainly (`summary`). So an answer can be shown with
 *   its evidence, and a reply that states some other number can be caught.
 *
 * No internal id appears in a result: systems go by name and alias, as on
 * every public answer. Days are the plants' own - a date means that date where
 * the panels are.
 */
import { daily, inverterIds, latest, listAlarms, listPeriods, listRelays, nowSec, series, type DayRow } from './db';
import { LEARN_DAYS, MIN_SAMPLES, MIN_SUN_KWH_M2, TYPICAL_RATIO } from './expected';
import { aliasFor } from './public-view';
import { STALE_AFTER_S } from './sensors';
import { getTariff, valueOf } from './settings';
import { weatherSince } from './weather';
import { HELP, findHelp } from './help';

const DAY = 86400;

// ---------------------------------------------------------------- the shapes

/** One argument a tool takes. */
export type ParamSpec =
  | { type: 'string'; description: string; enum?: readonly string[]; pattern?: RegExp; optional?: boolean }
  | { type: 'integer'; description: string; min: number; max: number; optional?: boolean }
  | { type: 'number'; description: string; min: number; max: number; optional?: boolean };

/** What every tool answers with. */
export interface ToolResult {
  tool: string;
  /** What the figures are: "Energy per month". */
  title: string;
  /** The days they cover, on the plants' calendar, and in words. */
  period: { from: string; to: string; label: string } | null;
  columns: string[];
  rows: (string | number | null)[][];
  /** The figures that answer the question, by name: totals, the best and the lowest, changes. */
  facts: Record<string, string | number | null>;
  /** What the figures leave out, or rest on. */
  notes: string[];
  /** The answer in a sentence or two, from the figures alone - what is shown when no model words it. */
  summary: string;
  /** How fresh the data behind it is: the newest reading, and any system not reporting now. */
  freshness: { newest: number | null; offline: string[] };
  /** A report's parts, each a result of its own: the energy, the statistics, the faults... */
  sections?: ToolResult[];
  /** How to draw the rows: as a line or bars, and which columns are its series. */
  chart?: { kind: 'line' | 'bar'; columns: number[] };
}

export type Args = Record<string, string | number>;

export interface Tool {
  name: string;
  /** What it answers, for a model choosing between tools and for an app listing them. */
  description: string;
  params: Record<string, ParamSpec>;
  run(ctx: ToolContext, args: Args): Promise<ToolResult>;
}

export interface ToolContext {
  db: D1Database;
  now: number;
}

/** A question the arguments do not let a tool answer - a system nobody has, a period not begun. */
export class ToolError extends Error {}

// ---------------------------------------------------------------- dates

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Days since 1970-01-01, on a clock `off` seconds east of UTC. */
export const dayNo = (ts: number, off: number) => Math.floor((ts + off) / DAY);
export const isoDay = (n: number) => new Date(n * DAY * 1000).toISOString().slice(0, 10);
const noOf = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 1000 / DAY);
const noOfYmd = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m, d) / 1000 / DAY);
const utc = (n: number) => new Date(n * DAY * 1000);

/** "21 Sep 2026", or "Mon 21 Sep 2026". */
export function dayWords(iso: string, weekday = false): string {
  const d = utc(noOf(iso));
  return `${weekday ? `${WEEKDAYS[d.getUTCDay()]} ` : ''}${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Up to five days by name, and any more by count: "Sat 5 Sep 2026, Sun 6 Sep 2026 and 3 more". */
function someDays(isos: string[]): string {
  const named = isos.slice(0, 5).map((d) => dayWords(d, true));
  return isos.length > 5 ? `${named.join(', ')} and ${isos.length - 5} more` : named.join(', ');
}

/** Names as a person lists them: "Roof", "Roof and Shed", "Roof, Shed and Garage". */
const inWords = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** Two days as a span: "21 Sep 2026", "21 – 27 Sep 2026", "30 Nov 2025 – 3 Jan 2026". */
export function spanWords(from: string, to: string): string {
  if (from === to) return dayWords(from, true);
  const a = utc(noOf(from));
  const b = utc(noOf(to));
  if (a.getUTCFullYear() !== b.getUTCFullYear()) return `${dayWords(from)} – ${dayWords(to)}`;
  if (a.getUTCMonth() === b.getUTCMonth()) return `${a.getUTCDate()} – ${dayWords(to)}`;
  return `${a.getUTCDate()} ${MONTHS[a.getUTCMonth()]} – ${dayWords(to)}`;
}

/** "14:05" on a clock `off` seconds east of UTC. */
const clock = (ts: number, off: number) => {
  const m = Math.floor((((ts + off) % DAY) + DAY) % DAY / 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/** A length of time as a person says it: "45 min", "3 h 15 min", "35 h", "3 days 17 h". */
const duration = (s: number) => {
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 10) return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} days${h % 24 ? ` ${h % 24} h` : ''}`;
};

export const RANGES = [
  'today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month',
  'this_year', 'last_year', 'last_7_days', 'last_30_days', 'last_12_months',
] as const;
export type Range = (typeof RANGES)[number];
const RANGE_WORDS: Record<Range, string> = {
  today: 'today', yesterday: 'yesterday', this_week: 'this week', last_week: 'last week',
  this_month: 'this month', last_month: 'last month', this_year: 'this year', last_year: 'last year',
  last_7_days: 'the last 7 days', last_30_days: 'the last 30 days', last_12_months: 'the last 12 months',
};

export interface Period { from: string; to: string; label: string }

/**
 * The period each tool covers when none is named. The assistant reads it too:
 * "and the month before?" after a report steps back from the month the report
 * covered.
 */
export const DEFAULT_RANGE: Record<string, Range> = {
  energy: 'this_month',
  compare_systems: 'this_month',
  faults: 'last_30_days',
  stats: 'last_30_days',
  report: 'last_month',
  outages: 'last_7_days',
  battery: 'last_7_days',
  chart: 'today',
  analysis: 'last_30_days',
  figures: 'last_30_days',
};

/**
 * The days a tool's period arguments name: a named range, or `from` and `to`
 * (either alone is one day), on the plants' calendar. Weeks run Monday to
 * Sunday. A period is cut off at today, and is at most three years long.
 */
export function resolvePeriod(args: Args, now: number, off: number, fallback: Range): Period {
  const today = dayNo(now, off);
  if (args.from !== undefined || args.to !== undefined) {
    let a = noOf(String(args.from ?? args.to));
    let b = noOf(String(args.to ?? args.from));
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new ToolError('A date is written YYYY-MM-DD.');
    if (a > b) [a, b] = [b, a];
    if (a > today) throw new ToolError('That period has not begun yet.');
    b = Math.min(b, today);
    if (b - a > 3 * 366) throw new ToolError('A period can be at most three years long.');
    return { from: isoDay(a), to: isoDay(b), label: spanWords(isoDay(a), isoDay(b)) };
  }
  const range = (args.range as Range | undefined) ?? fallback;
  const d = utc(today);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const monday = today - ((d.getUTCDay() + 6) % 7);
  const [a, b] = ({
    today: [today, today],
    yesterday: [today - 1, today - 1],
    this_week: [monday, today],
    last_week: [monday - 7, monday - 1],
    this_month: [noOfYmd(y, m, 1), today],
    last_month: [noOfYmd(y, m - 1, 1), noOfYmd(y, m, 1) - 1],
    this_year: [noOfYmd(y, 0, 1), today],
    last_year: [noOfYmd(y - 1, 0, 1), noOfYmd(y, 0, 1) - 1],
    last_7_days: [today - 6, today],
    last_30_days: [today - 29, today],
    last_12_months: [today - 364, today],
  } satisfies Record<Range, [number, number]>)[range];
  return { from: isoDay(a), to: isoDay(b), label: `${RANGE_WORDS[range]} (${spanWords(isoDay(a), isoDay(b))})` };
}

// ---------------------------------------------------------------- systems

export interface Sys {
  id: string;
  alias: string;
  name: string;
  provider: string;
  kwp: number | null;
  off: number | null;
}

/** The systems, as the page orders them, each with its alias. */
export async function loadSystems(db: D1Database): Promise<Sys[]> {
  const [{ results }, ids] = await Promise.all([
    db.prepare(
      `SELECT id, name, provider, capacity_w, tz_offset_sec FROM inverters WHERE enabled = 1
       ORDER BY display_order, CASE provider WHEN 'soliscloud' THEN 0 WHEN 'solarman' THEN 1 ELSE 2 END, id`,
    ).all<{ id: string; name: string | null; provider: string; capacity_w: number | null; tz_offset_sec: number | null }>(),
    inverterIds(db),
  ]);
  const alias = aliasFor(ids);
  return results.map((r) => {
    const a = alias(r.id) ?? 'unknown';
    return { id: r.id, alias: a, name: r.name || a, provider: r.provider, kwp: r.capacity_w ? r.capacity_w / 1000 : null, off: r.tz_offset_sec };
  });
}

/** The first system's clock, where the plants' days begin; UTC when no vendor has said. */
export const zoneOf = (systems: Sys[]) => systems.find((s) => s.off != null)?.off ?? 0;

/**
 * The systems an argument names: every one for "all" (or nothing), else the
 * one with that alias, that name, or the one name containing it.
 */
export function pickSystems(all: Sys[], asked: string | number | undefined): Sys[] {
  const q = String(asked ?? 'all').trim().toLowerCase();
  if (!q || q === 'all') return all;
  for (const match of [(s: Sys) => s.alias === q, (s: Sys) => s.name.toLowerCase() === q, (s: Sys) => s.name.toLowerCase().includes(q)]) {
    const found = all.filter(match);
    if (found.length === 1) return found;
  }
  throw new ToolError(`There is no one system called "${String(asked).slice(0, 40)}". The systems are ${all.map((s) => s.name).join(', ') || 'none yet'}.`);
}

/** The newest reading among `systems`, and which of them are not reporting now (the page's own rule). */
async function freshnessOf(db: D1Database, systems: Sys[], now: number): Promise<ToolResult['freshness']> {
  return freshnessFrom(await latest(db), systems, now);
}

/** The same, from the latest readings already read. */
function freshnessFrom(live: Awaited<ReturnType<typeof latest>>, systems: Sys[], now: number): ToolResult['freshness'] {
  const rows = live.filter((r) => systems.some((s) => s.id === r.id));
  return {
    newest: rows.reduce<number | null>((a, r) => (r.ts && (!a || r.ts > a) ? r.ts : a), null),
    offline: rows.filter((r) => !r.ts || now - r.ts > STALE_AFTER_S || r.status === 'offline').map((r) => systems.find((s) => s.id === r.id)!.name),
  };
}

// ---------------------------------------------------------------- figures

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
/** kWh for a sentence: "412 kWh", "38.2 kWh", "12.4 MWh". */
export const kwh = (v: number) => (Math.abs(v) >= 10000 ? `${(v / 1000).toFixed(1)} MWh` : Math.abs(v) >= 100 ? `${Math.round(v)} kWh` : `${r1(v)} kWh`);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
/** A sum that is null when every part is. */
const sumOrNull = (xs: (number | null | undefined)[]) => (xs.some((x) => x != null) ? xs.reduce<number>((a, x) => a + (x ?? 0), 0) : null);

/** Each system's daily rows for the period's days, on each plant's own calendar. */
async function dayRows(db: D1Database, systems: Sys[], p: Period, off: number): Promise<DayRow[]> {
  // A day's margin either side, for plants in other zones than the first.
  const rows = await daily(db, (noOf(p.from) - 1) * DAY - off, (noOf(p.to) + 2) * DAY - off, -off / 60);
  return rows.filter((r) => r.day >= p.from && r.day <= p.to && systems.some((s) => s.id === r.inverter_id));
}

/** Sunlight each day, kWh/m2, for one system, from its weather: each hour belongs to the day its middle falls in. */
function sunByDay(hours: { ts: number; ghi_wm2: number | null }[], off: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const h of hours) {
    if (h.ghi_wm2 == null) continue;
    const d = isoDay(dayNo(h.ts - 1800, off));
    out.set(d, (out.get(d) ?? 0) + h.ghi_wm2 / 1000);
  }
  return out;
}

/** A day worth learning a performance ratio from: fully recorded, with real sunlight, and not beyond physics. */
function dayRatio(row: DayRow | undefined, sun: number | undefined, kwp: number): number | null {
  if (!row || row.yield_kwh == null || row.samples < MIN_SAMPLES || sun == null || sun < MIN_SUN_KWH_M2 || row.yield_kwh <= 0) return null;
  const r = row.yield_kwh / (sun * kwp);
  return r <= 1.2 ? r : null;
}

// ---------------------------------------------------------------- argument checking

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const systemParam: ParamSpec = { type: 'string', description: 'A system, by its name as the dashboard shows it, or "all" (the default).', optional: true };
const periodParams: Record<string, ParamSpec> = {
  range: { type: 'string', enum: RANGES, description: 'A named period. Weeks run Monday to Sunday.', optional: true },
  from: { type: 'string', pattern: DATE, description: 'The first day, YYYY-MM-DD, for a period no range names - a month is its first and last day.', optional: true },
  to: { type: 'string', pattern: DATE, description: 'The last day, YYYY-MM-DD.', optional: true },
};

/**
 * The arguments a tool was given, checked against what it takes: an object,
 * each value of the declared type, one of the choices, in range. What it does
 * not take is dropped. Returns them tidied, or why not.
 */
export function checkArgs(tool: Tool, raw: unknown): Args | string {
  if (raw != null && (typeof raw !== 'object' || Array.isArray(raw))) return 'The arguments are an object of named values.';
  const given = (raw ?? {}) as Record<string, unknown>;
  const out: Args = {};
  for (const [name, spec] of Object.entries(tool.params)) {
    const v = given[name];
    if (v === undefined || v === null || v === '') {
      if (!spec.optional) return `${name} is needed.`;
      continue;
    }
    if (spec.type === 'integer') {
      const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
      if (!Number.isInteger(n) || n < spec.min || n > spec.max) return `${name} is a whole number from ${spec.min} to ${spec.max}.`;
      out[name] = n;
      continue;
    }
    if (spec.type === 'number') {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      if (!Number.isFinite(n) || n < spec.min || n > spec.max) return `${name} is a number from ${spec.min} to ${spec.max}.`;
      out[name] = n;
      continue;
    }
    if (typeof v !== 'string' && typeof v !== 'number') return `${name} is text.`;
    let s = String(v).trim().slice(0, 200);
    if (spec.enum) {
      // "last week" and "Last-Week" are last_week.
      s = s.toLowerCase().replace(/[\s-]+/g, '_');
      if (!spec.enum.includes(s)) return `${name} is one of ${spec.enum.join(', ')}.`;
    }
    if (spec.pattern && !spec.pattern.test(s)) return `${name} does not have the right form: ${spec.description}`;
    out[name] = s;
  }
  return out;
}

/** A tool's arguments as JSON Schema, for a model's structured output and for an MCP client. */
export function jsonSchemaOf(tool: Tool): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(tool.params)) {
    properties[name] = spec.type === 'integer' || spec.type === 'number'
      ? { type: spec.type, minimum: spec.min, maximum: spec.max, description: spec.description }
      : { type: 'string', description: spec.description, ...(spec.enum ? { enum: [...spec.enum] } : {}), ...(spec.pattern ? { pattern: spec.pattern.source } : {}) };
  }
  const required = Object.entries(tool.params).filter(([, s]) => !s.optional).map(([n]) => n);
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

// ---------------------------------------------------------------- status_now

const statusNow: Tool = {
  name: 'status_now',
  description: "What each system is doing right now: its power, what it has made today, what the house is drawing and which way the grid flows, its battery, "
    + "whether it is reporting, and its inverter's temperature.",
  params: { system: systemParam },
  async run({ db, now }, args) {
    const all = await loadSystems(db);
    const chosen = pickSystems(all, args.system);
    const off = zoneOf(all);
    const [lat, { results: heat }] = await Promise.all([
      latest(db),
      // Each inverter's temperature: its device record keeps the latest one only.
      db.prepare(
        `SELECT i.id AS inverter_id, d.temp_c, d.last_seen FROM devices d
         JOIN inverters i ON i.plant_id = d.plant_id AND i.provider = d.provider WHERE d.kind = 'inverter' AND d.temp_c IS NOT NULL`,
      ).all<{ inverter_id: string; temp_c: number; last_seen: number | null }>(),
    ]);
    const live = lat.filter((r) => chosen.some((s) => s.id === r.id));
    const rows = chosen.map((s) => {
      const r = live.find((x) => x.id === s.id);
      const on = !!r?.ts && now - r.ts <= STALE_AFTER_S && r.status !== 'offline';
      // A day's total counts only from a reading taken today: yesterday's last reading still carries yesterday's.
      const today = !!r?.ts && dayNo(r.ts, s.off ?? off) === dayNo(now, s.off ?? off);
      return [s.name, !r?.ts ? 'no data' : on ? 'reporting' : 'offline', on ? Math.round(r?.ac_power_w ?? 0) : 0,
        today && r?.today_kwh != null ? r1(r.today_kwh) : null, r?.battery_soc != null ? Math.round(r.battery_soc) : null,
        r?.ts ? clock(r.ts, s.off ?? off) : null];
    });
    const power = rows.reduce((a, x) => a + (x[2] as number), 0);
    const today = r1(rows.reduce((a, x) => a + ((x[3] as number | null) ?? 0), 0));
    const online = rows.filter((x) => x[1] === 'reporting').length;
    const freshness = await freshnessOf(db, chosen, now);
    const who = chosen.length === 1 ? chosen[0].name : `Your ${chosen.length} systems`;
    // A moment today by its time; one from an earlier day with its day as well.
    const stamp = (ts: number, o: number) => (dayNo(ts, o) === dayNo(now, o) ? clock(ts, o) : at(ts, o));
    const temps = chosen.map((s) => ({ s, t: heat.find((x) => x.inverter_id === s.id) })).filter((x) => x.t);
    const tempFacts: ToolResult['facts'] = Object.fromEntries(temps.map(({ s, t }) => [`${chosen.length === 1 ? '' : `${s.alias}_`}inverter_temp_c`, r1(t!.temp_c)]));
    const tempWords = temps.length
      ? ` Inverter temperature, as last read: ${temps.map(({ s, t }) => `${s.name} ${r1(t!.temp_c)} °C${t!.last_seen ? ` (${stamp(t!.last_seen, s.off ?? off)})` : ''}`).join(', ')}.`
      : '';
    const batteries = chosen.map((s) => {
      const r = live.find((x) => x.id === s.id);
      if (r?.battery_soc == null || !r.ts) return '';
      const on = now - r.ts <= STALE_AFTER_S && r.status !== 'offline';
      return ` ${s.name}'s battery ${on ? `is at ${Math.round(r.battery_soc)}%` : `was at ${Math.round(r.battery_soc)}% at its last reading, ${stamp(r.ts, s.off ?? off)}`}.`;
    }).join('');
    // What each house draws now, and which way the grid flows, where a system meters them and reports now.
    const flows: ToolResult['facts'] = {};
    const flowWords = chosen.map((s) => {
      const r = live.find((x) => x.id === s.id);
      if (!r?.ts || now - r.ts > STALE_AFTER_S || r.status === 'offline') return '';
      const k = chosen.length === 1 ? '' : `${s.alias}_`;
      const parts: string[] = [];
      if (r.load_power_w != null) { parts.push(`the house is drawing ${kw(r.load_power_w)}`); flows[`${k}load_now_w`] = Math.round(r.load_power_w); }
      // Under 20 W either way is the meter's drift, not a flow.
      if (r.grid_power_w != null && Math.abs(r.grid_power_w) >= 20) {
        parts.push(r.grid_power_w > 0 ? `buying ${kw(r.grid_power_w)} from the grid` : `selling ${kw(-r.grid_power_w)} to the grid`);
        flows[`${k}grid_now_w`] = Math.round(r.grid_power_w);
      }
      return parts.length ? ` At ${s.name}, ${parts.join(', ')}.` : '';
    }).join('');
    return {
      tool: 'status_now',
      title: 'Right now',
      period: { from: isoDay(dayNo(now, off)), to: isoDay(dayNo(now, off)), label: `today (${dayWords(isoDay(dayNo(now, off)), true)})` },
      columns: ['System', 'Status', 'Power now (W)', 'Made today (kWh)', 'Battery (%)', 'Last reading'],
      rows,
      facts: { power_now_w: power, made_today_kwh: today, reporting: online, systems: chosen.length, ...flows, ...tempFacts },
      notes: [
        ...(freshness.offline.length ? [`Not reporting now: ${freshness.offline.join(', ')}. An offline system counts as making nothing.`] : []),
        ...(temps.length ? ["An inverter's temperature is kept as last read, not through the day."] : []),
      ],
      summary: `${who} ${chosen.length === 1 ? 'is' : 'are'} making ${power >= 1000 ? `${r2(power / 1000)} kW` : `${power} W`} now, and ${kwh(today)} so far today`
        + `${chosen.length > 1 ? `; ${online} of ${chosen.length} reporting` : online ? '' : '; it is not reporting'}.`
        // Each house's draw and the grid's way, each battery's charge - the last one read, said as such when the system is not
        // reporting now - and each inverter's temperature.
        + flowWords + batteries + tempWords,
      freshness,
    };
  },
};

// ---------------------------------------------------------------- energy

type Group = 'day' | 'week' | 'month' | 'year' | 'total';
type Measure = 'made' | 'used' | 'imported' | 'exported';
const MEASURES: Measure[] = ['made', 'used', 'imported', 'exported'];
const MEASURE_WORDS: Record<Measure, string> = { made: 'Made', used: 'Used', imported: 'Bought', exported: 'Sold' };
const fieldOf: Record<Measure, 'yield_kwh' | 'load_kwh' | 'import_kwh' | 'export_kwh'> = {
  made: 'yield_kwh', used: 'load_kwh', imported: 'import_kwh', exported: 'export_kwh',
};

interface Figures { made: number | null; used: number | null; imported: number | null; exported: number | null }

/**
 * Energy per system per bucket (a day, or a month), for the period: SolarLens's
 * own daily record, and - for a month wholly inside the period - the vendor's
 * own month total where it has one, which reaches back before SolarLens began.
 */
async function energyBuckets(db: D1Database, systems: Sys[], p: Period, off: number, byMonth: boolean) {
  const days = await dayRows(db, systems, p, off);
  const vendor = byMonth ? (await listPeriods(db)).filter((v) => v.period === 'month') : [];
  const keys: string[] = [];
  for (let n = noOf(p.from); n <= noOf(p.to); n++) {
    const k = byMonth ? isoDay(n).slice(0, 7) : isoDay(n);
    if (keys[keys.length - 1] !== k) keys.push(k);
  }
  let usedVendor = false;
  const table = new Map<string, Map<string, Figures>>();     // key -> system -> figures
  for (const k of keys) {
    const whole = byMonth && `${k}-01` >= p.from && isoDay(noOfYmd(Number(k.slice(0, 4)), Number(k.slice(5, 7)), 1) - 1) <= p.to;
    const per = new Map<string, Figures>();
    for (const s of systems) {
      const mine = days.filter((d) => d.inverter_id === s.id && (byMonth ? d.day.startsWith(k) : d.day === k));
      const own: Figures = {
        made: sumOrNull(mine.map((d) => d.yield_kwh)), used: sumOrNull(mine.map((d) => d.load_kwh)),
        imported: sumOrNull(mine.map((d) => d.import_kwh)), exported: sumOrNull(mine.map((d) => d.export_kwh)),
      };
      const v = whole ? vendor.find((x) => x.inverter_id === s.id && x.key === k && x.yield_kwh != null) : undefined;
      if (v && (own.made == null || (v.yield_kwh ?? 0) >= own.made)) {
        usedVendor = true;
        per.set(s.id, { made: v.yield_kwh, used: v.load_kwh ?? own.used, imported: v.import_kwh ?? own.imported, exported: v.export_kwh ?? own.exported });
      } else per.set(s.id, own);
    }
    table.set(k, per);
  }
  return { keys, table, days, usedVendor };
}

/** The first day SolarLens has a record of, for any of `systems`. */
async function firstRecord(db: D1Database, systems: Sys[], off: number): Promise<string | null> {
  if (!systems.length) return null;
  const row = await db
    .prepare(`SELECT MIN(ts) AS ts FROM readings WHERE inverter_id IN (${systems.map((_, i) => `?${i + 1}`).join(', ')})`)
    .bind(...systems.map((s) => s.id))
    .first<{ ts: number | null }>();
  return row?.ts ? isoDay(dayNo(row.ts, off)) : null;
}

const energy: Tool = {
  name: 'energy',
  description: 'Energy over a period - made, used by the house, bought from the grid and sold to it - in total or per day, week, month or year, '
    + 'for one system or all together. For "how much", "which month was best", "how much did I export". With the tariff set, also the money saved and the CO2 avoided '
    + '(measure "saved"); and how much of what was made was used at home, and how much of what the house used the sun covered (measure "self").',
  params: {
    ...periodParams,
    group_by: { type: 'string', enum: ['day', 'week', 'month', 'year', 'total'], description: 'How to split the period; by default days for a month or less, months for up to a year, else years.', optional: true },
    measure: { type: 'string', enum: ['made', 'used', 'imported', 'exported', 'saved', 'self', 'all'], description: 'Which energy the question is about; all by default. saved: the money and CO2; self: the share used at home.', optional: true },
    system: systemParam,
  },
  async run({ db, now }, args) {
    const all = await loadSystems(db);
    const chosen = pickSystems(all, args.system);
    const off = zoneOf(all);
    const p = resolvePeriod(args, now, off, DEFAULT_RANGE.energy);
    const span = noOf(p.to) - noOf(p.from) + 1;
    const group = (args.group_by as Group | undefined) ?? (span <= 31 ? 'day' : span <= 400 ? 'month' : 'year');
    const byMonth = group === 'month' || group === 'year' || (group === 'total' && span > 62);
    const { keys, table, days, usedVendor } = await energyBuckets(db, chosen, p, off, byMonth);

    // Buckets folded into the group asked for, each summed over the systems chosen.
    const labelOf = (k: string): [string, string] => {
      if (group === 'total') return ['total', p.label];
      if (group === 'year') return [k.slice(0, 4), k.slice(0, 4)];
      if (group === 'month') return [k.slice(0, 7), `${MONTHS[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`];
      if (group === 'week') {
        const n = noOf(k);
        const monday = isoDay(n - ((utc(n).getUTCDay() + 6) % 7));
        return [monday, `week of ${dayWords(monday < p.from ? p.from : monday)}`];
      }
      return [k, dayWords(k, true)];
    };
    const grouped = new Map<string, { label: string; figs: Figures[] }>();
    for (const k of keys) {
      const [gk, label] = labelOf(k);
      const g = grouped.get(gk) ?? { label, figs: [] };
      g.figs.push(...chosen.map((s) => table.get(k)!.get(s.id)!));
      grouped.set(gk, g);
    }
    const sums = [...grouped.entries()].map(([key, g]) => ({
      key,
      label: g.label,
      ...(Object.fromEntries(MEASURES.map((m) => [m, sumOrNull(g.figs.map((f) => f[m]))])) as unknown as Figures),
    }));
    const present = MEASURES.filter((m) => sums.some((s) => s[m] != null));
    const rows = sums.map((s) => [s.label, ...present.map((m) => (s[m] == null ? null : r1(s[m] as number)))]);

    const facts: ToolResult['facts'] = {};
    for (const m of present) facts[`total_${m}_kwh`] = r1(sums.reduce((a, s) => a + ((s[m] as number | null) ?? 0), 0));
    const measure = (args.measure as Measure | 'saved' | 'self' | 'all' | undefined) ?? 'all';
    // The money and the share used at home are about what was made, with every figure beside it.
    const wide = measure === 'all' || measure === 'saved' || measure === 'self';
    const focus: Measure = wide ? 'made' : measure;
    // Day by day, a day not wholly recorded for every system - a system's first
    // evening, a relay off for most of it - is nobody's best or lowest day: its
    // figure is only what was recorded. It stays in the table and the totals.
    const partDays = group !== 'day' ? [] : sums.filter((s) => s[focus] != null && chosen.some((sys) => {
      const row = days.find((d) => d.inverter_id === sys.id && d.day === s.key);
      return !row || row.samples < MIN_SAMPLES;
    })).map((s) => s.key);
    const withData = sums.filter((s) => s[focus] != null && !partDays.includes(s.key));
    if (sums.length > 1 && withData.length) {
      const best = withData.reduce((b, s) => ((s[focus] as number) > (b[focus] as number) ? s : b));
      const low = withData.reduce((b, s) => ((s[focus] as number) < (b[focus] as number) ? s : b));
      Object.assign(facts, {
        [`highest_${focus}_period`]: best.label, [`highest_${focus}_kwh`]: r1(best[focus] as number),
        [`lowest_${focus}_period`]: low.label, [`lowest_${focus}_kwh`]: r1(low[focus] as number),
        [`average_${focus}_kwh`]: r1(withData.reduce((a, s) => a + (s[focus] as number), 0) / withData.length),
        periods_with_data: withData.length,
      });
    }
    // The money and the carbon, by the owner's tariff, day by day where there are days.
    const tariff = await getTariff(db);
    if (tariff && present.includes('made')) {
      let saved = 0, co2 = 0, assumed = false;
      for (const k of keys) for (const s of chosen) {
        const f = table.get(k)!.get(s.id)!;
        const v = valueOf(f.made, f.exported, tariff);
        if (v) { saved += v.money; co2 += v.co2; assumed ||= v.assumed; }
      }
      Object.assign(facts, { saved: r2(saved), currency: tariff.currency, co2_avoided_kg: r1(co2) });
      if (assumed) facts.saved_is_upper_bound = 'yes';
    }

    const notes: string[] = [];
    const first = await firstRecord(db, chosen, off);
    if (first && first > p.from) {
      notes.push(usedVendor
        ? `SolarLens's own record begins on ${dayWords(first)}; whole months before that use the vendor's own totals.`
        : `SolarLens's own record begins on ${dayWords(first)}; nothing before it is counted.`);
    } else if (usedVendor) notes.push("Whole months use the vendor's own month totals where they are larger than SolarLens's record.");
    for (const m of ['used', 'imported', 'exported'] as Measure[]) {
      if (measure !== m && !wide) continue;
      const blind = chosen.filter((s) => !days.some((d) => d.inverter_id === s.id && d[fieldOf[m]] != null));
      if (blind.length && blind.length < chosen.length) notes.push(`${inWords(blind.map((s) => s.name))} ${blind.length === 1 ? 'does' : 'do'} not report what ${m === 'used' ? 'the house used' : `was ${m === 'imported' ? 'bought' : 'sold'}`}.`);
    }
    if (facts.saved_is_upper_bound) notes.push('Some of the saving counts every kWh at the price of one bought, since the export was not reported: an upper bound.');
    if (partDays.length && facts[`highest_${focus}_period`] !== undefined) {
      notes.push(`Not wholly recorded, so left out of the best and lowest day: ${someDays(partDays)}.`);
    }

    const who = chosen.length === 1 ? chosen[0].name : 'Your systems';
    const verb: Record<Measure, string> = { made: 'made', used: 'used', imported: 'bought', exported: 'sold' };
    const total = facts[`total_${focus}_kwh`];
    let summary = total == null
      ? `There is no record of energy ${verb[focus]} ${p.label}.`
      : focus === 'used'
        ? `${chosen.length > 1 ? 'The houses' : 'The house'} used ${kwh(total as number)} ${p.label}${chosen.length === 1 ? `, as ${who} measured it` : ''}.`
        : `${who} ${verb[focus]} ${kwh(total as number)} ${focus === 'imported' ? 'from the grid ' : focus === 'exported' ? 'to the grid ' : ''}${p.label}.`;
    if (facts[`highest_${focus}_period`]) {
      // Made has a best day; what was used, bought or sold has only a highest.
      const top = focus === 'made' ? 'best' : 'highest';
      summary += ` The ${group === 'total' ? top : `${top} ${group}`} was ${facts[`highest_${focus}_period`]} with ${kwh(facts[`highest_${focus}_kwh`] as number)}; the lowest was ${facts[`lowest_${focus}_period`]} with ${kwh(facts[`lowest_${focus}_kwh`] as number)}.`;
    }

    // How much of what was made was used at home, over the systems that say what they sold; and how
    // much of what the houses used the sun covered, over those that say what they bought.
    const per = (sys: Sys, m: Measure) => sumOrNull(keys.map((k) => table.get(k)!.get(sys.id)![m]));
    const selling = chosen.filter((sys) => per(sys, 'made') != null && per(sys, 'exported') != null);
    const buying = chosen.filter((sys) => per(sys, 'used') != null && per(sys, 'imported') != null);
    const madeS = selling.reduce((x, sys) => x + (per(sys, 'made') ?? 0), 0);
    const soldS = selling.reduce((x, sys) => x + (per(sys, 'exported') ?? 0), 0);
    const usedB = buying.reduce((x, sys) => x + (per(sys, 'used') ?? 0), 0);
    const boughtB = buying.reduce((x, sys) => x + (per(sys, 'imported') ?? 0), 0);
    if (madeS > 0) Object.assign(facts, { made_by_systems_reporting_sales_kwh: r1(madeS), used_at_home_pct: Math.round(Math.max(0, madeS - soldS) / madeS * 100), sold_pct: Math.round(Math.min(soldS, madeS) / madeS * 100) });
    if (usedB > 0) facts.covered_by_the_sun_pct = Math.round(Math.max(0, usedB - boughtB) / usedB * 100);

    if (measure === 'saved') {
      summary = facts.saved != null
        ? `${who} saved about ${facts.saved} ${facts.currency} ${p.label}, and avoided ${facts.co2_avoided_kg} kg of CO2, from ${kwh(total as number ?? 0)} made.`
        : `No tariff is set yet, so SolarLens cannot work out the money saved: the owner sets the prices under Settings → Tariff. ${summary}`;
    } else if (measure === 'self') {
      summary = madeS > 0
        ? `Of the ${kwh(madeS)} made ${p.label}${selling.length < chosen.length ? ` by ${selling.map((sys) => sys.name).join(', ')}, which ${selling.length === 1 ? 'reports what it' : 'report what they'} sold,` : ','} ${facts.used_at_home_pct}% was used at home and ${facts.sold_pct}% sold to the grid.`
          + `${facts.covered_by_the_sun_pct != null ? ` The sun covered ${facts.covered_by_the_sun_pct}% of what the house${buying.length > 1 ? 's' : ''} used.` : ''}`
        : `SolarLens cannot tell how much was used at home ${p.label}: no system here reports what it sold. ${summary}`;
    } else if (facts.saved != null && focus === 'made') summary += ` That saved about ${facts.saved} ${facts.currency} and avoided ${facts.co2_avoided_kg} kg of CO2.`;
    return {
      tool: 'energy',
      title: `Energy${group === 'total' ? '' : ` per ${group}`}${chosen.length === 1 ? `, ${chosen[0].name}` : ''}`,
      period: { ...p },
      columns: [group === 'total' ? 'Period' : group[0].toUpperCase() + group.slice(1), ...present.map((m) => `${MEASURE_WORDS[m]} (kWh)`)],
      rows,
      facts,
      notes,
      summary,
      freshness: await freshnessOf(db, chosen, now),
    };
  },
};

// ---------------------------------------------------------------- compare_systems

const compareSystems: Tool = {
  name: 'compare_systems',
  description: 'Every system side by side over a period, on a fair scale: energy made per kWp of panels, best first. For "which system did best" or "compare my systems".',
  params: { ...periodParams },
  async run({ db, now }, args) {
    const all = await loadSystems(db);
    const off = zoneOf(all);
    const p = resolvePeriod(args, now, off, DEFAULT_RANGE.compare_systems);
    const span = noOf(p.to) - noOf(p.from) + 1;
    const { keys, table, days } = await energyBuckets(db, all, p, off, span > 62);
    const per = all.map((s) => {
      const made = sumOrNull(keys.map((k) => table.get(k)!.get(s.id)!.made));
      const recorded = days.filter((d) => d.inverter_id === s.id && d.yield_kwh != null).length;
      return { s, made, perKwp: made != null && s.kwp ? made / s.kwp : null, recorded };
    }).sort((a, b) => (b.perKwp ?? -1) - (a.perKwp ?? -1));
    const rated = per.filter((x) => x.perKwp != null);
    const facts: ToolResult['facts'] = { total_made_kwh: r1(per.reduce((a, x) => a + (x.made ?? 0), 0)) };
    let summary = rated.length ? '' : `No system has both a size and a record ${p.label}, so none can be compared.`;
    if (rated.length) {
      const best = rated[0];
      const low = rated[rated.length - 1];
      Object.assign(facts, { best_system: best.s.name, best_kwh_per_kwp: r1(best.perKwp!), lowest_system: low.s.name, lowest_kwh_per_kwp: r1(low.perKwp!) });
      summary = `Per kWp of panels ${p.label}, ${best.s.name} did best with ${r1(best.perKwp!)} kWh per kWp`;
      if (rated.length > 1) {
        const gap = Math.round((1 - low.perKwp! / best.perKwp!) * 100);
        facts.lowest_below_best_pct = gap;
        summary += `; ${low.s.name} made ${r1(low.perKwp!)}, ${gap}% less`;
      }
      summary += '.';
    }
    const notes = per.filter((x) => x.made != null && x.recorded < span && span <= 62).map((x) => `${x.s.name} reported on ${x.recorded} of the ${span} days, which lowers its figure.`);
    for (const x of per) if (!x.s.kwp) notes.push(`${x.s.name} has no size recorded, so it has no per-kWp figure.`);
    return {
      tool: 'compare_systems',
      title: 'Systems compared, per kWp',
      period: { ...p },
      columns: ['System', 'Size (kWp)', 'Made (kWh)', 'kWh per kWp', 'Days recorded'],
      rows: per.map((x) => [x.s.name, x.s.kwp != null ? r1(x.s.kwp) : null, x.made != null ? r1(x.made) : null, x.perKwp != null ? r1(x.perKwp) : null, x.recorded]),
      facts,
      notes,
      summary,
      freshness: await freshnessOf(db, all, now),
    };
  },
};

// ---------------------------------------------------------------- faults

const faults: Tool = {
  name: 'faults',
  description: 'The faults the vendors recorded over a period: when, which system, what, how serious, and whether each has cleared.',
  params: { ...periodParams, system: systemParam },
  async run({ db, now }, args) {
    const all = await loadSystems(db);
    const chosen = pickSystems(all, args.system);
    const off = zoneOf(all);
    const p = resolvePeriod(args, now, off, DEFAULT_RANGE.faults);
    const start = noOf(p.from) * DAY - off;
    const end = (noOf(p.to) + 1) * DAY - off;
    const alarms = (await listAlarms(db, start - DAY, 5000))
      .filter((a) => a.begin_ts >= start && a.begin_ts < end && chosen.some((s) => s.id === a.inverter_id))
      .sort((a, b) => a.begin_ts - b.begin_ts);
    const nameOf = (id: string) => chosen.find((s) => s.id === id)!;
    const what = (a: (typeof alarms)[number]) => a.message ?? `fault ${a.code}`;
    const rows = alarms.map((a) => {
      const s = nameOf(a.inverter_id);
      const o = s.off ?? off;
      return [`${dayWords(isoDay(dayNo(a.begin_ts, o)), true)} ${clock(a.begin_ts, o)}`, s.name, what(a), a.severity,
        a.end_ts ? `cleared after ${duration(a.end_ts - a.begin_ts)}` : a.state === 'active' ? 'still active' : 'end not recorded'];
    });
    const counts = new Map<string, number>();
    for (const a of alarms) counts.set(what(a), (counts.get(what(a)) ?? 0) + 1);
    const common = [...counts].sort((a, b) => b[1] - a[1])[0];
    const active = alarms.filter((a) => !a.end_ts && a.state === 'active').length;
    return {
      tool: 'faults',
      title: 'Faults',
      period: { ...p },
      columns: ['When', 'System', 'Fault', 'Severity', 'Outcome'],
      rows,
      facts: { faults: alarms.length, still_active: active, ...(common ? { most_common: common[0], most_common_times: common[1] } : {}) },
      notes: [],
      summary: alarms.length
        ? `${alarms.length} fault${alarms.length === 1 ? ' was' : 's were'} recorded ${p.label}${active ? `, ${active} still active` : ''}${common && common[1] > 1 ? `; the most common was ${common[0]}, ${common[1]} times` : ''}.`
        : `No faults were recorded ${p.label}.`,
      freshness: await freshnessOf(db, chosen, now),
    };
  },
};

// ---------------------------------------------------------------- day_report

/** A gap in the readings longer than this, in daylight, is a stretch the system was not recorded. */
const GAP_S = 30 * 60;
/** Below this share of a usual day's sunlight, the weather is the reason. */
const DULL = 0.7;
/** Below this share of what its sunlight allowed, the system itself fell short. */
const SHORT = 0.75;

const dayReport: Tool = {
  name: 'day_report',
  description: 'Why a day was low (or whether it was): each system\'s energy that day against a usual day, the sunlight against usual, '
    + 'what the sunlight should have made, stretches with no readings, and faults - with the likely cause.',
  params: {
    date: { type: 'string', pattern: /^(today|yesterday|\d{4}-\d{2}-\d{2})$/, description: 'The day, YYYY-MM-DD, or today or yesterday.', optional: true },
    system: systemParam,
  },
  async run({ db, now }, args) {
    const all = await loadSystems(db);
    const chosen = pickSystems(all, args.system);
    const off = zoneOf(all);
    const today = dayNo(now, off);
    const asked = String(args.date ?? 'yesterday');
    const d = asked === 'today' ? today : asked === 'yesterday' ? today - 1 : noOf(asked);
    if (!Number.isFinite(d)) throw new ToolError('A date is written YYYY-MM-DD.');
    if (d > today) throw new ToolError('That day has not happened yet.');
    if (today - d > 380) throw new ToolError('SolarLens keeps the weather for about a year, so it cannot explain a day that long ago.');
    const day = isoDay(d);
    const from = (d - LEARN_DAYS - 1) * DAY - off;
    const [history, weather, alarms, points] = await Promise.all([
      daily(db, from - DAY, (d + 2) * DAY - off, -off / 60),
      weatherSince(db, from - DAY),
      listAlarms(db, (d - 2) * DAY - off, 5000),
      series(db, d * DAY - off - DAY, (d + 1) * DAY - off + DAY),
    ]);

    const facts: ToolResult['facts'] = {};
    const lines: string[] = [];
    const rows = chosen.map((s) => {
      const o = s.off ?? off;
      const start = d * DAY - o;
      const mine = history.filter((r) => r.inverter_id === s.id);
      const theDay = mine.find((r) => r.day === day);
      const before = mine.filter((r) => r.day < day && r.day >= isoDay(d - LEARN_DAYS) && r.yield_kwh != null && r.samples >= MIN_SAMPLES);
      const usual = before.length >= 3 ? median(before.map((r) => r.yield_kwh as number)) : null;
      const hours = weather.filter((w) => w.inverter_id === s.id && w.ts <= start + DAY + 3600);
      const sun = sunByDay(hours, o);
      const sunDay = sun.get(day) ?? null;
      const usualSun = before.filter((r) => sun.has(r.day)).length >= 3 ? median(before.filter((r) => sun.has(r.day)).map((r) => sun.get(r.day)!)) : null;
      const ratios = s.kwp ? before.map((r) => dayRatio(r, sun.get(r.day), s.kwp!)).filter((x): x is number => x != null) : [];
      const ratio = ratios.length >= 3 ? median(ratios) : TYPICAL_RATIO;
      const expected = sunDay != null && s.kwp ? sunDay * s.kwp * ratio : null;
      // Daylight: the hours of real sun that day, or 06:00-18:00 without weather; up to now, today.
      const light = hours.filter((h) => isoDay(dayNo(h.ts - 1800, o)) === day && (h.ghi_wm2 ?? 0) >= 50);
      const wStart = light.length ? light[0].ts - 3600 : start + 6 * 3600;
      const wEnd = Math.min(light.length ? light[light.length - 1].ts : start + 18 * 3600, now);
      const seen = points.filter((p) => p.inverter_id === s.id && p.ts >= wStart && p.ts <= wEnd).map((p) => p.ts).sort((a, b) => a - b);
      const gaps: [number, number][] = [];
      let prev = wStart;
      for (const t of [...seen, wEnd]) {
        if (t - prev > GAP_S) gaps.push([prev, t]);
        prev = t;
      }
      const offline = gaps.reduce((a, [x, y]) => a + (y - x), 0);
      const clouds = light.map((h) => h.cloud_pct).filter((c): c is number => c != null);
      const cloud = clouds.length ? Math.round(clouds.reduce((a, c) => a + c, 0) / clouds.length) : null;
      const faultsThatDay = alarms.filter((a) => a.inverter_id === s.id && a.begin_ts < start + DAY && (a.end_ts ?? now) >= start);
      const made = theDay?.yield_kwh ?? null;
      const share = made != null && usual ? made / usual : null;
      const ofExpected = made != null && expected ? made / expected : null;

      // The likely causes, most telling first.
      const causes: string[] = [];
      if (made == null && !seen.length) causes.push('no readings at all that day: the feed was down, or the system was off');
      else if (offline >= GAP_S) {
        causes.push(`no readings for ${duration(offline)} (${gaps.slice(0, 3).map(([x, y]) => `${clock(x, o)}–${clock(y, o)}`).join(', ')}), so part of the day was not recorded`);
      }
      if (sunDay != null && usualSun && sunDay < DULL * usualSun) {
        causes.push(`less sun: ${r2(sunDay)} kWh/m² of sunlight against a usual ${r2(usualSun)}${cloud != null ? `, with ${cloud}% cloud` : ''}`);
      }
      if (ofExpected != null && ofExpected < SHORT && offline < GAP_S) {
        causes.push(`it made ${Math.round(ofExpected * 100)}% of what its sunlight allowed: shading, dirt, snow or a string down`);
      }
      for (const a of faultsThatDay.slice(0, 3)) {
        causes.push(`a fault: ${a.message ?? `fault ${a.code}`}, ${a.begin_ts >= start ? `from ${clock(a.begin_ts, o)}` : 'from the day before'}${a.end_ts ? ` to ${clock(a.end_ts, o)}` : ', not cleared that day'}`);
      }
      if (share != null && share >= 0.9 && !faultsThatDay.length && offline < GAP_S) causes.splice(0, causes.length, `not a low day: ${Math.round(share * 100)}% of a usual day`);
      else if (!causes.length) {
        causes.push(share == null ? 'too little record before it to say what is usual'
          : share < DULL
            // Well below with no cause found: say whether the sunlight could have been checked at all.
            ? `well below usual (${Math.round(share * 100)}%)${sunDay == null ? ', and there is no sunlight on record for that day to tell whether it was the weather' : ', with no cause in the figures'}`
            : `a little below usual (${Math.round(share * 100)}%), with no one cause`);
      }

      const k = chosen.length === 1 ? '' : `${s.alias}_`;
      Object.assign(facts, {
        [`${k}made_kwh`]: made != null ? r1(made) : null,
        [`${k}usual_kwh`]: usual != null ? r1(usual) : null,
        [`${k}of_usual_pct`]: share != null ? Math.round(share * 100) : null,
        [`${k}sunlight_kwh_m2`]: sunDay != null ? r2(sunDay) : null,
        [`${k}usual_sunlight_kwh_m2`]: usualSun != null ? r2(usualSun) : null,
        [`${k}expected_kwh`]: expected != null ? r1(expected) : null,
        [`${k}of_expected_pct`]: ofExpected != null ? Math.round(ofExpected * 100) : null,
        [`${k}not_reporting_min`]: Math.round(offline / 60),
        [`${k}faults`]: faultsThatDay.length,
        ...(cloud != null ? { [`${k}cloud_pct`]: cloud } : {}),
      });
      lines.push(`${s.name}${made != null ? ` made ${kwh(made)}${share != null ? `, ${Math.round(share * 100)}% of a usual day${usual != null ? ` (${kwh(usual)})` : ''}` : ''}` : ' has no total for that day'}: ${causes.join('; ')}.`);
      return [s.name, made != null ? r1(made) : null, usual != null ? r1(usual) : null, share != null ? Math.round(share * 100) : null,
        sunDay != null ? r2(sunDay) : null, usualSun != null ? r2(usualSun) : null, expected != null ? r1(expected) : null,
        Math.round(offline / 60), faultsThatDay.length];
    });
    return {
      tool: 'day_report',
      title: `${dayWords(day, true)}, explained`,
      period: { from: day, to: day, label: dayWords(day, true) },
      columns: ['System', 'Made (kWh)', 'Usual day (kWh)', 'Of usual (%)', 'Sunlight (kWh/m²)', 'Usual sunlight (kWh/m²)', 'Expected from the sun (kWh)', 'Not reporting (min)', 'Faults'],
      rows,
      facts,
      notes: ['"Usual" is the median of the 14 days before. Sunlight is from Open-Meteo at each system\'s position; "expected" is that sunlight times the system\'s size and the ratio it learned from those days.'],
      summary: lines.join(' '),
      freshness: await freshnessOf(db, chosen, now),
    };
  },
};

// ---------------------------------------------------------------- performance_trend

/** Weeks at the end compared with the weeks before them. */
export const RECENT_WEEKS = 4;
/** Fully recorded, sunny days a week needs to count, and weeks each side needs. */
const WEEK_DAYS = 3;
const SIDE_WEEKS = 3;
/** A fall this large, in percent, is a decline worth a look; a rise this large, an improvement. */
export const DECLINE_PCT = 8;

export interface Trend {
  system: Sys;
  weekly: (number | null)[];
  recent: number | null;
  earlier: number | null;
  change_pct: number | null;
  verdict: 'declining' | 'improving' | 'steady' | 'not enough data';
}

/**
 * Each system's performance ratio - energy made against the sunlight on its
 * panels - week by week, over the last `weeks` full weeks, and the last four
 * against the ones before. A ratio moves with the season a little (heat lowers
 * it), but a fall of 8% or more within a few months is dirt, shade, a failing
 * panel or a string down, and worth a look.
 */
export async function trends(db: D1Database, systems: Sys[], weeks: number, now: number, off: number): Promise<{ mondays: string[]; trends: Trend[] }> {
  const first = firstTrendDay(weeks, now, off);
  const [rows, weather] = await Promise.all([
    daily(db, (first - 1) * DAY - off, (first + 7 * weeks + 1) * DAY - off, -off / 60),
    weatherSince(db, (first - 1) * DAY - off),
  ]);
  return trendsFrom(rows, weather, systems, weeks, now, off);
}

/** The first day of the `weeks` full weeks before this one: a Monday, on the plants' calendar. */
function firstTrendDay(weeks: number, now: number, off: number): number {
  const today = dayNo(now, off);
  return today - ((utc(today).getUTCDay() + 6) % 7) - 7 * weeks;
}

/**
 * The same, from daily rows and hourly weather already read - the analysis
 * reads them once for all it does. They must cover the weeks, from the day
 * before the first.
 */
export function trendsFrom(rows: DayRow[], weather: Awaited<ReturnType<typeof weatherSince>>, systems: Sys[], weeks: number, now: number, off: number): { mondays: string[]; trends: Trend[] } {
  const first = firstTrendDay(weeks, now, off);
  const mondays = Array.from({ length: weeks }, (_, w) => isoDay(first + 7 * w));
  const out = systems.map((s): Trend => {
    const o = s.off ?? off;
    if (!s.kwp) return { system: s, weekly: mondays.map(() => null), recent: null, earlier: null, change_pct: null, verdict: 'not enough data' };
    const sun = sunByDay(weather.filter((w) => w.inverter_id === s.id), o);
    const mine = new Map(rows.filter((r) => r.inverter_id === s.id).map((r) => [r.day, r]));
    const weekly = mondays.map((_, w) => {
      let made = 0, possible = 0, n = 0;
      for (let i = 0; i < 7; i++) {
        const day = isoDay(first + 7 * w + i);
        const row = mine.get(day);
        if (dayRatio(row, sun.get(day), s.kwp!) == null) continue;
        made += row!.yield_kwh!;
        possible += sun.get(day)! * s.kwp!;
        n++;
      }
      return n >= WEEK_DAYS ? made / possible : null;
    });
    const recentWeeks = weekly.slice(-RECENT_WEEKS).filter((x): x is number => x != null);
    const earlierWeeks = weekly.slice(0, -RECENT_WEEKS).filter((x): x is number => x != null);
    if (recentWeeks.length < SIDE_WEEKS || earlierWeeks.length < SIDE_WEEKS) {
      return { system: s, weekly, recent: null, earlier: null, change_pct: null, verdict: 'not enough data' };
    }
    const recent = median(recentWeeks);
    const earlier = median(earlierWeeks);
    const change = Math.round((recent / earlier - 1) * 100);
    return {
      system: s, weekly, recent, earlier, change_pct: change,
      verdict: change <= -DECLINE_PCT ? 'declining' : change >= DECLINE_PCT ? 'improving' : 'steady',
    };
  });
  return { mondays, trends: out };
}

/** A trend in a sentence. */
export function trendWords(t: Trend, weeks: number): string {
  const before = weeks - RECENT_WEEKS;
  if (t.verdict === 'not enough data') return `${t.system.name}: not enough sunny, fully recorded weeks yet to tell${t.system.kwp ? '' : ' (and no size recorded)'}.`;
  const figures = `performance ratio ${r2(t.recent!)} over the last ${RECENT_WEEKS} weeks, against ${r2(t.earlier!)} in the ${before} before`;
  if (t.verdict === 'declining') return `${t.system.name}: for its sunlight it is making ${Math.abs(t.change_pct!)}% less (${figures}) - worth a look for dirt, shade or a string down.`;
  if (t.verdict === 'improving') return `${t.system.name}: for its sunlight it is making ${t.change_pct}% more (${figures}).`;
  return `${t.system.name}: steady (${figures}).`;
}

const performanceTrend: Tool = {
  name: 'performance_trend',
  description: 'Whether a system is slowly losing output: its performance ratio (energy made against the sunlight on its panels) week by week, '
    + 'and the last 4 weeks against the weeks before. For "is my system degrading", "are the panels dirty", "is anything getting worse".',
  params: {
    system: systemParam,
    weeks: { type: 'integer', min: 8, max: 26, description: 'How many full weeks to look back; 12 by default.', optional: true },
  },
  async run({ db, now }, args) {
    const all = await loadSystems(db);
    const chosen = pickSystems(all, args.system);
    const off = zoneOf(all);
    const weeks = (args.weeks as number | undefined) ?? 12;
    const { mondays, trends: ts } = await trends(db, chosen, weeks, now, off);
    const facts: ToolResult['facts'] = {};
    for (const t of ts) {
      const k = chosen.length === 1 ? '' : `${t.system.alias}_`;
      Object.assign(facts, {
        [`${k}verdict`]: t.verdict,
        [`${k}recent_ratio`]: t.recent != null ? r2(t.recent) : null,
        [`${k}earlier_ratio`]: t.earlier != null ? r2(t.earlier) : null,
        [`${k}change_pct`]: t.change_pct,
      });
    }
    return {
      tool: 'performance_trend',
      title: 'Output for the sunlight, week by week',
      period: { from: mondays[0], to: isoDay(noOf(mondays[mondays.length - 1]) + 6), label: `the ${weeks} weeks from ${spanWords(mondays[0], isoDay(noOf(mondays[mondays.length - 1]) + 6))}` },
      columns: ['Week of', ...ts.map((t) => `${t.system.name} (ratio)`)],
      rows: mondays.map((m, w) => [dayWords(m), ...ts.map((t) => (t.weekly[w] != null ? r2(t.weekly[w]!) : null))]),
      facts,
      notes: [`A week counts when it has at least ${WEEK_DAYS} fully recorded days with real sunlight. The ratio moves a little with the season; a fall of ${DECLINE_PCT}% or more is worth a look.`],
      summary: ts.map((t) => trendWords(t, weeks)).join(' '),
      freshness: await freshnessOf(db, chosen, now),
    };
  },
};

// ---------------------------------------------------------------- a day's power

/** Minutes past midnight, and back: "14:05" is 845. */
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const hhmmOf = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
/** Power for a sentence: "2.35 kW", or "310 W" under a kilowatt. */
const kw = (w: number) => (Math.abs(w) < 1000 ? `${Math.round(w)} W` : `${r2(w / 1000)} kW`);
/** A reading under this share of the day's highest is not making power: a trickle at dawn. */
const MAKING_SHARE = 0.02;
/** A fall of this share of the day's highest power, from one reading to the next, is a sharp drop. */
const SHARP_DROP = 0.25;
/** Readings further apart than this are not "one to the next". */
const STEP_S = 20 * 60;
/** Output going up and down less than this many times a smooth rise and fall is steady. */
const STEADY_UP_DOWN = 1.3;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const powerDay: Tool = {
  name: 'power_day',
  description: "A day's power, from every reading: what each system made between two times of that day, its average and highest power then and when, "
    + 'when it was making power, and how steady it was - sharp drops, the biggest fall, how much it went up and down - with the day hour by hour. '
    + 'For "between 2pm and 4pm", "this afternoon", "power fluctuation today", "when was the peak", "how stable was the output".',
  params: {
    date: { type: 'string', pattern: /^(today|yesterday|\d{4}-\d{2}-\d{2})$/, description: 'The day, YYYY-MM-DD, or today (the default) or yesterday.', optional: true },
    start: { type: 'string', pattern: TIME, description: "From, HH:MM on the 24-hour clock where the panels are; the day's start if left out.", optional: true },
    end: { type: 'string', pattern: /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/, description: "To, HH:MM; the day's end - or now, today - if left out.", optional: true },
    system: systemParam,
  },
  async run({ db, now }, args) {
    const all = await loadSystems(db);
    const chosen = pickSystems(all, args.system);
    const off = zoneOf(all);
    const today = dayNo(now, off);
    const asked = String(args.date ?? 'today');
    const d = asked === 'today' ? today : asked === 'yesterday' ? today - 1 : noOf(asked);
    if (!Number.isFinite(d)) throw new ToolError('A date is written YYYY-MM-DD.');
    if (d > today) throw new ToolError('That day has not happened yet.');
    const a = args.start ? minutesOf(String(args.start)) : 0;
    const b = args.end ? minutesOf(String(args.end)) : 24 * 60;
    if (b <= a) throw new ToolError('The end of the time comes after its start: 14:00 to 16:00.');
    const windowed = a > 0 || b < 24 * 60;
    const day = isoDay(d);
    const label = `${dayWords(day, true)}${windowed ? `, ${hhmmOf(a)}–${hhmmOf(b)}` : ''}`;
    // The day, and a margin either side for plants on other clocks than the first.
    const points = await series(db, d * DAY - off - DAY, (d + 1) * DAY - off + DAY);

    const facts: ToolResult['facts'] = {};
    const lines: string[] = [];
    const notes: string[] = [];
    const hourly = new Map<number, Map<string, number[]>>();   // hour -> system -> watts
    const made: number[] = [];
    let notYet = 0;
    const rows = chosen.map((s) => {
      const o = s.off ?? off;
      const k = chosen.length === 1 ? '' : `${s.alias}_`;
      const dayStart = d * DAY - o;
      const from = dayStart + a * 60;
      const to = Math.min(dayStart + b * 60, now);
      const mine = points.filter((p) => p.inverter_id === s.id && p.ts >= dayStart && p.ts < dayStart + DAY);
      const inside = mine.filter((p) => p.ts >= from && p.ts <= to);
      if (to <= from) {
        notYet++;
        lines.push(`${s.name}: it is not yet ${hhmmOf(a)} there.`);
        Object.assign(facts, { [`${k}made_kwh`]: null, [`${k}readings`]: 0 });
        return [s.name, null, null, null, null, null, null, null, null, null, 0];
      }
      if (!inside.length) {
        lines.push(`${s.name}: no readings ${windowed ? `between ${hhmmOf(a)} and ${hhmmOf(b)}` : 'that day'}.`);
        Object.assign(facts, { [`${k}made_kwh`]: null, [`${k}readings`]: 0 });
        return [s.name, null, null, null, null, null, null, null, null, null, 0];
      }
      // Made: the vendor's own day counter at the end, less what it said at the start - 0 at midnight.
      const counterAt = (t: number) => {
        let v: number | null = null;
        for (const p of mine) {
          if (p.ts > t) break;
          if (p.today_kwh != null) v = p.today_kwh;
        }
        return v;
      };
      const before = a === 0 ? 0 : counterAt(from);
      const startCount = before ?? inside[0].today_kwh;
      const endCount = counterAt(to);
      let got: number;
      if (endCount != null && startCount != null) got = Math.max(0, endCount - startCount);
      else {
        // No counter: each step's average power for its time, added up.
        let wh = 0;
        for (let i = 1; i < inside.length; i++) {
          const dt = inside[i].ts - inside[i - 1].ts;
          if (dt <= STEP_S) wh += (((inside[i].ac_power_w ?? 0) + (inside[i - 1].ac_power_w ?? 0)) / 2) * (dt / 3600);
        }
        got = wh / 1000;
      }
      made.push(got);
      if (windowed && before == null && inside[0].ts - from > STEP_S) {
        notes.push(`${s.name}'s readings that day begin at ${clock(inside[0].ts, o)}, so it is counted from then.`);
      }
      if (windowed && to - inside[inside.length - 1].ts > STEP_S) {
        notes.push(`${s.name}'s readings stop at ${clock(inside[inside.length - 1].ts, o)}.`);
      }

      const watts = inside.map((p) => p.ac_power_w ?? 0);
      let top = 0;
      watts.forEach((w, i) => { if (w > watts[top]) top = i; });
      const peak = watts[top];
      // The scale is the system's own highest that day: steady for what it does, whatever its size.
      const dayPeak = Math.max(0, ...mine.map((p) => p.ac_power_w ?? 0));
      const making = inside.filter((p) => (p.ac_power_w ?? 0) > dayPeak * MAKING_SHARE && (p.ac_power_w ?? 0) > 0);
      const firstOn = making.length ? making[0].ts : null;
      const lastOn = making.length ? making[making.length - 1].ts : null;
      const during = firstOn != null && lastOn != null ? inside.filter((p) => p.ts >= firstOn && p.ts <= lastOn).map((p) => p.ac_power_w ?? 0) : [];
      const average = during.length ? during.reduce((x, w) => x + w, 0) / during.length : null;
      const lowest = during.length ? Math.min(...during) : null;
      let drops = 0, biggest = 0, travel = 0;
      let biggestAt: number | null = null;
      for (let i = 1; i < inside.length; i++) {
        if (inside[i].ts - inside[i - 1].ts > STEP_S) continue;
        travel += Math.abs(watts[i] - watts[i - 1]);
        const fall = watts[i - 1] - watts[i];
        if (dayPeak > 0 && fall >= dayPeak * SHARP_DROP) drops++;
        if (fall > biggest) { biggest = fall; biggestAt = inside[i].ts; }
      }
      // Up and down: every rise and fall added together, against one smooth rise to the highest and fall back. 1 is smooth.
      const smooth = (peak - watts[0]) + (peak - watts[watts.length - 1]);
      const upDown = smooth > 0 && peak > 0 ? r1(travel / smooth) : null;
      for (const p of inside) {
        const h = Math.floor(((((p.ts + o) % DAY) + DAY) % DAY) / 3600);
        const byHour = hourly.get(h) ?? new Map<string, number[]>();
        byHour.set(s.id, [...(byHour.get(s.id) ?? []), p.ac_power_w ?? 0]);
        hourly.set(h, byHour);
      }
      const peakAt = clock(inside[top].ts, o);
      Object.assign(facts, {
        [`${k}made_kwh`]: r1(got),
        [`${k}average_kw`]: average != null ? r2(average / 1000) : null,
        [`${k}peak_kw`]: r2(peak / 1000),
        [`${k}peak_at`]: peak > 0 ? peakAt : null,
        [`${k}lowest_while_making_kw`]: lowest != null ? r2(lowest / 1000) : null,
        [`${k}sharp_drops`]: drops,
        [`${k}biggest_drop_kw`]: biggestAt != null ? r2(biggest / 1000) : null,
        [`${k}biggest_drop_at`]: biggestAt != null ? clock(biggestAt, o) : null,
        [`${k}up_and_down`]: upDown,
        [`${k}making_from`]: firstOn != null ? clock(firstOn, o) : null,
        [`${k}making_to`]: lastOn != null ? clock(lastOn, o) : null,
        [`${k}readings`]: inside.length,
      });
      const when = windowed ? `between ${hhmmOf(a)} and ${hhmmOf(b)}` : 'that day';
      if (peak <= 0) {
        lines.push(`${s.name} made no power ${when}.`);
      } else {
        const steady = drops === 0 && (upDown == null || upDown < STEADY_UP_DOWN)
          ? 'steady, with no sharp drops'
          : `${drops ? `${drops} sharp drop${drops === 1 ? '' : 's'}${biggestAt != null ? ` (the biggest ${kw(biggest)} at ${clock(biggestAt, o)})` : ''}` : 'no sharp drops'}`
            + (upDown != null ? `, going up and down ${upDown} times as much as a smooth ${windowed ? 'stretch' : 'day'}` : '');
        lines.push(`${s.name} made ${kwh(got)} ${when}${average != null ? `, ${kw(average)} on average while making power` : ''}, highest ${kw(peak)} at ${peakAt}`
          + `${!windowed && firstOn != null ? `, making power from ${clock(firstOn, o)} to ${clock(lastOn!, o)}` : ''}: ${steady}.`);
      }
      return [s.name, r1(got), average != null ? r2(average / 1000) : null, r2(peak / 1000), peak > 0 ? peakAt : null,
        lowest != null ? r2(lowest / 1000) : null, drops, biggestAt != null ? r2(biggest / 1000) : null, upDown,
        firstOn != null ? `${clock(firstOn, o)}–${clock(lastOn!, o)}` : null, inside.length];
    });

    const multi = chosen.length > 1;
    const together = made.reduce((x, v) => x + v, 0);
    if (multi && made.length) facts.total_made_kwh = r1(together);
    if (d === today) notes.unshift(`Today is not over: up to ${clock(now, off)}.`);
    notes.push('Times are on the clock where the panels are. What was made between two times is the system\'s own day counter at the end, less what it said at the start.');
    notes.push("A sharp drop is a fall of a quarter or more of the day's highest power from one reading to the next: a passing cloud, or the inverter cutting out. "
      + 'Up and down adds every rise and fall together, against one smooth rise to the highest and fall back: 1 is smooth.');
    const freshness = await freshnessOf(db, chosen, now);
    const period = { from: day, to: day, label };
    const hourRows = [...hourly.keys()].sort((x, y) => x - y).map((h) => {
      const per = chosen.map((s) => {
        const v = hourly.get(h)!.get(s.id);
        return v?.length ? r2(v.reduce((x, w) => x + w, 0) / v.length / 1000) : null;
      });
      const sum = sumOrNull(per);
      return [`${String(h).padStart(2, '0')}:00`, ...(multi ? [sum != null ? r2(sum) : null] : []), ...per];
    });
    return {
      tool: 'power_day',
      title: 'Power through the day',
      period,
      columns: ['System', 'Made (kWh)', 'Average while making (kW)', 'Highest (kW)', 'Highest at', 'Lowest while making (kW)', 'Sharp drops', 'Biggest drop (kW)', 'Up and down (1 = smooth)', 'Making power', 'Readings'],
      rows,
      facts,
      notes,
      summary: notYet === chosen.length
        ? `It is not yet ${hhmmOf(a)} today where ${multi ? 'the panels are' : `${chosen[0].name} is`}.`
        : `${multi && windowed && made.length === chosen.length ? `Together ${kwh(together)} between ${hhmmOf(a)} and ${hhmmOf(b)} on ${dayWords(day, true)}. ` : ''}${lines.join(' ')}`,
      freshness,
      ...(hourRows.length >= 3 ? {
        sections: [{
          tool: 'power_day', title: 'Hour by hour', period,
          columns: ['Hour', ...(multi ? ['All systems (kW)'] : []), ...chosen.map((s) => `${s.name} (kW)`)],
          rows: hourRows, facts: {}, notes: ["Each hour's average power, from the readings in it."],
          summary: `Average power hour by hour, ${label}.`, freshness,
        }],
      } : {}),
    };
  },
};

// ---------------------------------------------------------------- a chart of any measure

/** What every reading records that can be charted over time, and how each reads. */
const CHART_METRICS = {
  power: { column: 'ac_power_w', words: 'power made', unit: 'kW', per: 1000, sum: true },
  load: { column: 'load_power_w', words: 'house load', unit: 'kW', per: 1000, sum: true },
  grid: { column: 'grid_power_w', words: 'grid power (+ buying, - selling)', unit: 'kW', per: 1000, sum: true },
  battery: { column: 'battery_power_w', words: 'battery power (+ charging, - discharging)', unit: 'kW', per: 1000, sum: true },
  soc: { column: 'battery_soc', words: 'battery charge', unit: '%', per: 1, sum: false },
} as const;
type ChartMetric = keyof typeof CHART_METRICS;
/** Hours of the day, in order, as spans: 0, 1, 2, 18, 19 is "00:00–03:00, 18:00–20:00". */
function hourSpans(hours: number[]): string {
  const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;
  const out: string[] = [];
  for (let i = 0; i < hours.length; i++) {
    let j = i;
    while (j + 1 < hours.length && hours[j + 1] === hours[j] + 1) j++;
    out.push(i === j ? hh(hours[i]) : `${hh(hours[i])}–${hh(hours[j] + 1)}`);
    i = j;
  }
  return out.join(', ');
}
/** A measure's name without its sign note: "grid power", not "grid power (+ buying, - selling)". */
const measureName = (m: ChartMetric) => CHART_METRICS[m].words.replace(/ \(.*\)$/, '');
/** How often a point can be, smallest first. Unasked, a chart takes the smallest that keeps it under CHART_POINTS. */
const BUCKETS = { '15min': 900, hour: 3600, day: DAY, week: 7 * DAY } as const;
const CHART_POINTS = 200;
const MOST_POINTS = 800;
/** Every reading in a chart's period is read: three months at most keeps a question cheap. */
const CHART_DAYS = 93;

const chartTool: Tool = {
  name: 'chart',
  description: 'A chart of any measure every reading records - power made, house load, grid power, battery power or battery charge - over a period, '
    + 'as the average (or highest, or lowest) every 15 minutes, hour, day or week; with a second measure beside it to compare ("PV against load"); '
    + 'or as the average day, hour by hour (profile "hour_of_day": when the load peaks, which hours buy from the grid). Three months at most. '
    + 'For "graph", "chart", "plot", "over the week", "when does the load usually peak". Energy per day, week or month is the energy tool.',
  params: {
    ...periodParams,
    metric: { type: 'string', enum: Object.keys(CHART_METRICS), description: 'What to chart: power (made), load, grid, battery (power) or soc (charge %). Power by default.', optional: true },
    versus: { type: 'string', enum: Object.keys(CHART_METRICS), description: 'A second measure to chart beside the first.', optional: true },
    every: { type: 'string', enum: Object.keys(BUCKETS), description: 'How often a point: 15min, hour, day or week; chosen to suit the period by default. With no period named, a day covers the last 30 days and a week the last 12 weeks.', optional: true },
    stat: { type: 'string', enum: ['average', 'highest', 'lowest'], description: 'Each point as the average (the default), highest or lowest reading in it.', optional: true },
    profile: { type: 'string', enum: ['hour_of_day'], description: 'hour_of_day: the average day across the period (the last 7 days unless named), hour by hour.', optional: true },
    system: systemParam,
  },
  async run({ db, now }, args) {
    const all = await loadSystems(db);
    const chosen = pickSystems(all, args.system);
    const off = zoneOf(all);
    const profile = args.profile === 'hour_of_day';
    // Unless a period is named: the average day across the last seven days, since it needs days to
    // average; a point a day across the last 30 days, and a week across the last twelve; else today.
    const asked = args.range !== undefined || args.from !== undefined || args.to !== undefined;
    const today = dayNo(now, off);
    const p = !asked && args.every === 'week'
      ? resolvePeriod({ from: isoDay(today - 83), to: isoDay(today) }, now, off, DEFAULT_RANGE.chart)
      : resolvePeriod(args, now, off, profile ? 'last_7_days' : args.every === 'day' ? 'last_30_days' : DEFAULT_RANGE.chart);
    const days = noOf(p.to) - noOf(p.from) + 1;
    if (days > CHART_DAYS) throw new ToolError('A chart of readings covers three months at most: for longer, ask for the energy per month.');
    const metrics = [String(args.metric ?? 'power'), ...(args.versus && args.versus !== (args.metric ?? 'power') ? [String(args.versus)] : [])] as ChartMetric[];
    const every: number = profile ? 3600
      : args.every ? BUCKETS[args.every as keyof typeof BUCKETS]
        // The smallest step that keeps the chart under CHART_POINTS: three months of days always does.
        : Math.min(...Object.values(BUCKETS).filter((b) => (days * DAY) / b <= CHART_POINTS));
    if ((days * DAY) / every > MOST_POINTS) throw new ToolError('That is too many points for one chart: ask for a coarser step, or a shorter period.');
    const fn = args.stat === 'highest' ? 'MAX' : args.stat === 'lowest' ? 'MIN' : 'AVG';

    // The database does the work: each system's readings in the period, on their own clocks, in buckets.
    // The columns come from CHART_METRICS alone; nothing asked for is ever written into the query.
    const local = 'ts + COALESCE(tz_offset_sec, ?3)';
    // Weeks run Monday to Sunday, as everywhere here: the clock's day 0 was a Thursday, four days before a Monday.
    const shift = every === BUCKETS.week ? 4 * DAY : 0;
    const bucket = profile ? `CAST(((${local}) % 86400) / 3600 AS INTEGER)` : `CAST((${local} - ${shift}) / ${every} AS INTEGER)`;
    const ids = chosen.map((s) => s.id);
    const { results } = await db.prepare(
      `SELECT inverter_id AS id, ${bucket} AS b,
              ${metrics.map((m, i) => `${fn}(${CHART_METRICS[m].column}) AS v${i}`).join(', ')}
       FROM readings
       WHERE ts BETWEEN ?1 AND ?2 AND ${local} >= ?4 AND ${local} < ?5
         AND inverter_id IN (${ids.map((_, i) => `?${i + 6}`).join(', ')})
       GROUP BY inverter_id, b ORDER BY b`,
    ).bind(noOf(p.from) * DAY - off - DAY, Math.min((noOf(p.to) + 1) * DAY - off + DAY, now), off, noOf(p.from) * DAY, (noOf(p.to) + 1) * DAY, ...ids)
      .all<{ id: string; b: number } & Record<string, number | null>>();

    // Across the systems chosen: power adds up, a battery's charge is averaged.
    const points = new Map<number, (number | null)[]>();
    const counts = new Map<number, number[]>();
    const reporting = metrics.map(() => new Set<string>());
    for (const r of results) {
      const v = points.get(r.b) ?? metrics.map(() => null);
      const c = counts.get(r.b) ?? metrics.map(() => 0);
      metrics.forEach((m, i) => {
        const x = r[`v${i}`];
        if (x == null) return;
        reporting[i].add(r.id);
        v[i] = CHART_METRICS[m].sum ? (v[i] ?? 0) + x : ((v[i] ?? 0) * c[i] + x) / (c[i] + 1);
        c[i]++;
      });
      points.set(r.b, v);
      counts.set(r.b, c);
    }
    // A total is only shown whole. A system that measures something, with readings in a point but none
    // of that measure - SolisCloud's history rows carry power and not the grid - would leave the total
    // short: that point is left out, and said. A system with no readings in a point at all - an inverter
    // asleep at night, or one that stopped reporting - adds nothing, as it makes nothing.
    const short = metrics.map(() => new Map<string, number[]>());
    for (const r of results) {
      metrics.forEach((_, i) => {
        if (r[`v${i}`] != null || !reporting[i].has(r.id)) return;
        const v = points.get(r.b)!;
        if (v[i] == null) return;
        short[i].set(r.id, [...(short[i].get(r.id) ?? []), r.b]);
      });
    }
    short.forEach((bySystem, i) => { for (const bs of bySystem.values()) for (const b of bs) points.get(b)![i] = null; });
    const label = (b: number) => {
      if (profile) return `${String(b).padStart(2, '0')}:00`;
      const start = b * every + shift;
      if (every >= 7 * DAY) return `week of ${dayWords(isoDay(Math.floor(start / DAY)))}`;
      if (every >= DAY) return dayWords(isoDay(Math.floor(start / DAY)), true);
      const hm = clock(start, 0);
      return days === 1 ? hm : `${dayWords(isoDay(Math.floor(start / DAY)))} ${hm}`;
    };
    const show = (m: ChartMetric, v: number | null) => (v == null ? null : CHART_METRICS[m].per === 1 ? Math.round(v) : r2(v / CHART_METRICS[m].per));
    const keys = [...points.keys()].sort((x, y) => x - y);
    const rows = keys.map((b) => [label(b), ...metrics.map((m, i) => show(m, points.get(b)![i]))]);

    const facts: ToolResult['facts'] = { points: rows.length };
    const lines: string[] = [];
    // Said as every other tool says power, in watts under a kilowatt; the table and the chart keep one unit.
    const say = (m: ChartMetric, v: number) => (CHART_METRICS[m].unit === '%' ? `${show(m, v)}%` : kw(v));
    // The period with the word before it: "on Sun 27 Sep 2026", "yesterday (...)", "last week (...)",
    // "over the last 7 days (...)", "over 21 - 27 Sep 2026".
    const during = p.from === p.to
      ? (/^(today|yesterday)/.test(p.label) ? p.label : `on ${p.label}`)
      : /^(this|last) /.test(p.label) ? p.label : `over ${p.label}`;
    // A point with the word before it: "at 14:00", "on 23 Sep 2026 at 19:00", "on Tue 15 Sep 2026",
    // "in the week of 14 Sep 2026".
    const atPoint = (b: number) => {
      if (profile || days === 1) return `at ${label(b)}`;
      if (every < DAY) return `on ${label(b).replace(/ (\d\d:\d\d)$/, ' at $1')}`;
      return `${every < 7 * DAY ? 'on' : 'in the'} ${label(b)}`;
    };
    // Each point its highest or lowest reading, said as such: "the highest power made each day".
    const extreme = !profile && (args.stat === 'highest' || args.stat === 'lowest') ? String(args.stat) : null;
    const each: Record<number, string> = { [BUCKETS['15min']]: 'every 15 minutes', [BUCKETS.hour]: 'each hour', [BUCKETS.day]: 'each day', [BUCKETS.week]: 'each week' };
    // A measure that runs both ways - the grid, the battery - is said by its direction. A battery
    // under 50 W either way is idle, as the dashboard reads it: drift, not a flow.
    const ways: Partial<Record<ChartMetric, [string, string]>> = { grid: ['buying', 'selling'], battery: ['charging', 'discharging'] };
    const idle: Partial<Record<ChartMetric, number>> = { battery: 50 };
    metrics.forEach((m, i) => {
      const got = keys.map((b) => ({ b, v: points.get(b)![i] })).filter((x): x is { b: number; v: number } => x.v != null);
      if (!got.length) return;
      const top = got.reduce((x, y) => (y.v > x.v ? y : x));
      const low = got.reduce((x, y) => (y.v < x.v ? y : x));
      const mean = got.reduce((x, y) => x + y.v, 0) / got.length;
      Object.assign(facts, {
        [`${m}_average`]: show(m, mean), [`${m}_highest`]: show(m, top.v), [`${m}_highest_at`]: label(top.b),
        [`${m}_lowest`]: show(m, low.v), [`${m}_lowest_at`]: label(low.b),
      });
      const name = extreme ? `${extreme} ${measureName(m)} ${each[every]}` : measureName(m);
      const way = ways[m];
      // The average day is only that across more than one day; over one day, it is that day hour by hour.
      const usual = profile && p.from !== p.to;
      // Power made is nothing at night, so its lowest says only that: it is left out.
      const dark = m === 'power' && low.v <= 0;
      if (way) {
        // Which way each point went, and the most each way; on the average day, the hours of each.
        const floor = idle[m] ?? 0;
        const upHours = got.filter((x) => x.v > floor);
        const downHours = got.filter((x) => x.v < -floor);
        Object.assign(facts, { [`${m}_${way[0]}_points`]: upHours.length, [`${m}_${way[1]}_points`]: downHours.length });
        const most = (xs: typeof got, sign: 1 | -1) => (xs.length ? xs.reduce((x, y) => (sign * y.v > sign * x.v ? y : x)) : null);
        const upTop = most(upHours, 1);
        const downTop = most(downHours, -1);
        if (usual) {
          // "you buy from the grid at 00:00-06:00, 18:00-24:00 (most at 19:00, 0.76 kW), and sell to it at ..."
          const [who, up, down] = m === 'grid' ? ['you', 'buy from the grid', 'sell to it'] : ['the battery', 'charges', 'discharges'];
          const when = (xs: typeof got, topX: { b: number; v: number } | null, sign: 1 | -1) =>
            (xs.length ? `at ${hourSpans(xs.map((x) => x.b))} (most at ${label(topX!.b)}, ${say(m, sign * topX!.v)})` : 'at no hour');
          lines.push(`On an average day ${during}, ${who} ${up} ${when(upHours, upTop, 1)}, and ${down} ${when(downHours, downTop, -1)}.`);
        } else {
          lines.push(`The ${name} ${during}: ${way[0]} in ${upHours.length} of ${got.length} points${upTop ? `, at most ${say(m, upTop.v)} ${atPoint(upTop.b)}` : ''}; `
            + `${way[1]} in ${downHours.length}${downTop ? `, at most ${say(m, -downTop.v)} ${atPoint(downTop.b)}` : ''}.`);
        }
      } else {
        lines.push(usual
          ? `On an average day ${during}, the ${name} is highest at ${label(top.b)} (${say(m, top.v)})${dark ? '' : ` and lowest at ${label(low.b)} (${say(m, low.v)})`}, ${say(m, mean)} on average.`
          : `The ${name} ${during}: ${say(m, mean)} on average; highest ${say(m, top.v)} ${atPoint(top.b)}${dark ? '' : `, lowest ${say(m, low.v)} ${atPoint(low.b)}`}.`);
      }
    });
    // Two measures side by side: how often the first was the higher.
    if (metrics.length === 2) {
      const both = keys.map((b) => points.get(b)!).filter((v) => v[0] != null && v[1] != null);
      const above = both.filter((v) => (v[0] as number) > (v[1] as number)).length;
      facts[`${metrics[0]}_above_${metrics[1]}_points`] = above;
      if (both.length) lines.push(`The ${measureName(metrics[0])} was above the ${measureName(metrics[1])} in ${above} of ${both.length} points.`);
    }

    const notes: string[] = [];
    metrics.forEach((m, i) => {
      // A system with none: one that never measures it, or one silent the whole time.
      const silent = chosen.filter((s) => !reporting[i].has(s.id));
      if (silent.length && silent.length < chosen.length) {
        notes.push(`${inWords(silent.map((s) => s.name))} ${silent.length === 1 ? 'has' : 'have'} no readings of the ${measureName(m)} in that time.`);
      }
      // The points left out, by the system whose missing measure would have left the total short.
      for (const [id, bs] of short[i]) {
        const first = bs.slice(0, 3).map(label);
        notes.push(`${chosen.find((s) => s.id === id)!.name} has readings but none of the ${measureName(m)} at ${inWords(bs.length > 3 ? [...first, `${bs.length - 3} more`] : first)}: `
          + `the total there is left out, rather than shown short.`);
      }
      const out = new Set([...short[i].values()].flat());
      if (out.size) facts[`${m}_points_left_out`] = out.size;
    });
    if (metrics.includes('grid')) notes.push('Grid power is above zero while buying from the grid, and below zero while selling to it.');
    if (metrics.includes('battery')) notes.push('Battery power is above zero while charging, and below zero while discharging.');
    if (chosen.length > 1) notes.push(`Each point adds the systems together${metrics.includes('soc') ? ", but for a battery's charge, which is their average" : ''}.`);
    notes.push(`Times are on the clock where the panels are. Each point is the ${args.stat === 'highest' ? 'highest' : args.stat === 'lowest' ? 'lowest' : 'average'} reading in it.`);
    const who = chosen.length === 1 ? `, ${chosen[0].name}` : '';
    const named = `${extreme ? `${extreme} ` : ''}${metrics.map(measureName).join(' and ')}`;
    const title = `${named[0].toUpperCase()}${named.slice(1)}`
      + `${profile && p.from !== p.to ? ', on an average day' : profile ? ', hour by hour' : every >= 7 * DAY ? ', week by week' : every >= DAY ? ', day by day' : every >= 3600 ? ', hour by hour' : ', every 15 minutes'}${who}`;
    return {
      tool: 'chart',
      title,
      period: p,
      columns: [profile ? 'Hour' : every >= DAY ? 'Day' : 'Time', ...metrics.map((m) => {
        const w = measureName(m);
        return `${w[0].toUpperCase()}${w.slice(1)} (${CHART_METRICS[m].unit})`;
      })],
      rows,
      facts,
      notes,
      summary: lines.length ? lines.join(' ') : `There are no readings of the ${metrics.map(measureName).join(' or ')} ${during}.`,
      freshness: await freshnessOf(db, chosen, now),
      chart: { kind: every >= DAY && metrics.length === 1 && !profile ? 'bar' : 'line', columns: metrics.map((_, i) => i + 1) },
    };
  },
};

// ---------------------------------------------------------------- what the inverter shows

/** A device record's JSON, or null. */
function jsonOf<T>(s: string | null | undefined): T | null {
  try { return s ? (JSON.parse(s) as T) : null; } catch { return null; }
}
/** A device record older than this is said as "as last read". */
const DEVICE_FRESH_S = 2 * 3600;
/** A producing string under this share of the best string's power is weak. */
const WEAK_STRING = 0.5;
/** A PV string or an AC phase, as a device record holds it. */
type Part = { index: number; voltageV?: number | null; currentA?: number | null; powerW?: number | null };
/**
 * The strings against each other: those making power (over 20 W), the best of
 * them, and any making under half of the best while it is - shade, dirt, or a
 * fault on that string. A string with no voltage is unused, not weak.
 */
function weakStrings(strings: Part[]): { producing: Part[]; best: Part | null; weak: Part[] } {
  const producing = strings.filter((x) => (x.powerW ?? 0) > 20);
  const best = producing.reduce<Part | null>((x, y) => (!x || (y.powerW ?? 0) > (x.powerW ?? 0) ? y : x), null);
  const weak = best ? strings.filter((x) => x !== best && (x.voltageV ?? 0) > 0 && (x.powerW ?? 0) < (best.powerW ?? 0) * WEAK_STRING) : [];
  return { producing, best, weak };
}
/** The battery's own readings, in the order and words they are shown. */
const BATTERY_READINGS: [string, string][] = [
  ['voltageV', 'Voltage (V)'], ['currentA', 'Current (A)'], ['tempC', 'Temperature (°C)'], ['status', 'State'],
  ['bmsSocPct', 'BMS charge (%)'], ['bmsVoltageV', 'BMS voltage (V)'], ['bmsCurrentA', 'BMS current (A)'], ['bmsTempC', 'BMS temperature (°C)'],
  ['chargeLimitA', 'Charge limit (A)'], ['dischargeLimitA', 'Discharge limit (A)'], ['bmsChargeVoltageV', 'Charge voltage (V)'],
  ['bmsDischargeVoltageV', 'Discharge voltage (V)'], ['ratedCapacityAh', 'Capacity (Ah)'], ['nominalVoltageV', 'Nominal voltage (V)'], ['chemistry', 'Chemistry'],
];

const inverterTool: Tool = {
  name: 'inverter',
  description: "What each inverter itself reports, from its latest device record: each PV string's voltage, current and power, each AC phase's voltage and current, "
    + "the grid's frequency, the power factor, the inverter's temperature, the DC bus, and the battery's own readings - voltage, current, temperature, the BMS. "
    + 'Compares the strings, and says when one is making far less than the others. Only the latest values are kept, not their history. '
    + 'For "PV1 voltage", "string current", "grid frequency", "battery voltage", "inverter temperature", "is a string down". '
    + 'part narrows the answer to the strings, the grid side, the battery or the temperature; every reading is in the table either way.',
  params: {
    system: systemParam,
    part: { type: 'string', enum: ['strings', 'grid', 'battery', 'temperature', 'all'], description: 'What the question is about: strings, grid, battery, temperature, or all (the default).', optional: true },
  },
  async run({ db, now }, args) {
    const all = await loadSystems(db);
    const chosen = pickSystems(all, args.system);
    const off = zoneOf(all);
    const { results: devices } = await db.prepare(
      `SELECT i.id AS inverter_id, d.status, d.last_seen, d.strings, d.ac_phases, d.frequency_hz, d.power_factor, d.temp_c, d.dc_bus_v, d.battery
       FROM devices d JOIN inverters i ON i.plant_id = d.plant_id AND i.provider = d.provider WHERE d.kind = 'inverter'`,
    ).all<{
      inverter_id: string; status: string | null; last_seen: number | null; strings: string | null; ac_phases: string | null;
      frequency_hz: number | null; power_factor: number | null; temp_c: number | null; dc_bus_v: number | null; battery: string | null;
    }>();

    const facts: ToolResult['facts'] = {};
    const lines: string[] = [];
    const notes: string[] = ['These are the inverter\'s latest readings: SolarLens keeps them as last read, not through the day.'];
    const rows: (string | number | null)[][] = [];
    const bms: (string | number | null)[][] = [];
    for (const s of chosen) {
      const o = s.off ?? off;
      const k = chosen.length === 1 ? '' : `${s.alias}_`;
      const d = devices.find((x) => x.inverter_id === s.id);
      if (!d) {
        lines.push(`${s.name} has no inverter record: its vendor has not sent one.`);
        continue;
      }
      const strings = jsonOf<Part[]>(d.strings) ?? [];
      const phases = jsonOf<Part[]>(d.ac_phases) ?? [];
      const battery = jsonOf<Record<string, number | string | null>>(d.battery);
      for (const x of strings) rows.push([s.name, `PV${x.index}`, x.voltageV ?? null, x.currentA ?? null, x.powerW ?? null]);
      for (const x of phases) rows.push([s.name, phases.length > 1 ? `Phase L${x.index}` : 'Grid (AC)', x.voltageV ?? null, x.currentA ?? null, null]);
      if (battery) for (const [key, words] of BATTERY_READINGS) if (battery[key] != null) bms.push([s.name, words, battery[key]]);

      const fresh = !!d.last_seen && now - d.last_seen <= DEVICE_FRESH_S;
      const when = fresh ? 'now' : d.last_seen ? `as last read, ${at(d.last_seen, o)}` : 'as last read';
      const v = (x: number | null | undefined, unit: string) => (x == null ? null : `${r1(x)} ${unit}`);
      const partWords = (x: Part) => [v(x.voltageV, 'V'), v(x.currentA, 'A'), x.powerW != null ? `${Math.round(x.powerW)} W` : null].filter(Boolean).join(', ');
      // Each part in its own words, so an answer can say only what was asked.
      const part = String(args.part ?? 'all');
      const clauses: Record<string, string | null> = {
        strings: strings.length ? strings.map((x) => `PV${x.index} ${partWords(x)}`).join('; ') : null,
        grid: phases.length || d.frequency_hz != null || d.power_factor
          ? [phases.length ? `the grid ${phases.map((x) => `${phases.length > 1 ? `L${x.index} ` : ''}${v(x.voltageV, 'V') ?? '-'}`).join(', ')}` : 'the grid',
            d.frequency_hz != null ? ` at ${r2(d.frequency_hz)} Hz` : '',
            // A power factor of 0 is an inverter asleep, not a reading.
            d.power_factor ? `, power factor ${r2(d.power_factor)}` : ''].join('')
          : null,
        temperature: d.temp_c != null ? `the inverter at ${r1(d.temp_c)} °C` : null,
        dcbus: d.dc_bus_v != null ? `the DC bus at ${r1(d.dc_bus_v)} V` : null,
      };
      const shown = part === 'all' ? Object.values(clauses) : part === 'battery' ? [] : [clauses[part]];
      const bits = shown.filter((x): x is string => !!x);
      let said = part === 'battery' ? '' : `${s.name}'s inverter, ${when}: ${bits.join('; ') || `no ${part === 'all' ? 'readings of its own' : `${part} readings`}`}.`;
      if (battery && (part === 'all' || part === 'battery')) {
        const flow = typeof battery.currentA === 'number' ? (battery.currentA < 0 ? ' (discharging)' : battery.currentA > 0 ? ' (charging)' : '') : '';
        const parts = [v(battery.voltageV as number, 'V'), battery.currentA != null ? `${r2(battery.currentA as number)} A${flow}` : null, v(battery.tempC as number, '°C')].filter(Boolean);
        said += `${said ? ' ' : ''}${part === 'battery' ? `${s.name}'s battery, ${when}` : 'Its battery'}: ${parts.join(', ')}${battery.bmsSocPct != null ? `; the BMS says ${Math.round(battery.bmsSocPct as number)}%` : ''}.`;
      } else if (part === 'battery') said = `${s.name} reports no battery readings of its own.`;
      // The strings against each other: one producing far less than the best, while the inverter is producing.
      const { producing, best, weak } = weakStrings(strings);
      if (fresh && best && weak.length) {
        said += ` ${inWords(weak.map((x) => `PV${x.index}`))} ${weak.length === 1 ? 'is' : 'are'} making far less than PV${best.index} `
          + `(${weak.map((x) => `${Math.round(x.powerW ?? 0)} W`).join(', ')} against ${Math.round(best.powerW ?? 0)} W): shade, dirt, or a fault on ${weak.length === 1 ? 'that string' : 'those strings'}.`;
        facts[`${k}weak_strings`] = weak.map((x) => `PV${x.index}`).join(', ');
      } else if (part === 'strings' && strings.length > 1) {
        // Asked about the strings: say whether they can be compared, and if so that they are even.
        said += !fresh ? ' Those are old readings, so they say nothing of the strings now.'
          : !producing.length ? ' No string is producing at the moment, so they cannot be compared.'
            : ' The strings are even: none is making far less than the others.';
      }
      Object.assign(facts, {
        [`${k}strings`]: strings.length,
        [`${k}frequency_hz`]: d.frequency_hz != null ? r2(d.frequency_hz) : null,
        [`${k}inverter_temp_c`]: d.temp_c != null ? r1(d.temp_c) : null,
        [`${k}dc_bus_v`]: d.dc_bus_v != null ? r1(d.dc_bus_v) : null,
        [`${k}read_at`]: d.last_seen ? at(d.last_seen, o) : null,
        ...(battery ? { [`${k}battery_voltage_v`]: typeof battery.voltageV === 'number' ? r2(battery.voltageV) : null, [`${k}bms_soc_pct`]: typeof battery.bmsSocPct === 'number' ? Math.round(battery.bmsSocPct) : null } : {}),
      });
      lines.push(said);
    }
    const freshness = await freshnessOf(db, chosen, now);
    return {
      tool: 'inverter',
      title: 'What the inverter shows',
      period: null,
      columns: ['System', 'Part', 'Voltage (V)', 'Current (A)', 'Power (W)'],
      rows,
      facts,
      notes,
      summary: lines.join(' '),
      freshness,
      ...(bms.length ? { sections: [{ tool: 'inverter', title: "The battery's own readings", period: null, columns: ['System', 'Reading', 'Value'], rows: bms, facts: {}, notes: [], summary: 'As the battery management system last reported them.', freshness }] } : {}),
    };
  },
};

// ---------------------------------------------------------------- the battery

const batteryTool: Tool = {
  name: 'battery',
  description: "A battery's charge now, and over a period each day's lowest and highest charge and what the battery took in and gave out - "
    + 'the last 7 days unless one is named. For "battery percentage", "how much did the battery charge", "did the battery run low".',
  params: { ...periodParams, system: systemParam },
  async run({ db, now }, args) {
    const all = await loadSystems(db);
    const chosen = pickSystems(all, args.system);
    const off = zoneOf(all);
    const p = resolvePeriod(args, now, off, DEFAULT_RANGE.battery);
    const [live, days] = await Promise.all([latest(db), dayRows(db, chosen, p, off)]);
    // A system has a battery when it reports a charge, now or on any day of the period.
    const withBattery = chosen.filter((s) => live.find((r) => r.id === s.id)?.battery_soc != null
      || days.some((d) => d.inverter_id === s.id && (d.soc_max != null || d.batt_charge_kwh != null)));

    const facts: ToolResult['facts'] = {};
    const lines: string[] = [];
    const rows: (string | number | null)[][] = [];
    for (const s of withBattery) {
      const o = s.off ?? off;
      const k = withBattery.length === 1 ? '' : `${s.alias}_`;
      const r = live.find((x) => x.id === s.id);
      const on = !!r?.ts && now - r.ts <= STALE_AFTER_S && r.status !== 'offline';
      const mine = days.filter((d) => d.inverter_id === s.id).sort((x, y) => x.day.localeCompare(y.day));
      for (const d of mine) {
        rows.push([s.name, dayWords(d.day, true), d.batt_charge_kwh != null ? r1(d.batt_charge_kwh) : null, d.batt_discharge_kwh != null ? r1(d.batt_discharge_kwh) : null,
          d.soc_min != null ? Math.round(d.soc_min) : null, d.soc_max != null ? Math.round(d.soc_max) : null]);
      }
      const charged = sumOrNull(mine.map((d) => d.batt_charge_kwh));
      const discharged = sumOrNull(mine.map((d) => d.batt_discharge_kwh));
      const lowest = mine.filter((d) => d.soc_min != null).reduce<DayRow | null>((x, d) => (!x || (d.soc_min as number) < (x.soc_min as number) ? d : x), null);
      const highs = mine.filter((d) => d.soc_max != null).map((d) => d.soc_max as number);
      const highest = highs.length ? Math.round(Math.max(...highs)) : null;
      const nowPct = r?.battery_soc != null ? Math.round(r.battery_soc) : null;
      Object.assign(facts, {
        [`${k}charge_now_pct`]: nowPct,
        [`${k}charged_kwh`]: charged != null ? r1(charged) : null,
        [`${k}discharged_kwh`]: discharged != null ? r1(discharged) : null,
        [`${k}lowest_pct`]: lowest ? Math.round(lowest.soc_min as number) : null,
        [`${k}lowest_day`]: lowest ? dayWords(lowest.day, true) : null,
        [`${k}highest_pct`]: highest,
      });
      let said = nowPct == null ? `${s.name}'s battery has no charge reading.`
        : on ? `${s.name}'s battery is at ${nowPct}% now.` : `${s.name}'s battery was at ${nowPct}% at its last reading, ${at(r!.ts!, o)}.`;
      const parts: string[] = [];
      if (charged != null || discharged != null) parts.push(`it took in ${kwh(charged ?? 0)} and gave out ${kwh(discharged ?? 0)}`);
      const oneDay = p.from === p.to;
      if (lowest && highest != null) parts.push(`its charge went from ${Math.round(lowest.soc_min as number)}% at its lowest${oneDay ? '' : `, on ${dayWords(lowest.day, true)},`} to ${highest}% at its highest`);
      // "Yesterday (Sun 27 Sep 2026), it took in...", "Over the last 7 days (...), it took in...".
      const over = oneDay ? p.label[0].toUpperCase() + p.label.slice(1) : `Over ${p.label}`;
      said += parts.length ? ` ${over}, ${parts.join(', and ')}.` : ` There is no record of it ${oneDay ? 'on' : 'over'} ${p.label}.`;
      lines.push(said);
    }
    return {
      tool: 'battery',
      title: 'The battery',
      period: p,
      columns: ['System', 'Day', 'Charged (kWh)', 'Discharged (kWh)', 'Lowest charge (%)', 'Highest charge (%)'],
      rows,
      facts,
      notes: ["What the battery took in and gave out is the inverter's own day counter for it, where it reports one; its charge is the state of charge the inverter reports."],
      summary: withBattery.length ? lines.join(' ') : `${chosen.length === 1 ? `${chosen[0].name} reports no battery` : 'None of your systems reports a battery'}.`,
      freshness: await freshnessOf(db, chosen, now),
    };
  },
};

// ---------------------------------------------------------------- outages

/** Sunlight above this, W/m2, is day: a system silent then has stopped, not gone to sleep. */
const DAYLIGHT_WM2 = 100;
/** A day and a time on a plant's clock: "Sun 27 Sep 2026 19:10". */
const at = (ts: number, off: number) => `${dayWords(isoDay(dayNo(ts, off)), true)} ${clock(ts, off)}`;

const outages: Tool = {
  name: 'outages',
  description: 'When each system stopped reporting and when it came back: whether it is reporting now and since when not, the last time it made power, '
    + 'and each stretch of daylight with no readings over a period - the last 7 days unless one is named, a month at most. Silence at night is not counted. '
    + "Says why, where something else reports it: the plant's datalogger offline, or for SolisCloud the relay silent or its login run out - and when the relay's login runs out. "
    + 'For "since when is it offline", "is it online", "when did it stop working", "when did it last generate", "when does the Solis login expire".',
  params: { ...periodParams, system: systemParam },
  async run({ db, now }, args) {
    const all = await loadSystems(db);
    const chosen = pickSystems(all, args.system);
    const off = zoneOf(all);
    const p = resolvePeriod(args, now, off, DEFAULT_RANGE.outages);
    if (noOf(p.to) - noOf(p.from) > 31) throw new ToolError('Ask about a month at most: every reading in it is looked at.');
    // The period, and a day either side for plants on other clocks than the first.
    const from = noOf(p.from) * DAY - off - DAY;
    const until = Math.min((noOf(p.to) + 1) * DAY - off + DAY, now);
    const [live, points, weather, relays, loggers] = await Promise.all([
      latest(db), series(db, from, until), weatherSince(db, from),
      // What can tell why a system went quiet: the relays' own reports, and each plant's datalogger.
      listRelays(db, now - 30 * DAY),
      db.prepare(
        `SELECT i.id AS inverter_id, d.status, d.last_seen FROM devices d
         JOIN inverters i ON i.plant_id = d.plant_id AND i.provider = d.provider WHERE d.kind = 'datalogger'`,
      ).all<{ inverter_id: string; status: string | null; last_seen: number | null }>().then((x) => x.results),
    ]);

    const facts: ToolResult['facts'] = {};
    const lines: string[] = [];
    const rows: { ts: number; row: (string | number | null)[] }[] = [];
    for (const s of chosen) {
      const o = s.off ?? off;
      const k = chosen.length === 1 ? '' : `${s.alias}_`;
      const r = live.find((x) => x.id === s.id);
      const on = !!r?.ts && now - r.ts <= STALE_AFTER_S && r.status !== 'offline';
      const seen = points.filter((x) => x.inverter_id === s.id);
      // Daylight at a moment: the sunlight at the system's position that hour, or 07:00-17:00 where there is none.
      const sun = new Map(weather.filter((w) => w.inverter_id === s.id && w.ghi_wm2 != null).map((w) => [w.ts, w.ghi_wm2 as number]));
      const light = (ts: number) => {
        const ghi = sun.get(Math.floor(ts / 3600) * 3600 + 3600);
        if (ghi != null) return ghi >= DAYLIGHT_WM2;
        const m = ((((ts + o) % DAY) + DAY) % DAY) / 60;
        return m >= 7 * 60 && m < 17 * 60;
      };
      const periodStart = noOf(p.from) * DAY - o;
      const periodEnd = Math.min((noOf(p.to) + 1) * DAY - o, now);
      const daylightIn = (x: number, y: number) => {
        let lit = 0;
        for (let t = Math.max(x, periodStart); t < Math.min(y, periodEnd); t += 300) if (light(t)) lit += Math.min(300, Math.min(y, periodEnd) - t);
        return lit;
      };
      // Each silence longer than GAP_S; it counts when it takes more than that of daylight. One through a night is one.
      const times = seen.map((x) => x.ts);
      const lastSeen = times.length ? times[times.length - 1] : r?.ts ?? null;
      const silences: [number, number | null][] = [];
      for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] > GAP_S) silences.push([times[i - 1], times[i]]);
      if (!on && lastSeen != null && now - lastSeen > GAP_S) silences.push([lastSeen, null]);
      const found = silences
        .map(([x, y]) => ({ from: x, to: y, lit: daylightIn(x, y ?? now) }))
        .filter((g) => g.lit > GAP_S);
      const lost = found.reduce((x, g) => x + g.lit, 0);
      const longest = found.reduce<typeof found[number] | null>((x, g) => (!x || g.lit > x.lit ? g : x), null);
      for (const g of found) rows.push({ ts: g.from, row: [s.name, at(g.from, o), g.to ? at(g.to, o) : 'not yet', duration(g.lit)] });

      const powered = seen.filter((x) => (x.ac_power_w ?? 0) > 0);
      const lastPower = powered.length ? { ts: powered[powered.length - 1].ts, w: powered[powered.length - 1].ac_power_w ?? 0 }
        : r?.ts && (r.ac_power_w ?? 0) > 0 ? { ts: r.ts, w: r.ac_power_w ?? 0 } : null;
      Object.assign(facts, {
        [`${k}reporting_now`]: on ? 'yes' : 'no',
        [`${k}last_reading`]: r?.ts ? at(r.ts, o) : null,
        [`${k}quiet_since`]: !on && lastSeen != null ? at(lastSeen, o) : null,
        [`${k}last_power_at`]: lastPower ? at(lastPower.ts, o) : null,
        [`${k}last_power_kw`]: lastPower ? r2(lastPower.w / 1000) : null,
        [`${k}outages`]: found.length,
        [`${k}daylight_without_readings`]: found.length ? duration(lost) : null,
      });

      let said: string;
      if (lastSeen == null) said = `${s.name} has not reported at all.`;
      else if (on) {
        said = `${s.name} is reporting now (last reading ${clock(lastSeen, o)}).`;
        // A relay-fed system's figures last only as long as the relay's login: say how long that is.
        const login = s.provider === 'soliscloud' ? relays.filter((x) => x.provider === 'soliscloud' && x.login_expires_at).sort((x, y) => y.last_seen - x.last_seen)[0]?.login_expires_at : null;
        if (login) said += login > now ? ` Its relay's SolisCloud login is good until ${at(login, o)}.` : ` Its relay's SolisCloud login ran out on ${at(login, o)}: renew it with renew-solis-login.cmd.`;
      }
      else {
        const darkThen = !light(lastSeen);
        const darkNow = !light(now);
        const battery = r?.battery_soc != null;
        said = `${s.name} has not reported since ${at(lastSeen, o)}, ${duration(now - lastSeen)} ago`;
        if (darkThen && darkNow && !battery) said += ': it went quiet after dark, when an inverter without a battery switches off, so this is expected until sunrise.';
        else {
          said += darkThen ? ', after dark, and it has not come back' : ', in daylight';
          // Why, from what else reports: the plant's datalogger, and for SolisCloud the relay that fetches its figures.
          const causes: string[] = [];
          const logger = loggers.find((x) => x.inverter_id === s.id);
          if (logger?.status === 'offline' && logger.last_seen) {
            causes.push(`its datalogger has been offline since ${at(logger.last_seen, o)}, so the vendor has nothing new to send: check the datalogger's Wi-Fi and power at the site`);
          }
          if (s.provider === 'soliscloud') {
            const relay = relays.filter((x) => x.provider === 'soliscloud').sort((x, y) => y.last_seen - x.last_seen)[0];
            if (relay && now - relay.last_seen <= STALE_AFTER_S) {
              causes.push(`the relay is running - it last reported at ${clock(relay.last_seen, o)}${relay.login_expires_at && relay.login_expires_at > now ? `, and its SolisCloud login is good until ${at(relay.login_expires_at, o)}` : ''} - so the relay laptop is not the cause`);
            } else if (relay?.login_expires_at && relay.login_expires_at <= now) {
              causes.push(`the relay's SolisCloud login ran out on ${at(relay.login_expires_at, o)}: renew it with renew-solis-login.cmd on the relay laptop`);
            } else {
              causes.push(`no relay has reported${relay ? ` since ${at(relay.last_seen, o)}` : ''}: check the relay laptop is on`
                + (relay?.login_expires_at ? ` - its SolisCloud login is good until ${at(relay.login_expires_at, o)}` : ' and its SolisCloud login is current (Devices tab)'));
            }
          } else if (!causes.length) causes.push('the vendor may be down, or the logger may have lost its network');
          said += `. ${causes.map((c) => c[0].toUpperCase() + c.slice(1)).join('. ')}.`;
          Object.assign(facts, {
            [`${k}datalogger`]: logger?.status ?? null,
            [`${k}datalogger_last_seen`]: logger?.last_seen ? at(logger.last_seen, o) : null,
          });
        }
      }
      said += lastPower ? ` It last made power at ${at(lastPower.ts, o)} (${kw(lastPower.w)}).` : ` It made no power in ${p.label}.`;
      said += found.length
        ? ` In ${p.label} it went quiet in daylight ${found.length === 1 ? 'once' : `${found.length} times`}, ${duration(lost)} of daylight in all${found.length > 1 && longest ? `; the longest from ${at(longest.from, o)} to ${longest.to ? at(longest.to, o) : 'now'}` : ''}.`
        : ` In ${p.label} it never went quiet in daylight.`;
      lines.push(said);
    }

    const shown = rows.sort((x, y) => y.ts - x.ts).slice(0, 20).map((x) => x.row);
    const notes = [
      'A stretch counts when a system sends nothing for more than 30 minutes of daylight - by the sunlight at its position, or 07:00 to 17:00 where there is no weather yet. Silence at night is not counted.',
      'Times are on the clock where the panels are.',
    ];
    if (rows.length > 20) notes.push(`The 20 most recent of ${rows.length} are listed.`);
    return {
      tool: 'outages',
      title: 'Outages',
      period: p,
      columns: ['System', 'Went quiet', 'Came back', 'Daylight without readings'],
      rows: shown,
      facts,
      notes,
      summary: lines.join(' '),
      freshness: await freshnessOf(db, chosen, now),
    };
  },
};

// ---------------------------------------------------------------- stats

const statsTool: Tool = {
  name: 'stats',
  description: "Statistics of each system's daily energy over a period, from whole days: days recorded, their total, the average and median day, the best and worst day, "
    + 'how much days vary, kWh per kWp, capacity factor, low days, and the average day against the same length of time just before - and, when asked, how many days '
    + 'made more (above) or less (below) than an amount. For "statistics", "average day", "how consistent", "how many days above 50 kWh".',
  params: {
    ...periodParams,
    system: systemParam,
    above: { type: 'integer', min: 0, max: 100000, description: 'Count the whole days that made more than this many kWh.', optional: true },
    below: { type: 'integer', min: 0, max: 100000, description: 'Count the whole days that made less than this many kWh.', optional: true },
  },
  async run({ db, now }, args) {
    const all = await loadSystems(db);
    const chosen = pickSystems(all, args.system);
    const off = zoneOf(all);
    const p = resolvePeriod(args, now, off, DEFAULT_RANGE.stats);
    // Whole days only: today is still being made.
    const today = isoDay(dayNo(now, off));
    const full: Period = { ...p, to: p.to === today ? isoDay(noOf(today) - 1) : p.to };
    if (full.to < full.from) throw new ToolError('Statistics need at least one whole day: ask about a period that has ended.');
    const span = noOf(full.to) - noOf(full.from) + 1;
    const before: Period = { from: isoDay(noOf(full.from) - span), to: isoDay(noOf(full.from) - 1), label: '' };
    const [rows, prev] = await Promise.all([dayRows(db, chosen, full, off), dayRows(db, chosen, before, off)]);

    const facts: ToolResult['facts'] = {};
    const lines: string[] = [];
    const partial: string[] = [];
    // A day with too few readings to be whole - a system's first evening, a relay
    // off for most of it - says nothing of a usual day: it is left out, and named.
    const whole = (r: DayRow) => r.yield_kwh != null && r.samples >= MIN_SAMPLES;
    const table = chosen.map((s) => {
      const part = rows.filter((r) => r.inverter_id === s.id && r.yield_kwh != null && !whole(r)).map((r) => r.day).sort();
      if (part.length) partial.push(`${s.name}: ${someDays(part)}`);
      const days = rows.filter((r) => r.inverter_id === s.id && whole(r))
        .map((r) => ({ day: r.day, kwh: r.yield_kwh as number })).sort((a, b) => a.day.localeCompare(b.day));
      const k = chosen.length === 1 ? '' : `${s.alias}_`;
      if (!days.length) {
        lines.push(`${s.name}: no whole day recorded.`);
        return [s.name, 0, null, null, null, null, null, null, null, null, null, null];
      }
      const n = days.length;
      const total = days.reduce((a, d) => a + d.kwh, 0);
      const mean = total / n;
      const mid = median(days.map((d) => d.kwh));
      const best = days.reduce((b, d) => (d.kwh > b.kwh ? d : b));
      const worst = days.reduce((b, d) => (d.kwh < b.kwh ? d : b));
      const spread = Math.sqrt(days.reduce((a, d) => a + (d.kwh - mean) ** 2, 0) / n);
      const perKwp = s.kwp ? total / s.kwp : null;
      const cf = s.kwp ? (total / (s.kwp * 24 * n)) * 100 : null;
      const low = days.filter((d) => d.kwh < 0.5 * mid).length;
      // The average whole day against the days before: a total would count the days each period happened to record.
      const earlier = prev.filter((r) => r.inverter_id === s.id && whole(r));
      const prevMean = earlier.length ? earlier.reduce((a, r) => a + (r.yield_kwh as number), 0) / earlier.length : 0;
      const change = prevMean > 0 ? Math.round((mean / prevMean - 1) * 100) : null;
      Object.assign(facts, {
        [`${k}days`]: n, [`${k}total_kwh`]: r1(total), [`${k}average_kwh`]: r1(mean), [`${k}median_kwh`]: r1(mid),
        [`${k}best_day`]: dayWords(best.day, true), [`${k}best_kwh`]: r1(best.kwh),
        [`${k}worst_day`]: dayWords(worst.day, true), [`${k}worst_kwh`]: r1(worst.kwh),
        [`${k}spread_kwh`]: r1(spread), [`${k}kwh_per_kwp`]: perKwp != null ? r1(perKwp) : null,
        [`${k}capacity_factor_pct`]: cf != null ? r1(cf) : null, [`${k}low_days`]: low, [`${k}change_pct`]: change,
      });
      // Days over or under an amount, when the question names one: "how many days above 50 kWh".
      const counted: string[] = [];
      for (const [side, limit] of [['above', args.above], ['below', args.below]] as const) {
        if (limit === undefined) continue;
        const hits = days.filter((d) => (side === 'above' ? d.kwh > Number(limit) : d.kwh < Number(limit)));
        facts[`${k}days_${side}_${limit}_kwh`] = hits.length;
        counted.push(`${side === 'above' ? 'more' : 'less'} than ${limit} kWh on ${hits.length} of its ${n} whole day${n === 1 ? '' : 's'}`
          + `${hits.length && hits.length <= 5 ? ` (${hits.map((d) => dayWords(d.day, true)).join(', ')})` : ''}`);
      }
      lines.push(`${s.name}: ${n} day${n === 1 ? '' : 's'}, ${kwh(total)} - ${kwh(mean)} on an average day (median ${r1(mid)}); `
        + `${counted.length ? `${counted.join('; ')}; ` : ''}`
        + `best ${dayWords(best.day, true)} with ${kwh(best.kwh)}, worst ${dayWords(worst.day, true)} with ${kwh(worst.kwh)}`
        + `${perKwp != null ? `; ${r1(perKwp)} kWh per kWp, capacity factor ${r1(cf!)}%` : ''}`
        + `${low ? `; ${low} low day${low === 1 ? '' : 's'}` : ''}`
        + `${change != null ? `; ${Math.abs(change)}% ${change >= 0 ? 'more' : 'less'} a day than in the ${span} days before` : ''}.`);
      return [s.name, n, r1(total), r1(mean), r1(mid), `${dayWords(best.day, true)}: ${r1(best.kwh)}`, `${dayWords(worst.day, true)}: ${r1(worst.kwh)}`,
        r1(spread), perKwp != null ? r1(perKwp) : null, cf != null ? r1(cf) : null, low, change];
    });
    const notes = ['Capacity factor is the energy made against the panels running at their full size all day, every day. A low day is under half the median day.'];
    if (partial.length) notes.unshift(`Left out, with too few readings to be whole days (under ${MIN_SAMPLES}): ${partial.join('; ')}.`);
    if (p.to === today) notes.unshift('Today is left out: it is not over yet.');
    return {
      tool: 'stats',
      title: 'Statistics, day by day',
      period: { from: full.from, to: full.to, label: p.to === today ? `${p.label}, to yesterday` : p.label },
      columns: ['System', 'Whole days', 'Total (kWh)', 'Average day (kWh)', 'Median day (kWh)', 'Best day (kWh)', 'Worst day (kWh)', 'Spread (kWh)', 'kWh per kWp', 'Capacity factor (%)', 'Low days', 'Average day against before (%)'],
      rows: table,
      facts,
      notes,
      summary: lines.join(' '),
      freshness: await freshnessOf(db, chosen, now),
    };
  },
};

// ---------------------------------------------------------------- analysis

/** The longest period an analysis reads, and the longest it compares with as many days before. */
const ANALYSIS_DAYS = 366;
const COMPARED_DAYS = 92;
/** The weeks the health verdict looks back over, as the Monday health check does. */
const HEALTH_WEEKS = 12;
/** The day's pattern, hour by hour, is read from every reading of at most this many of the period's last days. */
const PATTERN_DAYS = 30;
/** A system this far below the best per kWp on an average day, %, is worth knowing; this far, worth a look. */
const PER_KWP_KNOW_PCT = 15;
const PER_KWP_LOOK_PCT = 25;
/** An average day this far above or below the days before, %, is worth saying why. */
const CHANGE_PCT = 10;
/** A day under this share of the median day is low enough to explain. */
const LOW_DAY_SHARE = 0.7;
/** A battery that never fell below this charge, %, was kept full; at or below RAN_LOW_PCT it ran low; at FULL_PCT, full. */
const KEPT_FULL_PCT = 80;
const RAN_LOW_PCT = 20;
const FULL_PCT = 98;
/** An always-on load this large, W, and this share of what the house uses, is worth finding. */
const STANDBY_W = 150;
const STANDBY_SHARE = 0.3;
/** Selling this share of what is made, %, while buying when the sun is down: power the house could have used. */
const SOLD_PCT = 40;
/** An hour whose average power is under this share of the day's highest has no real sun. */
const SUNLESS_SHARE = 0.05;
/** Grid power above this, W, on the average day, is buying rather than drift. */
const BUYING_W = 50;
/**
 * A whole day is recorded from the morning to the afternoon on the plant's clock, as well as having
 * MIN_SAMPLES readings: a relay started at 15:00 leaves plenty of readings, and a day short of most of its sun.
 */
const MORNING_MIN = 9 * 60;
const AFTERNOON_MIN = 15 * 60;
/** Whether a system's day was wholly recorded: MIN_SAMPLES readings, from the morning into the afternoon on its clock. */
function recordedWhole(r: DayRow, s: Sys, off: number): boolean {
  if (r.samples < MIN_SAMPLES) return false;
  const minute = (ts: number) => Math.floor(((((ts + (s.off ?? off)) % DAY) + DAY) % DAY) / 60);
  return minute(r.first_ts) <= MORNING_MIN && minute(r.last_ts) >= AFTERNOON_MIN;
}
/** The order areas are said in, within how they stand. */
const AREAS = ['Reporting', 'Production', 'Systems compared', 'The battery', 'Using your own power', 'The house', 'The lowest day', 'Strings', 'Faults', 'Money'];

/** One thing an analysis found: where, how it stands, what stands out, and what to do about it. */
interface Finding { area: string; level: 'look' | 'know' | 'fine'; said: string; todo: string | null }
const LEVEL_WORDS: Record<Finding['level'], string> = { look: 'Needs a look', know: 'Worth knowing', fine: 'Fine' };
const LEVEL_ORDER: Finding['level'][] = ['look', 'know', 'fine'];

const analysisTool: Tool = {
  name: 'analysis',
  description: 'An analysis of a period - the last 30 days unless one is named: what stands out, why, and what to do about it. It reads the figures together: '
    + 'what each system made against the days before and for its sunlight, the systems per kWp, the lowest day and its likely cause, how much of the power '
    + "was used at home and when power is bought and sold, the house's always-on load and its peak, how the battery is used, whether a system is down now and why, "
    + 'days not wholly recorded, faults and weak strings - each finding with its figures and, where one follows, what to do. '
    + 'For "analyse my system", "analysis", "analytics", "insights", "how is my system doing", "how can I improve", "what should I do", "anything unusual".',
  params: { ...periodParams, system: systemParam },
  async run({ db, now }, args) {
    const all = await loadSystems(db);
    const chosen = pickSystems(all, args.system);
    const off = zoneOf(all);
    const p = resolvePeriod(args, now, off, DEFAULT_RANGE.analysis);
    const today = dayNo(now, off);
    const first = noOf(p.from);
    // Whole days only: today is still being made.
    const last = Math.min(noOf(p.to), today - 1);
    if (last < first) throw new ToolError('An analysis needs at least one whole day: ask about a period that has ended, such as yesterday or the last 7 days.');
    const span = last - first + 1;
    if (span > ANALYSIS_DAYS) throw new ToolError('An analysis covers a year at most: for longer, ask for a report.');
    const compared = span <= COMPARED_DAYS;
    const ids = chosen.map((s) => s.id);
    // Everything is read once, for all of it: the days before (to compare with), the period, and the weeks the
    // health verdict needs; the weather for the same days; and each system's average day from the last month.
    const readFrom = Math.min(compared ? first - span : first, firstTrendDay(HEALTH_WEEKS, now, off)) - 1;
    const patternFrom = Math.max(first, last - PATTERN_DAYS + 1);
    const [rows, weather, alarms, live, devices, relays, tariff, pattern] = await Promise.all([
      daily(db, readFrom * DAY - off, (today + 1) * DAY - off, -off / 60),
      weatherSince(db, readFrom * DAY - off),
      // A fault still active may have begun well before the period.
      listAlarms(db, (Math.min(first, today - 90) - 1) * DAY - off, 5000),
      latest(db),
      db.prepare(
        `SELECT i.id AS inverter_id, d.kind, d.status, d.last_seen, d.strings FROM devices d
         JOIN inverters i ON i.plant_id = d.plant_id AND i.provider = d.provider WHERE d.kind IN ('datalogger', 'inverter')`,
      ).all<{ inverter_id: string; kind: string; status: string | null; last_seen: number | null; strings: string | null }>().then((x) => x.results),
      listRelays(db, now - 30 * DAY),
      getTariff(db),
      db.prepare(
        `SELECT inverter_id AS id, CAST(((ts + COALESCE(tz_offset_sec, ?3)) % 86400) / 3600 AS INTEGER) AS h,
                AVG(ac_power_w) AS power, AVG(load_power_w) AS load, AVG(grid_power_w) AS grid, AVG(battery_power_w) AS battery
         FROM readings
         WHERE ts BETWEEN ?1 AND ?2 AND ts + COALESCE(tz_offset_sec, ?3) >= ?4 AND ts + COALESCE(tz_offset_sec, ?3) < ?5
           AND inverter_id IN (${ids.map((_, i) => `?${i + 6}`).join(', ')})
         GROUP BY inverter_id, h`,
      ).bind(patternFrom * DAY - off - DAY, (last + 1) * DAY - off + DAY, off, patternFrom * DAY, (last + 1) * DAY, ...ids)
        .all<{ id: string; h: number; power: number | null; load: number | null; grid: number | null; battery: number | null }>().then((x) => x.results),
    ]);

    const lastIso = isoDay(last);
    const inPeriod = rows.filter((r) => r.day >= p.from && r.day <= lastIso && ids.includes(r.inverter_id));
    const before = compared ? rows.filter((r) => r.day >= isoDay(first - span) && r.day < p.from && ids.includes(r.inverter_id)) : [];
    const whole = (r: DayRow | undefined): r is DayRow => !!r && r.yield_kwh != null && recordedWhole(r, chosen.find((x) => x.id === r.inverter_id)!, off);
    const daysOf = (s: Sys) => inPeriod.filter((r) => r.inverter_id === s.id);
    const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
    const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;
    const one = chosen.length === 1;
    const key = (s: Sys, name: string) => (one ? name : `${s.alias}_${name}`);
    const found: Finding[] = [];
    const facts: ToolResult['facts'] = { whole_days: span };
    const health = trendsFrom(rows, weather, chosen, HEALTH_WEEKS, now, off);

    // Each system's average day, hour by hour: when the sun is up, when the panels make more than the
    // house uses, and when power is bought while the sun is down.
    const dayShape = (s: Sys) => {
      const mine = pattern.filter((x) => x.id === s.id);
      const hours = Array.from({ length: 24 }, (_, h) => mine.find((x) => x.h === h) ?? { id: s.id, h, power: null, load: null, grid: null, battery: null });
      const peak = Math.max(0, ...hours.map((x) => x.power ?? 0));
      const sunny = (x: (typeof hours)[number]) => peak > 0 && (x.power ?? 0) >= SUNLESS_SHARE * peak;
      const buying = hours.filter((x) => (x.grid ?? 0) > BUYING_W);
      const dark = buying.filter((x) => !sunny(x));
      const bought = buying.reduce((a, x) => a + (x.grid as number), 0);
      return {
        hours, sunny,
        surplus: hours.filter((x) => x.power != null && x.load != null && x.power > x.load).map((x) => x.h),
        buyingDark: dark.map((x) => x.h),
        darkShare: bought > 0 ? dark.reduce((a, x) => a + (x.grid as number), 0) / bought : 0,
      };
    };

    // --- what each system made: against the days before, and for its sunlight
    for (const s of chosen) {
      const t = health.trends.find((x) => x.system.id === s.id)!;
      Object.assign(facts, { [key(s, 'health')]: t.verdict, [key(s, 'health_change_pct')]: t.change_pct });
      const mine = daysOf(s).filter(whole);
      if (!mine.length) continue;
      const kwhs = mine.map((r) => r.yield_kwh as number);
      const total = kwhs.reduce((a, x) => a + x, 0);
      const avg = total / mine.length;
      const prev = before.filter((r) => r.inverter_id === s.id && whole(r)).map((r) => r.yield_kwh as number);
      const change = prev.length && mean(prev) > 0 ? Math.round((avg / mean(prev) - 1) * 100) : null;
      const mid = median(kwhs);
      const lowDays = kwhs.filter((x) => x < 0.5 * mid).length;
      Object.assign(facts, { [key(s, 'made_kwh')]: r1(total), [key(s, 'average_day_kwh')]: r1(avg), [key(s, 'against_before_pct')]: change, [key(s, 'low_days')]: lowDays });
      const sunWords = t.verdict === 'declining' || t.verdict === 'improving'
        ? `for its sunlight it is making ${Math.abs(t.change_pct!)}% ${t.verdict === 'declining' ? 'less' : 'more'} over the last ${RECENT_WEEKS} weeks than in the ${HEALTH_WEEKS - RECENT_WEEKS} before`
        : t.verdict === 'steady' ? 'for its sunlight it is steady' : null;
      const lookAt = `Look at ${s.name}'s panels for dirt or new shade, and at its strings for one down: cleaning often brings the output back.`;
      let said = `${s.name} made ${kwh(total)} over ${mine.length} whole day${mine.length === 1 ? '' : 's'}, ${kwh(avg)} on an average day`;
      let level: Finding['level'] = 'fine';
      let todo: string | null = null;
      if (change != null && Math.abs(change) >= CHANGE_PCT) {
        said += ` - ${Math.abs(change)}% ${change > 0 ? 'more' : 'less'} a day than in the ${span} days before`;
        if (change < 0 && t.verdict === 'declining') { level = 'look'; todo = lookAt; said += `, and ${sunWords}: the system itself, not only the weather`; }
        else if (change < 0) { level = 'know'; if (sunWords) said += `; ${sunWords}, so the weather or the season made the difference, not the system`; }
        else if (sunWords) said += `; ${sunWords}`;
      } else if (t.verdict === 'declining') { level = 'look'; todo = lookAt; said += `; but ${sunWords}`; }
      else if (sunWords) said += `; ${sunWords}`;
      if (lowDays) said += `. ${lowDays} day${lowDays === 1 ? ' was' : 's were'} under half its median day of ${kwh(mid)}`;
      found.push({ area: 'Production', level, said: `${said}.`, todo });
    }

    // --- the systems side by side, per kWp on an average whole day: fair when one missed days
    const rated = chosen.map((s) => {
      const mine = daysOf(s).filter(whole);
      return { s, days: mine.length, avg: mine.length ? mean(mine.map((r) => r.yield_kwh as number)) : null };
    }).filter((x): x is { s: Sys; days: number; avg: number } => x.avg != null && !!x.s.kwp)
      .map((x) => ({ ...x, perKwp: x.avg / x.s.kwp! })).sort((a, b) => b.perKwp - a.perKwp);
    if (rated.length > 1) {
      const best = rated[0];
      const low = rated[rated.length - 1];
      const gap = Math.round((1 - low.perKwp / best.perKwp) * 100);
      Object.assign(facts, { best_per_kwp: best.s.name, best_kwh_per_kwp_a_day: r2(best.perKwp), lowest_per_kwp: low.s.name, lowest_kwh_per_kwp_a_day: r2(low.perKwp), lowest_below_best_pct: gap });
      found.push(gap >= PER_KWP_KNOW_PCT
        ? {
          area: 'Systems compared', level: gap >= PER_KWP_LOOK_PCT ? 'look' : 'know',
          said: `Per kWp of panels, ${low.s.name} made ${gap}% less than ${best.s.name} on an average whole day (${r2(low.perKwp)} against ${r2(best.perKwp)} kWh per kWp).`,
          todo: `If the two face the same way under the same sky, look for shade, dirt or a string down on ${low.s.name}; a different tilt or direction explains some of it.`,
        }
        : { area: 'Systems compared', level: 'fine', said: `Per kWp of panels, the systems made about the same on an average whole day: ${inWords(rated.map((x) => `${x.s.name} ${r2(x.perKwp)}`))} kWh per kWp.`, todo: null });
    }

    // --- the lowest day, every system together, from the days every one of them recorded whole
    const recorders = chosen.filter((s) => daysOf(s).some(whole));
    const totals = new Map<string, number>();
    for (let n = first; n <= last; n++) {
      const d = isoDay(n);
      const each = recorders.map((s) => inPeriod.find((r) => r.inverter_id === s.id && r.day === d));
      if (recorders.length && each.every(whole)) totals.set(d, each.reduce((a, r) => a + (r!.yield_kwh as number), 0));
    }
    if (totals.size >= 5) {
      const [low, lowKwh] = [...totals].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0];
      const mid = median([...totals.values()]);
      Object.assign(facts, { lowest_day: dayWords(low, true), lowest_day_kwh: r1(lowKwh), median_day_kwh: r1(mid) });
      if (lowKwh < LOW_DAY_SHARE * mid) {
        // Each system that day against its own median day: one low alone had a day of its own; all low together, the sky.
        const shares = recorders.map((s) => {
          const usual = median([...totals.keys()].map((d) => inPeriod.find((r) => r.inverter_id === s.id && r.day === d)!.yield_kwh as number));
          const made = inPeriod.find((r) => r.inverter_id === s.id && r.day === low)!.yield_kwh as number;
          return { s, made, share: usual > 0 ? made / usual : 1 };
        });
        // Why: less sun than usual, a system short of what its sunlight usually gives, or a fault.
        const why: string[] = [];
        let level: Finding['level'] = 'know';
        let todo: string | null = null;
        let sunKnown = false;
        for (const s of recorders) {
          const sun = sunByDay(weather.filter((w) => w.inverter_id === s.id), s.off ?? off);
          const sunDay = sun.get(low);
          const usualSun = [...totals.keys()].filter((d) => sun.has(d)).map((d) => sun.get(d)!);
          sunKnown ||= sunDay != null && usualSun.length >= 3;
          if (sunDay != null && usualSun.length >= 3 && sunDay < DULL * median(usualSun)) {
            why.push(`less sun at ${s.name}, ${r2(sunDay)} kWh/m² against a usual ${r2(median(usualSun))}`);
            continue;
          }
          const ratios = s.kwp ? [...totals.keys()].map((d) => dayRatio(inPeriod.find((r) => r.inverter_id === s.id && r.day === d), sun.get(d), s.kwp!)).filter((x): x is number => x != null) : [];
          const ratio = s.kwp ? dayRatio(inPeriod.find((r) => r.inverter_id === s.id && r.day === low), sunDay, s.kwp) : null;
          if (ratio != null && ratios.length >= 3 && ratio < SHORT * median(ratios)) {
            why.push(`${s.name} made ${Math.round((ratio / median(ratios)) * 100)}% of what its sunlight usually gives`);
            level = 'look';
            todo = `Ask "why was ${dayWords(low)} low?" for the whole of that day at ${s.name}: shading, dirt or a string down look like this.`;
          }
        }
        const dayFaults = alarms.filter((a) => ids.includes(a.inverter_id) && a.begin_ts < (noOf(low) + 1) * DAY - off && (a.end_ts ?? now) >= noOf(low) * DAY - off);
        if (dayFaults.length) why.push(`${dayFaults.length === 1 ? 'a fault' : `${dayFaults.length} faults`}: ${dayFaults.slice(0, 2).map((a) => a.message ?? `fault ${a.code}`).join(', ')}`);
        if (!why.length) {
          const lows = shares.filter((x) => x.share < LOW_DAY_SHARE);
          if (recorders.length > 1 && lows.length === recorders.length) why.push('every system was low together, which points to the weather');
          else if (recorders.length > 1 && lows.length === 1) {
            why.push(`only ${lows[0].s.name} was low, so the cause was its own - a fault, shade, or a gap in its record`);
            level = 'look';
            todo = `Ask "why was ${dayWords(low)} low?" for the whole of that day at ${lows[0].s.name}.`;
          } else why.push(sunKnown ? 'no cause in the figures' : 'there is no sunlight on record for it, so the weather cannot be checked');
        }
        const each = recorders.length > 1 ? ` - ${inWords(shares.map((x) => `${x.s.name} ${kwh(x.made)} (${Math.round(x.share * 100)}% of its median day)`))}` : '';
        found.push({ area: 'The lowest day', level, said: `The lowest day was ${dayWords(low, true)}, with ${kwh(lowKwh)} against a median day of ${kwh(mid)}${each}: ${why.join('; ')}.`, todo });
      } else {
        found.push({ area: 'The lowest day', level: 'fine', said: `No day was far below the rest: the lowest, ${dayWords(low, true)}, made ${Math.round((lowKwh / mid) * 100)}% of the median day (${kwh(lowKwh)} against ${kwh(mid)}).`, todo: null });
      }
    }

    // --- each house: its own power used, when it buys, its always-on load, and its day hour by hour
    const houses = chosen.filter((s) => pattern.some((x) => x.id === s.id && x.load != null));
    const daySections: ToolResult[] = [];
    const patternLabel = patternFrom === last ? dayWords(lastIso, true) : spanWords(isoDay(patternFrom), lastIso);
    for (const s of houses) {
      const shape = dayShape(s);
      const mine = daysOf(s);
      const made = sumOrNull(mine.map((r) => r.yield_kwh));
      const used = sumOrNull(mine.map((r) => r.load_kwh));
      const bought = sumOrNull(mine.map((r) => r.import_kwh));
      const sold = sumOrNull(mine.map((r) => r.export_kwh));
      if (made && made > 0 && sold != null && used && used > 0 && bought != null) {
        const home = Math.round((Math.max(0, made - sold) / made) * 100);
        const soldPct = Math.round((Math.min(sold, made) / made) * 100);
        const covered = Math.round((Math.max(0, used - bought) / used) * 100);
        Object.assign(facts, { [key(s, 'used_at_home_pct')]: home, [key(s, 'sold_pct')]: soldPct, [key(s, 'covered_by_the_sun_pct')]: covered, [key(s, 'bought_kwh')]: r1(bought), [key(s, 'sold_kwh')]: r1(sold) });
        let said = `${s.name} used ${home}% of what it made at home and sold ${soldPct}% (${kwh(sold)}); the sun covered ${covered}% of what the house used, and ${kwh(bought)} was bought`;
        if (shape.buyingDark.length) said += `, ${shape.darkShare >= 0.5 ? 'most of it' : 'some of it'} at ${hourSpans(shape.buyingDark)}, when the sun is down`;
        let level: Finding['level'] = covered >= 70 ? 'fine' : 'know';
        let todo: string | null = null;
        if (soldPct >= SOLD_PCT && shape.buyingDark.length && shape.surplus.length) {
          level = 'know';
          const worth = tariff && !tariff.netMetering && tariff.importPrice > tariff.exportPrice
            ? ` By your tariff, each kWh used then rather than bought later is worth ${r2(tariff.importPrice - tariff.exportPrice)} ${tariff.currency}.` : '';
          todo = `Run what can wait - washing, water heating, pumping, charging - at ${hourSpans(shape.surplus)}, when the panels make more than the house uses and the rest is sold.${worth}`;
        }
        found.push({ area: 'Using your own power', level, said: `${said}.`, todo });
      }
      const loads = shape.hours.filter((x) => x.load != null);
      if (loads.length >= 12) {
        const base = loads.reduce((a, x) => ((x.load as number) < (a.load as number) ? x : a));
        const peak = loads.reduce((a, x) => ((x.load as number) > (a.load as number) ? x : a));
        const baseW = base.load as number;
        const share = baseW / mean(loads.map((x) => x.load as number));
        const standby = baseW >= STANDBY_W && share >= STANDBY_SHARE;
        Object.assign(facts, {
          [key(s, 'always_on_w')]: Math.round(baseW), [key(s, 'always_on_kwh_a_day')]: r1((baseW * 24) / 1000), [key(s, 'always_on_share_pct')]: Math.round(share * 100),
          [key(s, 'peak_load_at')]: hh(peak.h), [key(s, 'peak_load_w')]: Math.round(peak.load as number),
        });
        found.push({
          area: 'The house', level: standby ? 'know' : 'fine',
          said: `${s.name}'s house never draws less than about ${kw(baseW)} on an average day - ${kwh((baseW * 24) / 1000)} a day, ${Math.round(share * 100)}% of what it uses - `
            + `and draws most at ${hh(peak.h)} (${kw(peak.load as number)})${shape.sunny(peak) ? '' : ', when the sun is down'}.`,
          todo: standby ? 'Find what is always on - an old fridge or freezer, a water pump or heater, devices left on standby: every 100 W on all day is 2.4 kWh a day.' : null,
        });
      }
      // The day hour by hour, as two charts: what was made against what was used, and the grid against the battery.
      const kwOf = (w: number | null) => (w == null ? null : r2(w / 1000));
      const period = { from: isoDay(patternFrom), to: lastIso, label: patternLabel };
      const shown = shape.hours.filter((x) => x.power != null || x.load != null || x.grid != null);
      const withBattery = shown.some((x) => x.battery != null);
      daySections.push({
        tool: 'analysis', title: `Made and used, on an average day, ${s.name}`, period,
        columns: ['Hour', 'Power made (kW)', 'House load (kW)'], rows: shown.map((x) => [hh(x.h), kwOf(x.power), kwOf(x.load)]),
        facts: {}, notes: ["Each hour's average over the days, from every reading."], summary: `${s.name}'s average day, hour by hour: what it made against what the house used.`,
        freshness: freshnessFrom(live, [s], now), chart: { kind: 'line', columns: [1, 2] },
      }, {
        tool: 'analysis', title: `Grid and battery, on an average day, ${s.name}`, period,
        columns: ['Hour', 'Grid power (kW)', ...(withBattery ? ['Battery power (kW)'] : [])],
        rows: shown.map((x) => [hh(x.h), kwOf(x.grid), ...(withBattery ? [kwOf(x.battery)] : [])]),
        facts: {}, notes: ['Grid power is above zero while buying from the grid, and below zero while selling to it; battery power is above zero while charging.'],
        summary: `${s.name}'s average day, hour by hour: the grid and the battery.`, freshness: freshnessFrom(live, [s], now), chart: { kind: 'line', columns: withBattery ? [1, 2] : [1] },
      });
    }

    // --- each battery: kept full, running low, or used
    const batteryRows: (string | number | null)[][] = [];
    for (const s of chosen) {
      // A battery reports a charge above nothing, or a charge taken in: an on-grid plant's stray zero is not one.
      if (!daysOf(s).some((r) => (r.soc_max ?? 0) > 0 || (r.batt_charge_kwh ?? 0) > 0)) continue;
      const mine = daysOf(s).filter((r) => r.soc_max != null);
      for (const r of mine) {
        batteryRows.push([s.name, dayWords(r.day, true), r.batt_charge_kwh != null ? r1(r.batt_charge_kwh) : null, r.batt_discharge_kwh != null ? r1(r.batt_discharge_kwh) : null,
          r.soc_min != null ? Math.round(r.soc_min) : null, Math.round(r.soc_max as number)]);
      }
      const lowest = Math.round(Math.min(...mine.map((r) => r.soc_min ?? (r.soc_max as number))));
      const highest = Math.round(Math.max(...mine.map((r) => r.soc_max as number)));
      // How low it goes on a typical day, not on its one lowest: a single deep night says little of the rest.
      const typical = Math.round(median(mine.map((r) => r.soc_min ?? (r.soc_max as number))));
      const gaveOut = sumOrNull(mine.map((r) => r.batt_discharge_kwh));
      const fullDays = mine.filter((r) => (r.soc_max as number) >= FULL_PCT).length;
      const lowDays = mine.filter((r) => r.soc_min != null && r.soc_min <= RAN_LOW_PCT).length;
      const bought = sumOrNull(daysOf(s).map((r) => r.import_kwh));
      const shape = dayShape(s);
      Object.assign(facts, {
        [key(s, 'battery_lowest_pct')]: lowest, [key(s, 'battery_typical_low_pct')]: typical, [key(s, 'battery_highest_pct')]: highest, [key(s, 'battery_full_days')]: fullDays,
        [key(s, 'battery_days')]: mine.length, [key(s, 'battery_gave_out_kwh')]: gaveOut != null ? r1(gaveOut) : null,
      });
      const gave = gaveOut != null ? ` and gave out ${kwh(gaveOut)}` : '';
      if (typical >= KEPT_FULL_PCT && bought && bought > 0 && shape.buyingDark.length) {
        found.push({
          area: 'The battery', level: 'look',
          said: `${s.name}'s battery was full on ${fullDays} of ${mine.length} days and on a typical day went no lower than ${typical}%${gaveOut != null ? `; it gave out ${kwh(gaveOut)} in all` : ''}, `
            + `while the house bought ${kwh(bought)} from the grid, ${shape.darkShare >= 0.5 ? 'mostly' : 'partly'} at ${hourSpans(shape.buyingDark)}: it is kept full rather than used at night.`,
          todo: "Check the inverter's battery setting. In a self-use (solar first) mode the battery runs the house at night and fills again by day; "
            + 'in a backup or grid-first mode it is kept full for power cuts - worth it where the grid often fails, but then the nights are bought.',
        });
      } else if (lowDays >= 2) {
        found.push({
          area: 'The battery', level: 'know', said: `${s.name}'s battery ran down to ${RAN_LOW_PCT}% or less on ${lowDays} of ${mine.length} days, as low as ${lowest}%${gave}.`,
          todo: 'If it runs out before the sun is up, less use late in the evening, or a larger battery, keeps the house off the grid for longer.',
        });
      } else {
        found.push({ area: 'The battery', level: 'fine', said: `${s.name}'s battery went between ${lowest}% and ${highest}% - down to ${typical}% on a typical day - and was full on ${fullDays} of ${mine.length} days${gave}: it is being used.`, todo: null });
      }
    }

    // --- whether each system is reporting now, and why not; and the days it was not wholly recorded
    for (const s of chosen) {
      const o = s.off ?? off;
      const r = live.find((x) => x.id === s.id);
      const on = !!r?.ts && now - r.ts <= STALE_AFTER_S && r.status !== 'offline';
      if (r?.ts && !on) {
        const sun = new Map(weather.filter((w) => w.inverter_id === s.id && w.ghi_wm2 != null).map((w) => [w.ts, w.ghi_wm2 as number]));
        const light = (ts: number) => {
          const ghi = sun.get(Math.floor(ts / 3600) * 3600 + 3600);
          if (ghi != null) return ghi >= DAYLIGHT_WM2;
          const m = ((((ts + o) % DAY) + DAY) % DAY) / 60;
          return m >= 7 * 60 && m < 17 * 60;
        };
        // Quiet since dark with no battery is an inverter asleep: expected until sunrise.
        if (light(r.ts) || light(now) || r.battery_soc != null) {
          const logger = devices.find((d) => d.inverter_id === s.id && d.kind === 'datalogger');
          const relay = relays.filter((x) => x.provider === 'soliscloud').sort((x, y) => y.last_seen - x.last_seen)[0];
          let why = '';
          let todo = `Check ${s.name}'s logger and its network at the site, or whether the vendor is down.`;
          if (logger?.status === 'offline' && logger.last_seen) {
            why = `: its datalogger has been offline since ${at(logger.last_seen, o)}`;
            todo = `Check ${s.name}'s datalogger at the site - its Wi-Fi and its power.`;
          } else if (s.provider === 'soliscloud') {
            if (relay && now - relay.last_seen <= STALE_AFTER_S) { why = ': the relay is running, so SolisCloud has nothing new to send'; todo = `Check ${s.name}'s inverter and its datalogger at the site.`; }
            else if (relay?.login_expires_at && relay.login_expires_at <= now) { why = `: the relay's SolisCloud login ran out on ${at(relay.login_expires_at, o)}`; todo = 'Renew the SolisCloud login on the relay laptop with renew-solis-login.cmd.'; }
            else { why = relay ? `: no relay has reported since ${at(relay.last_seen, o)}` : ': no relay has reported'; todo = 'Check the relay laptop is on, and its SolisCloud login is current (Devices tab).'; }
          }
          Object.assign(facts, { [key(s, 'reporting_now')]: 'no', [key(s, 'quiet_since')]: at(r.ts, o) });
          found.push({ area: 'Reporting', level: 'look', said: `${s.name} has not reported since ${at(r.ts, o)}, ${duration(now - r.ts)} ago${why}.`, todo });
        }
      }
      // From the first day the system was recorded, if that falls in the period.
      const seen = rows.filter((x) => x.inverter_id === s.id).map((x) => x.day).sort()[0];
      if (!seen) continue;
      const from = Math.max(first, noOf(seen));
      let short = 0;
      for (let n = from; n <= last; n++) if (!whole(inPeriod.find((x) => x.inverter_id === s.id && x.day === isoDay(n)))) short++;
      facts[key(s, 'days_not_wholly_recorded')] = short;
      if (short >= 2) {
        found.push({
          area: 'Reporting', level: 'know',
          said: `${s.name} was not wholly recorded on ${short} of the ${last - from + 1} days${from > first ? ' since it was first recorded' : ''}, so its figures for them are short.`,
          todo: s.provider === 'soliscloud' ? "Keep the relay laptop on through the day: SolisCloud's figures come through it." : null,
        });
      }
    }

    // --- faults: any still active, and what came back
    const faultOf = (a: (typeof alarms)[number]) => a.message ?? `fault ${a.code}`;
    const recorded = alarms.filter((a) => ids.includes(a.inverter_id) && a.begin_ts >= first * DAY - off && a.begin_ts < (last + 1) * DAY - off);
    const active = alarms.filter((a) => ids.includes(a.inverter_id) && !a.end_ts && a.state === 'active');
    const counts = new Map<string, number>();
    for (const a of recorded) counts.set(faultOf(a), (counts.get(faultOf(a)) ?? 0) + 1);
    const common = [...counts].sort((a, b) => b[1] - a[1])[0];
    Object.assign(facts, { faults: recorded.length, faults_still_active: active.length, ...(common ? { most_common_fault: common[0], most_common_fault_times: common[1] } : {}) });
    if (active.length) {
      found.push({
        area: 'Faults', level: 'look',
        said: `${active.length} fault${active.length === 1 ? ' is' : 's are'} still active: ${active.slice(0, 3).map((a) => `${faultOf(a)} on ${chosen.find((s) => s.id === a.inverter_id)!.name}`).join('; ')}.`,
        todo: "See what each one means, and the vendor's advice, on the Alerts tab.",
      });
    } else if (recorded.length) {
      found.push({
        area: 'Faults', level: 'know',
        said: `${recorded.length} fault${recorded.length === 1 ? ' was' : 's were'} recorded and none is still active${common && common[1] > 1 ? `; the most common was ${common[0]}, ${common[1]} times` : ''}.`,
        todo: common && common[1] >= 3 ? 'A fault that keeps coming back is worth raising with the installer.' : null,
      });
    } else found.push({ area: 'Faults', level: 'fine', said: 'No faults were recorded.', todo: null });

    // --- the strings, where the inverter's record is fresh
    for (const s of chosen) {
      const d = devices.find((x) => x.inverter_id === s.id && x.kind === 'inverter');
      if (!d?.last_seen || now - d.last_seen > DEVICE_FRESH_S) continue;
      const { best, weak } = weakStrings(jsonOf<Part[]>(d.strings) ?? []);
      if (!best || !weak.length) continue;
      const names = inWords(weak.map((x) => `PV${x.index}`));
      facts[key(s, 'weak_strings')] = weak.map((x) => `PV${x.index}`).join(', ');
      found.push({
        area: 'Strings', level: 'look',
        said: `On ${s.name}, ${names} ${weak.length === 1 ? 'is' : 'are'} making far less than PV${best.index} (${weak.map((x) => `${Math.round(x.powerW ?? 0)} W`).join(', ')} against ${Math.round(best.powerW ?? 0)} W), as last read at ${clock(d.last_seen, s.off ?? off)}.`,
        todo: `Look at ${names} on ${s.name}: shade, dirt, or a loose or failed connection.`,
      });
    }

    // --- the money, by the owner's tariff
    if (tariff) {
      let saved = 0;
      let co2 = 0;
      let any = false;
      for (const r of inPeriod) {
        const v = valueOf(r.yield_kwh, r.export_kwh, tariff);
        if (v) { saved += v.money; co2 += v.co2; any = true; }
      }
      if (any) {
        Object.assign(facts, { saved: r2(saved), currency: tariff.currency, co2_avoided_kg: r1(co2) });
        found.push({ area: 'Money', level: 'fine', said: `By your tariff, the power made saved about ${r2(saved)} ${tariff.currency} and avoided ${r1(co2)} kg of CO2.`, todo: null });
      }
    }

    // --- the findings, what needs a look first
    const sorted = LEVEL_ORDER.flatMap((l) => found.filter((f) => f.level === l).sort((a, b) => AREAS.indexOf(a.area) - AREAS.indexOf(b.area)));
    const count = (l: Finding['level']) => found.filter((f) => f.level === l).length;
    Object.assign(facts, { needs_a_look: count('look'), worth_knowing: count('know'), fine: count('fine') });
    const todos = [...new Set(sorted.map((f) => f.todo).filter((t): t is string => !!t))];
    const label = p.to > lastIso ? `${p.label}, to yesterday` : p.label;
    // "Your systems last week (...)", "Your systems over the last 30 days (...)".
    const head = `${one ? chosen[0].name : 'Your systems'} ${/^(this|last|yesterday)/.test(label) ? label : `over ${label}`}: `
      + `${count('look') ? `${count('look')} thing${count('look') === 1 ? '' : 's'} to look at` : 'nothing that needs a look'}${count('know') ? `, ${count('know')} worth knowing` : ''}.`;

    // The evidence: the day hour by hour, each day, the systems side by side, the weeks for the sunlight, the battery, the faults.
    const sections: ToolResult[] = [...daySections];
    const freshness = freshnessFrom(live, chosen, now);
    const byMonth = span > 62;
    const buckets = new Map<string, DayRow[]>();
    for (const r of inPeriod) {
      const k = byMonth ? r.day.slice(0, 7) : r.day;
      buckets.set(k, [...(buckets.get(k) ?? []), r]);
    }
    const measures: [keyof DayRow, string][] = [['yield_kwh', 'Made (kWh)'], ['load_kwh', 'Used (kWh)'], ['import_kwh', 'Bought (kWh)'], ['export_kwh', 'Sold (kWh)']];
    const present = measures.filter(([f]) => inPeriod.some((r) => r[f] != null));
    if (present.length && buckets.size) {
      const keys = [...buckets.keys()].sort();
      sections.push({
        tool: 'analysis', title: `Energy ${byMonth ? 'month' : 'day'} by ${byMonth ? 'month' : 'day'}`, period: { from: p.from, to: lastIso, label },
        columns: [byMonth ? 'Month' : 'Day', ...present.map(([, w]) => w)],
        rows: keys.map((k) => [byMonth ? `${MONTHS[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}` : dayWords(k, true),
          ...present.map(([f]) => { const v = sumOrNull(buckets.get(k)!.map((r) => r[f] as number | null)); return v == null ? null : r1(v); })]),
        facts: {}, notes: ['Every system together; a day a system did not wholly record counts what was recorded.'], summary: 'Energy over the period.', freshness,
        chart: { kind: 'bar', columns: [1] },
      });
    }
    if (rated.length > 1) {
      sections.push({
        tool: 'analysis', title: 'Systems per kWp, on an average whole day', period: { from: p.from, to: lastIso, label },
        columns: ['System', 'Size (kWp)', 'Whole days', 'Average day (kWh)', 'kWh per kWp a day'],
        rows: rated.map((x) => [x.s.name, r1(x.s.kwp!), x.days, r1(x.avg), r2(x.perKwp)]),
        facts: {}, notes: [], summary: 'Each system per kWp of its panels.', freshness,
      });
    }
    if (health.trends.some((t) => t.weekly.some((w) => w != null))) {
      sections.push({
        tool: 'analysis', title: 'Output for the sunlight, week by week',
        period: { from: health.mondays[0], to: isoDay(noOf(health.mondays[health.mondays.length - 1]) + 6), label: `the ${HEALTH_WEEKS} weeks from ${spanWords(health.mondays[0], isoDay(noOf(health.mondays[health.mondays.length - 1]) + 6))}` },
        columns: ['Week of', ...health.trends.map((t) => `${t.system.name} (ratio)`)],
        rows: health.mondays.map((m, w) => [dayWords(m), ...health.trends.map((t) => (t.weekly[w] != null ? r2(t.weekly[w]!) : null))]),
        facts: {}, notes: [`The energy made against the sunlight on the panels. A fall of ${DECLINE_PCT}% or more, over the last ${RECENT_WEEKS} weeks against the weeks before, is worth a look.`],
        summary: health.trends.map((t) => trendWords(t, HEALTH_WEEKS)).join(' '), freshness,
      });
    }
    if (batteryRows.length && !byMonth) {
      sections.push({
        tool: 'analysis', title: 'The battery, day by day', period: { from: p.from, to: lastIso, label },
        columns: ['System', 'Day', 'Charged (kWh)', 'Discharged (kWh)', 'Lowest charge (%)', 'Highest charge (%)'], rows: batteryRows,
        facts: {}, notes: [], summary: 'Each day of the battery.', freshness,
      });
    }
    if (recorded.length || active.length) {
      const listed = [...new Map([...active, ...recorded].map((a) => [a.id, a])).values()].sort((a, b) => b.begin_ts - a.begin_ts).slice(0, 20);
      sections.push({
        tool: 'analysis', title: 'Faults', period: { from: p.from, to: lastIso, label },
        columns: ['When', 'System', 'Fault', 'Severity', 'Outcome'],
        rows: listed.map((a) => {
          const s = chosen.find((x) => x.id === a.inverter_id)!;
          return [at(a.begin_ts, s.off ?? off), s.name, faultOf(a), a.severity, a.end_ts ? `cleared after ${duration(a.end_ts - a.begin_ts)}` : a.state === 'active' ? 'still active' : 'end not recorded'];
        }),
        facts: {}, notes: [], summary: 'The faults recorded, newest first.', freshness,
      });
    }

    return {
      tool: 'analysis',
      title: `Analysis${one ? `: ${chosen[0].name}` : ''}`,
      period: { from: p.from, to: lastIso, label },
      columns: ['How it stands', 'Area', 'What stands out', 'What to do'],
      rows: sorted.map((f) => [LEVEL_WORDS[f.level], f.area, f.said, f.todo]),
      facts,
      notes: [
        `Whole days only, from SolarLens's own record${p.to > lastIso ? ': today is left out, as it is not over yet' : ''}. The average day, hour by hour, is from every reading of ${patternLabel}.`,
        'A finding needs a look when something may be wrong or costing you; it is worth knowing when it explains the figures or shows what could be better.',
      ],
      summary: [head, ...sorted.map((f) => `- ${f.said}`), ...(todos.length ? ['What to do:', ...todos.map((t) => `- ${t}`)] : [])].join('\n'),
      freshness,
      sections,
    };
  },
};

// ---------------------------------------------------------------- any figure

/**
 * What the figures tool works out. A day's figure is each inverter's own day counter, or the day's
 * record - one figure a system a day - and a moment's is every reading. Only these columns are ever
 * written into a query: nothing asked for is.
 */
const DAY_FIGURES = {
  made: { field: 'yield_kwh', unit: 'kWh', words: 'energy made', adds: true },
  used: { field: 'load_kwh', unit: 'kWh', words: 'energy the house used', adds: true },
  bought: { field: 'import_kwh', unit: 'kWh', words: 'energy bought from the grid', adds: true },
  sold: { field: 'export_kwh', unit: 'kWh', words: 'energy sold to the grid', adds: true },
  battery_in: { field: 'batt_charge_kwh', unit: 'kWh', words: 'energy the battery took in', adds: true },
  battery_out: { field: 'batt_discharge_kwh', unit: 'kWh', words: 'energy the battery gave out', adds: true },
  peak_power: { field: 'peak_w', unit: 'kW', words: "a day's highest power", adds: false },
  battery_low: { field: 'soc_min', unit: '%', words: "the battery's lowest charge in a day", adds: false },
  battery_high: { field: 'soc_max', unit: '%', words: "the battery's highest charge in a day", adds: false },
} as const;
const MOMENT_FIGURES = {
  power: { column: 'ac_power_w', unit: 'kW', words: 'power made' },
  load: { column: 'load_power_w', unit: 'kW', words: 'house load' },
  grid: { column: 'grid_power_w', unit: 'kW', words: 'grid power' },
  battery_power: { column: 'battery_power_w', unit: 'kW', words: 'battery power' },
  battery_charge: { column: 'battery_soc', unit: '%', words: 'battery charge' },
} as const;
type DayFigure = keyof typeof DAY_FIGURES;
type MomentFigure = keyof typeof MOMENT_FIGURES;
const FIGURE_STATS = ['total', 'average', 'highest', 'lowest', 'count', 'first', 'last'] as const;
type FigureStat = (typeof FIGURE_STATS)[number];
const FIGURE_BY = ['none', 'hour_of_day', 'weekday', 'day', 'week', 'month', 'year'] as const;
type FigureBy = (typeof FIGURE_BY)[number];
/** A day's figure covers a year at most; a moment's, three months, as a chart does. */
const FIGURE_DAYS = 366;
const WEEKDAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/**
 * A day's figure asked for by the hour: the moment's figure behind it, and how, unless asked otherwise -
 * energy made by the hour is the power made at each hour, a day's peak the highest power.
 */
const HOURLY: Record<DayFigure, [MomentFigure, FigureStat]> = {
  made: ['power', 'average'], used: ['load', 'average'], bought: ['grid', 'average'], sold: ['grid', 'average'],
  battery_in: ['battery_power', 'average'], battery_out: ['battery_power', 'average'],
  peak_power: ['power', 'highest'], battery_low: ['battery_charge', 'lowest'], battery_high: ['battery_charge', 'highest'],
};

/** One figure worked out over a set of days or readings: the value, when, and how many it came from. */
interface Figure { v: number | null; at: string | null; n: number; of: number }

const figuresTool: Tool = {
  name: 'figures',
  description: 'Any figure the records hold, worked out as asked: for a question no other tool answers as directly. '
    + "A measure: a day's energy - made, used by the house, bought, sold, taken in or given out by the battery (made, used, bought, sold, battery_in, battery_out) - "
    + "a day's highest power (peak_power), the battery's lowest or highest charge in a day (battery_low, battery_high); or at any moment the power made, "
    + 'house load, grid power (above zero while buying, below zero while selling), battery power (above zero while charging) or battery charge '
    + '(power, load, grid, battery_power, battery_charge); or lifetime_made, what each inverter has made since it was installed. '
    + 'How: total, average, highest, lowest, count (the days it was above or below an amount), first or last (the first or last time it was). '
    + 'By: none, hour_of_day, weekday, day, week, month or year. For "how many days was the battery full" (battery_high, count, above 97), '
    + '"when did I first buy more than 2 kW" (grid, first, above 2), "selling more than 3 kW" (grid, below -3), "average use on each weekday" '
    + '(used, average, by weekday), "the highest power this year" (power, highest), "lifetime generation" (lifetime_made). '
    + "A day's figure covers a year at most, a moment's three months.",
  params: {
    ...periodParams,
    measure: { type: 'string', enum: [...Object.keys(DAY_FIGURES), ...Object.keys(MOMENT_FIGURES), 'lifetime_made'], description: 'What to work out.' },
    stat: { type: 'string', enum: FIGURE_STATS, description: "How: total, average, highest, lowest, count, first or last; a total for a day's energy, else the average, by default.", optional: true },
    by: { type: 'string', enum: FIGURE_BY, description: "Split by hour_of_day (a day's figure by the hour is the power, load, grid or battery at each hour), weekday, day, week, month or year; none by default.", optional: true },
    above: { type: 'number', min: -1000000, max: 1000000, description: 'Only where the figure is above this, in its unit: kWh, kW or %.', optional: true },
    below: { type: 'number', min: -1000000, max: 1000000, description: 'Only where the figure is below this, in its unit: kWh, kW or %.', optional: true },
    system: systemParam,
  },
  async run({ db, now }, args) {
    const all = await loadSystems(db);
    const chosen = pickSystems(all, args.system);
    const off = zoneOf(all);
    const above = args.above as number | undefined;
    const below = args.below as number | undefined;
    const by = (args.by as FigureBy | undefined) ?? 'none';
    // A day's figure is one a day: by the hour, it is the moment's figure behind it.
    const hourly = by === 'hour_of_day' && String(args.measure) in DAY_FIGURES ? HOURLY[args.measure as DayFigure] : null;
    const measure = hourly ? hourly[0] : String(args.measure);
    const one = chosen.length === 1;
    const key = (name: string, what: string) => (one ? what : `${chosen.find((s) => s.name === name)?.alias ?? 'together'}_${what}`);

    // Since it was installed: each inverter's own lifetime counter, as last read.
    if (measure === 'lifetime_made') {
      const live = await latest(db);
      const facts: ToolResult['facts'] = {};
      const lines: string[] = [];
      const rows = chosen.map((s) => {
        const r = live.find((x) => x.id === s.id);
        const total = r?.total_kwh ?? null;
        facts[key(s.name, 'lifetime_kwh')] = total != null ? r1(total) : null;
        lines.push(total != null ? `${s.name} has made ${kwh(total)} since it was installed, by its inverter's own counter as last read, ${at(r!.ts!, s.off ?? off)}.`
          : `${s.name}'s inverter has not reported a lifetime total.`);
        return [s.name, total != null ? r1(total) : null, r?.ts ? at(r.ts, s.off ?? off) : null];
      });
      const known = rows.map((r) => r[1]).filter((x): x is number => typeof x === 'number');
      if (!one && known.length > 1) {
        facts.together_lifetime_kwh = r1(known.reduce((a, x) => a + x, 0));
        lines.push(`Together, ${kwh(facts.together_lifetime_kwh as number)}.`);
      }
      return {
        tool: 'figures', title: 'Made since installed', period: null, columns: ['System', 'Made since installed (kWh)', 'As last read'], rows, facts,
        notes: ["Each inverter's own lifetime counter, which counts from before SolarLens began."], summary: lines.join(' '), freshness: freshnessFrom(live, chosen, now),
      };
    }

    const p = resolvePeriod(args, now, off, DEFAULT_RANGE.figures);
    const days = noOf(p.to) - noOf(p.from) + 1;
    const during = p.from === p.to ? (/^(today|yesterday)/.test(p.label) ? p.label : `on ${p.label}`) : /^(this|last) /.test(p.label) ? p.label : `over ${p.label}`;
    const isDay = measure in DAY_FIGURES;
    const unit = isDay ? DAY_FIGURES[measure as DayFigure].unit : MOMENT_FIGURES[measure as MomentFigure].unit;
    const words = isDay ? DAY_FIGURES[measure as DayFigure].words : `the ${MOMENT_FIGURES[measure as MomentFigure].words}`;
    const adds = isDay && DAY_FIGURES[measure as DayFigure].adds;
    // Energy adds up to a total - but set side by side by weekday or hour, days of each come in unequal numbers: the average then.
    const asked = (args.stat as FigureStat | undefined) ?? (hourly ? hourly[1] : adds && by !== 'weekday' && by !== 'hour_of_day' ? 'total' : 'average');
    // Power, charge and a day's highest do not add up over time: a total of them is their average.
    const stat: FigureStat = asked === 'total' && !adds ? 'average' : asked;
    const notes: string[] = [];
    if (hourly) {
      const day = DAY_FIGURES[args.measure as DayFigure];
      notes.push(`${day.words[0].toUpperCase()}${day.words.slice(1)} is one figure a day: by the hour, this is ${words} at each hour instead.`
        + (day.unit === 'kWh' ? " An hour's average in kW is that hour's energy in kWh." : ''));
    } else if (asked !== stat) notes.push(`${words[0].toUpperCase()}${words.slice(1)} does not add up over time, so this is its average.`);
    const show = (v: number) => (unit === 'kWh' ? kwh(v) : unit === 'kW' ? kw(v * 1000) : `${Math.round(v)}%`);
    const num = (v: number) => (unit === '%' ? Math.round(v) : r2(v));
    // The amount in words - and for the grid and the battery, the way it flows.
    const amount = (x: number) => (unit === '%' ? `${x}%` : `${x} ${unit}`);
    // Beyond zero is simply buying or selling, charging or discharging.
    const flows = (lo: number | undefined, hi: number | undefined): string => {
      if (measure === 'grid' && lo != null && lo >= 0 && hi == null) return lo ? `buying more than ${amount(lo)}` : 'buying';
      if (measure === 'grid' && hi != null && hi <= 0 && lo == null) return hi ? `selling more than ${amount(-hi)}` : 'selling';
      if (measure === 'battery_power' && lo != null && lo >= 0 && hi == null) return lo ? `charging at more than ${amount(lo)}` : 'charging';
      if (measure === 'battery_power' && hi != null && hi <= 0 && lo == null) return hi ? `discharging at more than ${amount(-hi)}` : 'discharging';
      return lo != null && hi != null ? `between ${amount(lo)} and ${amount(hi)}` : lo != null ? `above ${amount(lo)}` : `below ${amount(hi!)}`;
    };
    const cond = above != null || below != null ? flows(above, below) : null;
    const meets = (x: number) => (above == null || x > above) && (below == null || x < below);
    const label = (b: string): string => {
      if (by === 'hour_of_day') return `${b.padStart(2, '0')}:00`;
      if (by === 'weekday') return WEEKDAYS_LONG[Number(b)];
      if (by === 'day') return dayWords(b, true);
      if (by === 'week') return `week of ${dayWords(b)}`;
      if (by === 'month') return `${MONTHS[Number(b.slice(5, 7)) - 1]} ${b.slice(0, 4)}`;
      return b;
    };
    // Each subject's figure in each bucket, bucket keys in order.
    const table = new Map<string, Map<string, Figure>>();
    let freshness: ToolResult['freshness'];

    if (isDay) {
      const m = DAY_FIGURES[measure as DayFigure];
      if (days > FIGURE_DAYS) throw new ToolError("A figure from each day covers a year at most: for longer, ask for the energy per month or per year.");
      const [rows, live] = await Promise.all([dayRows(db, chosen, p, off), latest(db)]);
      freshness = freshnessFrom(live, chosen, now);
      const today = isoDay(dayNo(now, off));
      // A battery's figures are a battery's: an on-grid plant's stray zero charge does not make it one.
      const counted = measure.startsWith('battery')
        ? chosen.filter((s) => rows.some((r) => r.inverter_id === s.id && ((r.soc_max ?? 0) > 0 || (r.batt_charge_kwh ?? 0) > 0)))
        : chosen;
      const valueOf = (r: DayRow) => { const v = r[m.field] as number | null; return v == null ? null : m.field === 'peak_w' ? v / 1000 : v; };
      // A total counts what each day recorded; anything else only whole days, which today is not yet.
      const usable = (r: DayRow, s: Sys) => stat === 'total' || (r.day !== today && recordedWhole(r, s, off));
      const bucketOf = (day: string): string => {
        const n = noOf(day);
        if (by === 'weekday') return String((utc(n).getUTCDay() + 6) % 7);
        if (by === 'day') return day;
        if (by === 'week') return isoDay(n - ((utc(n).getUTCDay() + 6) % 7));
        if (by === 'month') return day.slice(0, 7);
        if (by === 'year') return day.slice(0, 4);
        return '';
      };
      // A system not counted is kept, with nothing: it is then said, once, to have no record of this.
      const series = new Map<string, { day: string; v: number }[]>();
      for (const s of chosen) {
        series.set(s.name, !counted.includes(s) ? [] : rows.filter((r) => r.inverter_id === s.id && usable(r, s)).map((r) => ({ day: r.day, v: valueOf(r) }))
          .filter((x): x is { day: string; v: number } => x.v != null).sort((a, b) => a.day.localeCompare(b.day)));
      }
      // Every system together, for energy: a day counts when every system with a figure in the period has one that day.
      const having = counted.filter((s) => series.get(s.name)!.length);
      if (!one && adds && having.length > 1) {
        const dayset = [...new Set(having.flatMap((s) => series.get(s.name)!.map((x) => x.day)))].sort();
        series.set('Together', stat === 'total'
          ? having.flatMap((s) => series.get(s.name)!)
          : dayset.filter((d) => having.every((s) => series.get(s.name)!.some((x) => x.day === d)))
            .map((d) => ({ day: d, v: having.reduce((a, s) => a + series.get(s.name)!.find((x) => x.day === d)!.v, 0) })));
      }
      for (const [who, points] of series) {
        const buckets = new Map<string, { day: string; v: number }[]>();
        for (const x of points) buckets.set(bucketOf(x.day), [...(buckets.get(bucketOf(x.day)) ?? []), x]);
        const out = new Map<string, Figure>();
        for (const [b, xs] of buckets) {
          const hit = xs.filter((x) => meets(x.v));
          const pick = (xsx: typeof xs, better: (a: number, b: number) => boolean) => (xsx.length ? xsx.reduce((a, x) => (better(x.v, a.v) ? x : a)) : null);
          const f: Figure = stat === 'total' ? { v: hit.length ? hit.reduce((a, x) => a + x.v, 0) : null, at: null, n: hit.length, of: xs.length }
            : stat === 'average' ? { v: hit.length ? hit.reduce((a, x) => a + x.v, 0) / hit.length : null, at: null, n: hit.length, of: xs.length }
              : stat === 'count' ? { v: hit.length, at: null, n: hit.length, of: xs.length }
                : stat === 'first' || stat === 'last' ? (() => { const x = hit.length ? hit[stat === 'first' ? 0 : hit.length - 1] : null; return { v: x?.v ?? null, at: x?.day ?? null, n: hit.length, of: xs.length }; })()
                  : (() => { const x = pick(hit, stat === 'highest' ? (a, b2) => a > b2 : (a, b2) => a < b2); return { v: x?.v ?? null, at: x?.day ?? null, n: hit.length, of: xs.length }; })();
          out.set(b, f);
        }
        table.set(who, out);
      }
    } else {
      const m = MOMENT_FIGURES[measure as MomentFigure];
      if (days > CHART_DAYS) throw new ToolError('A figure from every reading covers three months at most: for longer, ask for a day\'s figure, such as the peak power or the energy.');
      const scale = unit === 'kW' ? 1000 : 1;
      const local = 'ts + COALESCE(tz_offset_sec, ?3)';
      const bucket = {
        none: "''", hour_of_day: `CAST(((${local}) % 86400) / 3600 AS INTEGER)`, weekday: `CAST(((${local}) / 86400 + 3) % 7 AS INTEGER)`,
        day: `date(${local}, 'unixepoch')`, week: `date((${local}) - ((((${local}) / 86400 + 3) % 7) * 86400), 'unixepoch')`,
        month: `strftime('%Y-%m', ${local}, 'unixepoch')`, year: `strftime('%Y', ${local}, 'unixepoch')`,
      }[by];
      const ids = chosen.map((s) => s.id);
      const binds: unknown[] = [noOf(p.from) * DAY - off - DAY, Math.min((noOf(p.to) + 1) * DAY - off + DAY, now), off, noOf(p.from) * DAY, (noOf(p.to) + 1) * DAY, ...ids];
      const limit = (op: '>' | '<', x: number) => { binds.push(x * scale); return `${m.column} ${op} ?${binds.length}`; };
      const conds = [above != null ? limit('>', above) : null, below != null ? limit('<', below) : null].filter(Boolean);
      const condSql = conds.length ? conds.join(' AND ') : `${m.column} IS NOT NULL`;
      const dayOf = `CAST((${local}) / 86400 AS INTEGER)`;
      // One aggregate a statistic: with a single MIN or MAX, the time read beside it is the time of that very reading.
      const pick: Record<FigureStat, string> = {
        total: `AVG(${m.column}) AS v, NULL AS t`,
        average: `AVG(${m.column}) AS v, NULL AS t`,
        highest: `MAX(${m.column}) AS v, ts AS t`,
        lowest: `MIN(${m.column}) AS v, ts AS t`,
        count: `COUNT(DISTINCT CASE WHEN ${condSql} THEN ${dayOf} END) AS v, NULL AS t`,
        first: `MIN(ts) AS t, ${m.column} AS v`,
        last: `MAX(ts) AS t, ${m.column} AS v`,
      };
      // A battery's figures are a battery's: a system counts once it has reported a charge above nothing in the period.
      const battery = measure.startsWith('battery')
        ? ` AND inverter_id IN (SELECT inverter_id FROM readings WHERE ts BETWEEN ?1 AND ?2 AND battery_soc > 0)` : '';
      const where = `${stat === 'count' ? `${m.column} IS NOT NULL` : condSql}${battery}`;
      const [{ results }, live] = await Promise.all([
        db.prepare(
          `SELECT inverter_id AS id, ${bucket} AS b, ${pick[stat]}, COUNT(DISTINCT ${dayOf}) AS days
           FROM readings
           WHERE ts BETWEEN ?1 AND ?2 AND ${local} >= ?4 AND ${local} < ?5 AND inverter_id IN (${ids.map((_, i) => `?${i + 6}`).join(', ')})
             AND ${where}
           GROUP BY inverter_id, b`,
        ).bind(...binds).all<{ id: string; b: string | number; v: number | null; t: number | null; days: number }>(),
        latest(db),
      ]);
      freshness = freshnessFrom(live, chosen, now);
      // The days each system was read at all, for "on 5 of the 23 days it was read".
      const { results: read } = stat === 'count' || !conds.length ? { results: [] as { id: string; days: number }[] } : await db.prepare(
        `SELECT inverter_id AS id, COUNT(DISTINCT ${dayOf}) AS days FROM readings
         WHERE ts BETWEEN ?1 AND ?2 AND ${local} >= ?4 AND ${local} < ?5 AND inverter_id IN (${ids.map((_, i) => `?${i + 6}`).join(', ')}) AND ${m.column} IS NOT NULL
         GROUP BY inverter_id`,
      ).bind(...binds.slice(0, 5 + ids.length)).all<{ id: string; days: number }>();
      for (const s of chosen) {
        const out = new Map<string, Figure>();
        // Read, but never as asked: a figure of nothing, from the days it was read - "never above", not "no record".
        const readDays = read.find((x) => x.id === s.id)?.days ?? 0;
        if (by === 'none' && readDays && !results.some((x) => x.id === s.id)) out.set('', { v: null, at: null, n: 0, of: readDays });
        for (const r of results.filter((x) => x.id === s.id)) {
          const of = stat === 'count' || !conds.length ? r.days : read.find((x) => x.id === s.id)?.days ?? r.days;
          out.set(String(r.b), {
            v: r.v == null ? null : stat === 'count' ? r.v : r.v / scale,
            at: r.t != null && stat !== 'average' && stat !== 'total' ? at(r.t, s.off ?? off) : null,
            n: stat === 'count' ? r.v ?? 0 : r.days, of,
          });
        }
        table.set(s.name, out);
      }
      if (!one) notes.push(`Each system on its own: ${words} at a moment is not added across systems here - a chart adds them.`);
      if (measure === 'grid') notes.push('Grid power is above zero while buying from the grid, and below zero while selling to it.');
      if (measure === 'battery_power') notes.push('Battery power is above zero while charging, and below zero while discharging.');
    }

    // The figures in words and as a table: one row a system, or one a bucket with a column a system.
    const facts: ToolResult['facts'] = {};
    const lines: string[] = [];
    const statWords: Record<FigureStat, string> = { total: 'Total', average: 'Average', highest: 'Highest', lowest: 'Lowest', count: 'Days', first: 'First', last: 'Last' };
    // A system that does not record this at all - an on-grid plant has no house meter - is said once, in a note.
    const recorded = (who: string) => [...table.get(who)!.values()].some((f) => f.v != null || f.of > 0);
    const silent = [...table.keys()].filter((who) => !recorded(who));
    const subjects = silent.length < table.size ? [...table.keys()].filter(recorded) : [...table.keys()];
    if (silent.length && silent.length < table.size) notes.unshift(`${inWords(silent)} ${silent.length === 1 ? 'has' : 'have'} no record of ${words} ${during}.`);
    if (!table.size) subjects.push(...chosen.map((s) => s.name));
    const said = (who: string, f: Figure | undefined): string => {
      if (!f || (f.v == null && !f.of)) return `${who}: no record of ${words} ${during}.`;
      // Recorded, but never as asked.
      if (f.v == null && stat !== 'count') return `${who}: ${words} was never ${cond ?? 'recorded'} ${during}.`;
      const when = f.at ? (isDay ? `on ${dayWords(f.at, true)}` : `on ${f.at.replace(/ (\d\d:\d\d)$/, ' at $1')}`) : '';
      switch (stat) {
        case 'total': return `${who}: ${show(f.v!)} of ${words} ${during}${cond ? `, on the ${f.n} day${f.n === 1 ? '' : 's'} it was ${cond}` : `, from ${f.n} day${f.n === 1 ? '' : 's'}`}.`;
        case 'average': return isDay
          ? `${who}: ${words} was ${show(f.v!)} on an average day ${during}${cond ? ` of those it was ${cond}` : ''}, from ${f.n} whole day${f.n === 1 ? '' : 's'}.`
          : `${who}: ${words} averaged ${show(f.v!)} ${during}${cond ? ` while it was ${cond}` : ''}, from ${f.n} day${f.n === 1 ? '' : 's'} of readings.`;
        case 'highest': case 'lowest': {
          // The grid and the battery run both ways, and the most sold or discharged is the lowest figure: said the way it flows.
          const v = f.v!;
          const most = (v < 0) === (stat === 'lowest');
          if (measure === 'grid' && v) return `${who}: the ${most ? 'most' : 'least'} ${v < 0 ? 'sold to' : 'bought from'} the grid at once was ${show(Math.abs(v))}, ${when}, ${during}.`;
          if (measure === 'battery_power' && v) return `${who}: the battery ${v < 0 ? 'discharged' : 'charged'} ${most ? 'fastest' : 'slowest'} at ${show(Math.abs(v))}, ${when}, ${during}.`;
          return `${who}: ${words} was at its ${stat}, ${show(v)}, ${when}, ${during}.`;
        }
        case 'count': return `${who}: ${words} was ${cond ?? 'recorded'} on ${f.v} of the ${f.of} day${f.of === 1 ? '' : 's'} ${isDay ? 'wholly recorded' : 'it was read'} ${during}.`;
        default: return f.at ? `${who}: ${words} was ${stat === 'first' ? 'first' : 'last'} ${cond ?? 'recorded'} ${when} (${show(f.v!)}), ${during}.` : `${who}: ${words} was never ${cond} ${during}.`;
      }
    };
    let rows: (string | number | null)[][];
    let columns: string[];
    let chart: ToolResult['chart'] | undefined;
    if (by === 'none') {
      const withWhen = stat === 'highest' || stat === 'lowest' || stat === 'first' || stat === 'last';
      columns = ['System', stat === 'count' ? `Days it was ${cond ?? 'recorded'}` : `${statWords[stat]} (${unit})`, ...(withWhen ? ['When'] : []), stat === 'count' ? 'Of days' : 'Days'];
      rows = subjects.map((who) => {
        const f = table.get(who)!.get('');
        facts[key(who, stat === 'count' ? 'days' : stat)] = f?.v == null ? null : stat === 'count' ? f.v : num(f.v);
        if (withWhen) facts[key(who, 'when')] = f?.at ?? null;
        lines.push(said(who, f));
        return [who, f?.v == null ? null : stat === 'count' ? f.v : num(f.v), ...(withWhen ? [f?.at ?? null] : []), f ? (stat === 'count' ? f.of : f.n) : 0];
      });
    } else {
      const keys = [...new Set(subjects.flatMap((who) => [...table.get(who)!.keys()]))]
        .sort((a, b) => (by === 'hour_of_day' || by === 'weekday' ? Number(a) - Number(b) : a.localeCompare(b)));
      const heading: Record<FigureBy, string> = { none: 'Period', hour_of_day: 'Hour', weekday: 'Weekday', day: 'Day', week: 'Week', month: 'Month', year: 'Year' };
      columns = [heading[by], ...subjects.map((who) => `${who} (${stat === 'count' ? 'days' : unit})`)];
      rows = keys.map((b) => [label(b), ...subjects.map((who) => {
        const f = table.get(who)!.get(b);
        return f?.v == null ? null : stat === 'count' ? f.v : num(f.v);
      })]);
      // Where each system's figure was highest and lowest, bucket by bucket.
      for (const [i, who] of subjects.entries()) {
        const got = rows.map((r) => ({ label: String(r[0]), v: r[i + 1] })).filter((x): x is { label: string; v: number } => typeof x.v === 'number');
        if (!got.length) { lines.push(`${who}: no record of ${words} ${during}.`); continue; }
        const top = got.reduce((a, x) => (x.v > a.v ? x : a));
        const low = got.reduce((a, x) => (x.v < a.v ? x : a));
        const fmt = (v: number) => (stat === 'count' ? `${v} day${v === 1 ? '' : 's'}` : show(v));
        Object.assign(facts, { [key(who, 'highest_bucket')]: top.label, [key(who, 'highest')]: top.v, [key(who, 'lowest_bucket')]: low.label, [key(who, 'lowest')]: low.v });
        lines.push(`${who}: ${words}, ${stat === 'count' ? `days it was ${cond ?? 'recorded'}` : statWords[stat].toLowerCase()} by ${by === 'hour_of_day' ? 'hour' : by} ${during} - `
          + `highest ${fmt(top.v)} (${top.label}), lowest ${fmt(low.v)} (${low.label}).`);
      }
      // The systems together where there is such a line; else up to two systems.
      const together = subjects.indexOf('Together');
      chart = { kind: by === 'hour_of_day' || by === 'day' ? 'line' : 'bar', columns: together >= 0 ? [together + 1] : subjects.slice(0, 2).map((_, i) => i + 1) };
    }
    if (isDay && stat !== 'total') notes.push('Whole days only - recorded from the morning into the afternoon - so part of a day, and today, are left out.');
    const title = `${words[0].toUpperCase()}${words.slice(1)}: ${stat === 'count' ? `days ${cond ?? 'recorded'}` : statWords[stat].toLowerCase()}${cond && stat !== 'count' ? `, ${cond}` : ''}${by !== 'none' ? `, by ${by === 'hour_of_day' ? 'hour' : by}` : ''}`;
    // Nothing on record at all is one sentence, not one a system.
    const none = silent.length === table.size && stat !== 'count';
    return {
      tool: 'figures', title, period: p, columns, rows, facts, notes: none ? notes.filter((n) => !n.includes('no record')) : notes,
      summary: none ? `There is no record of ${words}${cond ? ` ${cond}` : ''} ${during}.` : lines.join(' '),
      freshness, ...(chart && rows.length > 1 ? { chart } : {}),
    };
  },
};

// ---------------------------------------------------------------- report

const reportTool: Tool = {
  name: 'report',
  description: 'A full report on a period, in one: energy made, used, bought and sold with the money and CO2, each system side by side, the statistics with the best '
    + 'and worst days, the faults, and whether any system is slowly making less. For "a report on last month", "summarise the year", "write me a report".',
  params: { ...periodParams, system: systemParam },
  async run(ctx, args) {
    const all = await loadSystems(ctx.db);
    const chosen = pickSystems(all, args.system);
    const off = zoneOf(all);
    const p = resolvePeriod(args, ctx.now, off, DEFAULT_RANGE.report);
    const span = noOf(p.to) - noOf(p.from) + 1;
    // The period as it was asked - a named one reads as "last month (…)" in every section.
    const asked: Args = args.range ? { range: args.range } : { from: p.from, to: p.to };
    const periodArgs: Args = { ...asked, ...(args.system ? { system: args.system } : {}) };
    const energyR = await energy.run(ctx, { ...periodArgs, group_by: span <= 31 ? 'day' : 'month' });
    let statsR: ToolResult | null = null;
    try { statsR = await statsTool.run(ctx, periodArgs); } catch (e) { if (!(e instanceof ToolError)) throw e; }
    const compareR = chosen.length > 1 ? await compareSystems.run(ctx, asked) : null;
    const faultsR = await faults.run(ctx, periodArgs);
    const trendR = await performanceTrend.run(ctx, { ...(args.system ? { system: args.system } : {}), weeks: 12 });
    const sections = [energyR, compareR, statsR, faultsR, trendR].filter((x): x is ToolResult => !!x);

    const f = energyR.facts;
    const one = chosen.length === 1;
    const k = (name: string) => (one ? name : `${chosen[0].alias}_${name}`);
    const verdicts = trendR.rows.length ? chosen.map((s) => {
      const v = trendR.facts[one ? 'verdict' : `${s.alias}_verdict`];
      return `${s.name}: ${v}`;
    }).join('; ') : '—';
    const headline: [string, string | number | null][] = [
      ['Made (kWh)', f.total_made_kwh ?? null],
      ...(f.total_used_kwh != null ? [['Used by the house (kWh)', f.total_used_kwh] as [string, number]] : []),
      ...(f.total_imported_kwh != null ? [['Bought (kWh)', f.total_imported_kwh] as [string, number]] : []),
      ...(f.total_exported_kwh != null ? [['Sold (kWh)', f.total_exported_kwh] as [string, number]] : []),
      ...(f.saved != null ? [[`Saved (${f.currency})`, f.saved] as [string, number], ['CO₂ avoided (kg)', f.co2_avoided_kg] as [string, number]] : []),
      ...(one && statsR ? [['Best day', `${statsR.facts.best_day}: ${statsR.facts.best_kwh} kWh`] as [string, string], ['Worst day', `${statsR.facts.worst_day}: ${statsR.facts.worst_kwh} kWh`] as [string, string]] : []),
      ...(compareR?.facts.best_system ? [['Best per kWp', `${compareR.facts.best_system}: ${compareR.facts.best_kwh_per_kwp} kWh/kWp`] as [string, string]] : []),
      ['Faults', `${faultsR.facts.faults}${faultsR.facts.still_active ? ` (${faultsR.facts.still_active} still active)` : ''}`],
      ['Health', verdicts],
    ];
    const facts: ToolResult['facts'] = { ...f, faults: faultsR.facts.faults, faults_still_active: faultsR.facts.still_active };
    if (compareR) Object.assign(facts, { best_system: compareR.facts.best_system ?? null, best_kwh_per_kwp: compareR.facts.best_kwh_per_kwp ?? null });
    if (statsR && one) Object.assign(facts, { best_day: statsR.facts[k('best_day')], best_day_kwh: statsR.facts[k('best_kwh')], worst_day: statsR.facts[k('worst_day')], worst_day_kwh: statsR.facts[k('worst_kwh')] });
    const summary = [energyR.summary, compareR && chosen.length > 1 ? compareR.summary : '', faultsR.summary,
      trendR.summary].filter(Boolean).join(' ');
    const notes = [...new Set(sections.flatMap((x) => x.notes))];
    return {
      tool: 'report',
      title: `Report${one ? `: ${chosen[0].name}` : ''}`,
      period: { ...p },
      columns: ['', 'Figure'],
      rows: headline,
      facts,
      notes,
      summary,
      freshness: energyR.freshness,
      sections,
    };
  },
};

// ---------------------------------------------------------------- app_help

const appHelp: Tool = {
  name: 'app_help',
  description: 'How to do something in SolarLens, and where: signing in, sharing, notifications, alerts on Telegram or Discord, Home Assistant, the tariff, groups, '
    + 'reports, the MCP server, a system that reads offline - and what a word means: kW and kWh, kWp, performance ratio, capacity factor, self-consumption, '
    + 'net metering, SOC and the BMS, battery modes, strings and MPPT, power factor, the always-on load, irradiance, the datalogger. '
    + 'For any question about using the app, or its words, rather than about the figures.',
  params: { question: { type: 'string', description: "The question, in the owner's own words." } },
  async run(_ctx, args) {
    const found = findHelp(String(args.question));
    const list = found.length ? found : [HELP.find((e) => e.topic === 'The assistant, and reports')!];
    return {
      tool: 'app_help',
      title: 'In SolarLens',
      period: null,
      columns: ['Topic', 'How', 'Where'],
      rows: list.map((e) => [e.topic, e.answer, e.where]),
      facts: {},
      notes: found.length ? [] : ['Nothing in the guide matched the question; this is what the assistant can do.'],
      summary: list[0].answer,
      freshness: { newest: null, offline: [] },
    };
  },
};

// ---------------------------------------------------------------- the list

/** Every tool, in the order a person would reach for them. */
export const TOOLS: readonly Tool[] = [
  statusNow, outages, inverterTool, energy, powerDay, chartTool, batteryTool, compareSystems, statsTool, faults, dayReport, performanceTrend, analysisTool, figuresTool, reportTool, appHelp,
];

export const toolByName = (name: unknown): Tool | undefined => TOOLS.find((t) => t.name === name);

/**
 * Run a tool by name with arguments as given - checked first. Returns the
 * result, or why the arguments do not let it answer.
 */
export async function runTool(db: D1Database, name: string, raw: unknown, now = nowSec()): Promise<{ result: ToolResult; args: Args } | { error: string }> {
  const tool = toolByName(name);
  if (!tool) return { error: `There is no tool called ${String(name).slice(0, 40)}.` };
  const args = checkArgs(tool, raw);
  if (typeof args === 'string') return { error: args };
  try {
    return { result: await tool.run({ db, now }, args), args };
  } catch (e) {
    if (e instanceof ToolError) return { error: e.message };
    throw e;
  }
}
