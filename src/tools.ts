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
const duration = (s: number) => {
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`;
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
    let s = String(v).trim().slice(0, 80);
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
    const p = resolvePeriod(args, now, off, 'this_month');
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
    const sums = [...grouped.values()].map((g) => ({
      label: g.label,
      ...(Object.fromEntries(MEASURES.map((m) => [m, sumOrNull(g.figs.map((f) => f[m]))])) as unknown as Figures),
    }));
    const present = MEASURES.filter((m) => sums.some((s) => s[m] != null));
    const rows = sums.map((s) => [s.label, ...present.map((m) => (s[m] == null ? null : r1(s[m] as number)))]);

    const facts: ToolResult['facts'] = {};
    for (const m of present) facts[`total_${m}_kwh`] = r1(sums.reduce((a, s) => a + ((s[m] as number | null) ?? 0), 0));
    const measure = (args.measure as Measure | 'all' | undefined) ?? 'all';
    const focus: Measure = measure === 'all' ? 'made' : measure;
    const withData = sums.filter((s) => s[focus] != null);
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
    const p = resolvePeriod(args, now, off, 'this_month');
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
    const p = resolvePeriod(args, now, off, 'last_30_days');
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

// ---------------------------------------------------------------- the list

/** Every tool, in the order a person would reach for them. */
export const TOOLS: readonly Tool[] = [statusNow, energy, compareSystems, faults, dayReport, performanceTrend];

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
