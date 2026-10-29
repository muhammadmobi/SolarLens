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
import { daily, inverterIds, latest, listAlarms, listPeriods, nowSec, series, type DayRow } from './db';
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
  | { type: 'integer'; description: string; min: number; max: number; optional?: boolean };

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

/** "3 h 10 min", "45 min". */
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
  const rows = (await latest(db)).filter((r) => systems.some((s) => s.id === r.id));
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
    properties[name] = spec.type === 'integer'
      ? { type: 'integer', minimum: spec.min, maximum: spec.max, description: spec.description }
      : { type: 'string', description: spec.description, ...(spec.enum ? { enum: [...spec.enum] } : {}), ...(spec.pattern ? { pattern: spec.pattern.source } : {}) };
  }
  const required = Object.entries(tool.params).filter(([, s]) => !s.optional).map(([n]) => n);
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

// ---------------------------------------------------------------- status_now

const statusNow: Tool = {
  name: 'status_now',
  description: 'What each system is doing right now: its power, what it has made today, its battery, and whether it is reporting.',
  params: { system: systemParam },
  async run({ db, now }, args) {
    const all = await loadSystems(db);
    const chosen = pickSystems(all, args.system);
    const off = zoneOf(all);
    const live = (await latest(db)).filter((r) => chosen.some((s) => s.id === r.id));
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
    return {
      tool: 'status_now',
      title: 'Right now',
      period: { from: isoDay(dayNo(now, off)), to: isoDay(dayNo(now, off)), label: `today (${dayWords(isoDay(dayNo(now, off)), true)})` },
      columns: ['System', 'Status', 'Power now (W)', 'Made today (kWh)', 'Battery (%)', 'Last reading'],
      rows,
      facts: { power_now_w: power, made_today_kwh: today, reporting: online, systems: chosen.length },
      notes: freshness.offline.length ? [`Not reporting now: ${freshness.offline.join(', ')}. An offline system counts as making nothing.`] : [],
      summary: `${who} ${chosen.length === 1 ? 'is' : 'are'} making ${power >= 1000 ? `${r2(power / 1000)} kW` : `${power} W`} now, and ${kwh(today)} so far today`
        + `${chosen.length > 1 ? `; ${online} of ${chosen.length} reporting` : online ? '' : '; it is not reporting'}.`,
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
    + 'for one system or all together. For "how much", "which month was best", "how much did I export". With the tariff set, also the money saved and the CO2 avoided.',
  params: {
    ...periodParams,
    group_by: { type: 'string', enum: ['day', 'week', 'month', 'year', 'total'], description: 'How to split the period; by default days for a month or less, months for up to a year, else years.', optional: true },
    measure: { type: 'string', enum: ['made', 'used', 'imported', 'exported', 'all'], description: 'Which energy the question is about; all by default.', optional: true },
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
    const measure = (args.measure as Measure | 'all' | undefined) ?? 'all';
    const focus: Measure = measure === 'all' ? 'made' : measure;
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
      if (measure !== m && measure !== 'all') continue;
      const blind = chosen.filter((s) => !days.some((d) => d.inverter_id === s.id && d[fieldOf[m]] != null));
      if (blind.length && blind.length < chosen.length) notes.push(`${blind.map((s) => s.name).join(', ')} ${blind.length === 1 ? 'does' : 'do'} not report what ${m === 'used' ? 'the house used' : `was ${m === 'imported' ? 'bought' : 'sold'}`}.`);
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
      : `${who} ${verb[focus]} ${kwh(total as number)} ${focus === 'used' && chosen.length > 1 ? 'in the houses ' : ''}${focus === 'imported' ? 'from the grid ' : focus === 'exported' ? 'to the grid ' : ''}${p.label}.`;
    if (facts[`highest_${focus}_period`]) {
      summary += ` The ${group === 'total' ? 'best' : `best ${group}`} was ${facts[`highest_${focus}_period`]} with ${kwh(facts[`highest_${focus}_kwh`] as number)}; the lowest was ${facts[`lowest_${focus}_period`]} with ${kwh(facts[`lowest_${focus}_kwh`] as number)}.`;
    }
    if (facts.saved != null && focus === 'made') summary += ` That saved about ${facts.saved} ${facts.currency} and avoided ${facts.co2_avoided_kg} kg of CO2.`;
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
      else if (!causes.length) causes.push(share != null ? `a little below usual (${Math.round(share * 100)}%), with no one cause` : 'too little record before it to say what is usual');

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
  const today = dayNo(now, off);
  const thisMonday = today - ((utc(today).getUTCDay() + 6) % 7);
  const first = thisMonday - 7 * weeks;
  const [rows, weather] = await Promise.all([
    daily(db, (first - 1) * DAY - off, (thisMonday + 1) * DAY - off, -off / 60),
    weatherSince(db, (first - 1) * DAY - off),
  ]);
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
/** Watts as kW for a sentence: "2.35 kW". */
const kw = (w: number) => `${r2(w / 1000)} kW`;
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

// ---------------------------------------------------------------- outages

/** Sunlight above this, W/m2, is day: a system silent then has stopped, not gone to sleep. */
const DAYLIGHT_WM2 = 100;
/** A day and a time on a plant's clock: "Sun 27 Sep 2026 19:10". */
const at = (ts: number, off: number) => `${dayWords(isoDay(dayNo(ts, off)), true)} ${clock(ts, off)}`;

const outages: Tool = {
  name: 'outages',
  description: 'When each system stopped reporting and when it came back: whether it is reporting now and since when not, the last time it made power, '
    + 'and each stretch of daylight with no readings over a period - the last 7 days unless one is named, a month at most. Silence at night is not counted. '
    + 'For "since when is it offline", "when did it stop working", "when did it last generate", "how often does it drop out".',
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
    const [live, points, weather] = await Promise.all([latest(db), series(db, from, until), weatherSince(db, from)]);

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
      else if (on) said = `${s.name} is reporting now (last reading ${clock(lastSeen, o)}).`;
      else {
        const darkThen = !light(lastSeen);
        const darkNow = !light(now);
        const battery = r?.battery_soc != null;
        said = `${s.name} has not reported since ${at(lastSeen, o)}, ${duration(now - lastSeen)} ago`;
        if (darkThen && darkNow && !battery) said += ': it went quiet after dark, when an inverter without a battery switches off, so this is expected until sunrise.';
        else {
          said += darkThen ? ', after dark, and it has not come back' : ', in daylight';
          said += s.provider === 'soliscloud'
            ? '. Its figures come through the relay: check the relay laptop is on and its SolisCloud login is current (Devices tab).'
            : '. The vendor may be down, or the logger may have lost its network.';
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
    + 'how much days vary, kWh per kWp, capacity factor, low days, and the average day against the same length of time just before. For "statistics", "average day", "how consistent".',
  params: { ...periodParams, system: systemParam },
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
      lines.push(`${s.name}: ${n} day${n === 1 ? '' : 's'}, ${kwh(total)} - ${kwh(mean)} on an average day (median ${r1(mid)}); `
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
    + 'reports, the MCP server, a system that reads offline. For any question about using the app rather than about the figures.',
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
export const TOOLS: readonly Tool[] = [statusNow, outages, energy, powerDay, compareSystems, statsTool, faults, dayReport, performanceTrend, reportTool, appHelp];

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
