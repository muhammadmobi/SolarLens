/**
 * The weekly summary: how the last seven days went, posted every Monday
 * morning to the channels that take it (./channels), and served at
 * GET /api/summary for anything that would rather ask.
 *
 * What it says, in the order a person wants it: how much was made, against
 * the week before; each system's share and its best day, and on how many days
 * it reported; what that was worth by the owner's tariff and the CO2 it
 * avoided; and how many faults were recorded. Everything comes from what the
 * Worker already keeps - the daily rows (../db daily), the tariff, the alarms -
 * so the summary costs a few reads and no vendor call.
 *
 * "A week" is the seven full days before today where the plants are: the
 * first system's clock, the same one the schedule runs on. Sent on Monday, it
 * is Monday to Sunday.
 */
import { channelsFor, deliver, type Message } from './channels';
import { daily, inverterIds, nowSec, type Env } from './db';
import { aliasFor } from './public-view';
import { getTariff, valueOf } from './settings';

export const SUMMARY_DAYS = 7;
/** When it goes out: Monday, at 08:00 on the first system's clock. */
export const SEND_DOW = 1;
export const SEND_HOUR = 8;
/** Where the last week sent is remembered, as the day number of its Monday. */
const SENT_KEY = 'summary:week';
/**
 * How long past its time the summary waits for the week's report (./agents),
 * which it carries: long enough for the agents' tries, an hour apart.
 */
export const REPORT_WAIT_S = 3 * 3600;

/** One system's week. */
export interface SystemWeek {
  /** The system's alias, as every public answer names it. */
  id: string;
  name: string | null;
  kwh: number;
  /** The seven days before, or null when nothing was recorded then. */
  prev_kwh: number | null;
  /** How many of the days have a record. */
  days: number;
  best_day: string | null;
  best_kwh: number | null;
  faults: number;
}

export interface Summary {
  now: number;
  /** The first and last day covered, on the plants' calendar: '2026-09-21'. */
  from: string;
  to: string;
  days: number;
  total_kwh: number;
  /** The days before, for the systems that have a record of them; null when none has. */
  prev_total_kwh: number | null;
  /**
   * The change against the days before, in percent, over only the systems
   * recorded in both - so a system added this week is not "more energy".
   */
  change_pct: number | null;
  systems: SystemWeek[];
  /** Money saved by the owner's tariff, or null without one. */
  saved: number | null;
  currency: string | null;
  /** Whether some of the saving is an upper bound (an export the vendor did not give). */
  saved_assumed: boolean;
  co2_kg: number | null;
  faults: number;
  faults_active: number;
}

/** Days since 1970-01-01, on a clock `off` seconds east of UTC. */
const dayNo = (ts: number, off: number) => Math.floor((ts + off) / 86400);
const isoDay = (n: number) => new Date(n * 86400 * 1000).toISOString().slice(0, 10);
const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * The `n` full days ending yesterday on a clock `off` seconds east of UTC,
 * oldest first, the `n` before them, and the instants the first set runs
 * between.
 */
export function summaryWindow(now: number, off: number, n = SUMMARY_DAYS) {
  const today = dayNo(now, off);
  return {
    days: Array.from({ length: n }, (_, i) => isoDay(today - n + i)),
    before: Array.from({ length: n }, (_, i) => isoDay(today - 2 * n + i)),
    startTs: (today - n) * 86400 - off,
    endTs: today * 86400 - off,
  };
}

/** The first system's clock, as the page orders the systems; UTC when no vendor has said. */
async function zoneOf(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      `SELECT tz_offset_sec FROM inverters WHERE enabled = 1 AND tz_offset_sec IS NOT NULL
       ORDER BY display_order, CASE provider WHEN 'soliscloud' THEN 0 WHEN 'solarman' THEN 1 ELSE 2 END, id LIMIT 1`,
    )
    .first<{ tz_offset_sec: number }>();
  return row?.tz_offset_sec ?? 0;
}

/** The last `n` full days, system by system, with the week before for comparison. */
export async function buildSummary(db: D1Database, now = nowSec(), n = SUMMARY_DAYS): Promise<Summary> {
  const off = await zoneOf(db);
  const w = summaryWindow(now, off, n);
  const { results: invs } = await db
    .prepare(
      `SELECT id, name FROM inverters WHERE enabled = 1
       ORDER BY display_order, CASE provider WHEN 'soliscloud' THEN 0 WHEN 'solarman' THEN 1 ELSE 2 END, id`,
    )
    .all<{ id: string; name: string | null }>();
  // A day's margin either side: a plant in another zone labels its own days,
  // and its first and last may sit just outside the window's instants.
  const [rows, tariff, ids, alarmRows] = await Promise.all([
    daily(db, w.startTs - (n + 1) * 86400, now, -off / 60),
    getTariff(db),
    inverterIds(db),
    db.prepare(
      `SELECT inverter_id, COUNT(*) AS n, SUM(CASE WHEN end_ts IS NULL AND state = 'active' THEN 1 ELSE 0 END) AS active
       FROM alarms WHERE begin_ts >= ?1 AND begin_ts < ?2 GROUP BY inverter_id`,
    ).bind(w.startTs, w.endTs).all<{ inverter_id: string; n: number; active: number }>(),
  ]);
  const alias = aliasFor(ids);
  const thisWeek = new Set(w.days);
  const lastWeek = new Set(w.before);

  let saved = 0;
  let co2 = 0;
  let assumed = false;
  const systems: SystemWeek[] = invs.map((inv) => {
    const mine = rows.filter((r) => r.inverter_id === inv.id && r.yield_kwh != null);
    // Oldest first, so that of two equal days the earlier is the best one.
    const now7 = mine.filter((r) => thisWeek.has(r.day)).sort((a, b) => a.day.localeCompare(b.day));
    const prev7 = mine.filter((r) => lastWeek.has(r.day));
    const best = now7.reduce<(typeof now7)[number] | null>((b, r) => (!b || (r.yield_kwh ?? 0) > (b.yield_kwh ?? 0) ? r : b), null);
    for (const r of now7) {
      const v = valueOf(r.yield_kwh, r.export_kwh, tariff);
      if (!v) continue;
      saved += v.money;
      co2 += v.co2;
      assumed ||= v.assumed;
    }
    const faults = alarmRows.results.find((a) => a.inverter_id === inv.id);
    return {
      id: alias(inv.id) ?? 'unknown',
      name: inv.name,
      kwh: round1(now7.reduce((a, r) => a + (r.yield_kwh ?? 0), 0)),
      prev_kwh: prev7.length ? round1(prev7.reduce((a, r) => a + (r.yield_kwh ?? 0), 0)) : null,
      days: now7.length,
      best_day: best?.day ?? null,
      best_kwh: best ? round1(best.yield_kwh ?? 0) : null,
      faults: faults?.n ?? 0,
    };
  });
  const withPrev = systems.filter((s) => s.prev_kwh !== null);
  const prevTotal = withPrev.reduce((a, s) => a + (s.prev_kwh ?? 0), 0);
  return {
    now,
    from: w.days[0],
    to: w.days[n - 1],
    days: n,
    total_kwh: round1(systems.reduce((a, s) => a + s.kwh, 0)),
    prev_total_kwh: withPrev.length ? round1(prevTotal) : null,
    change_pct: change(withPrev.reduce((a, s) => a + s.kwh, 0), withPrev.length ? prevTotal : null),
    systems,
    saved: tariff ? round2(saved) : null,
    currency: tariff?.currency ?? null,
    saved_assumed: !!tariff && assumed,
    co2_kg: tariff ? round1(co2) : null,
    faults: alarmRows.results.reduce((a, r) => a + r.n, 0),
    faults_active: alarmRows.results.reduce((a, r) => a + (r.active ?? 0), 0),
  };
}

// ---------------------------------------------------------------- in words

const kwh = (v: number) => (v >= 10000 ? `${(v / 1000).toFixed(1)} MWh` : v >= 100 ? `${Math.round(v)} kWh` : `${v.toFixed(1)} kWh`);
const co2Text = (kg: number) => (kg >= 1000 ? `${(kg / 1000).toFixed(2)} t` : `${Math.round(kg)} kg`);
// Spelled out rather than left to Intl, whose short month differs between
// runtimes ("Sep" in one, "Sept" in another): the message reads the same wherever it is made.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2026-09-24' as "Thu 24 Sep", or "24 Sep". */
function day(iso: string, withWeekday = true): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return `${withWeekday ? `${WEEKDAYS[d.getUTCDay()]} ` : ''}${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
function money(v: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency, maximumFractionDigits: v >= 100 ? 0 : 2 }).format(v);
  } catch {
    return `${v.toFixed(v >= 100 ? 0 : 2)} ${currency}`;
  }
}
/** The change in percent, rounded, or null when there is nothing to compare with. */
function change(now: number, before: number | null): number | null {
  if (before === null || before <= 0) return null;
  return Math.round(((now - before) / before) * 100);
}

/** The summary as a message: a title that says the week's total, and a few short lines. */
export function summaryMessage(s: Summary): Message {
  const week = s.days === 7;
  const title = `${week ? 'Last week' : `The last ${s.days} days`}: ${kwh(s.total_kwh)} made`;
  const lines: string[] = [];
  const pct = s.change_pct;
  const against = week ? 'the week before' : `the ${s.days} days before`;
  lines.push(`${day(s.from, false)} to ${day(s.to, false)}: ${kwh(s.total_kwh)}${pct === null ? '' : Math.abs(pct) < 1
    ? `, about the same as ${against}` : `, ${Math.abs(pct)}% ${pct > 0 ? 'more' : 'less'} than ${against}`}.`);
  if (!s.systems.some((x) => x.days)) lines.push('No readings were recorded.');
  for (const x of s.systems) {
    if (!x.days) { if (s.systems.length > 1) lines.push(`${x.name ?? x.id}: nothing recorded.`); continue; }
    const p = change(x.kwh, x.prev_kwh);
    const missing = x.days < s.days ? `, reported on ${x.days} of ${s.days} days` : '';
    const best = x.best_day ? `best ${day(x.best_day)} with ${kwh(x.best_kwh ?? 0)}` : '';
    lines.push(s.systems.length > 1
      ? `${x.name ?? x.id}: ${kwh(x.kwh)}${p === null ? '' : ` (${p > 0 ? '+' : ''}${p}%)`}${missing}; ${best}.`
      : `Best day: ${best.replace(/^best /, '')}${missing}.`);
  }
  if (s.saved !== null && s.currency && s.co2_kg !== null) {
    lines.push(`Saved ${s.saved_assumed ? 'up to' : 'about'} ${money(s.saved, s.currency)} and avoided ${co2Text(s.co2_kg)} of CO₂.`);
  }
  lines.push(s.faults
    ? `${s.faults} fault${s.faults === 1 ? '' : 's'} recorded${s.faults_active ? `, ${s.faults_active} still active` : ''}.`
    : 'No faults recorded.');
  return { kind: 'summary', title, body: lines.join('\n'), path: '#/history', ts: s.now };
}

// ---------------------------------------------------------------- when it goes out

/**
 * The day number of the Monday whose 08:00 has most recently passed, on a
 * clock `off` seconds east of UTC: the week a summary sent now belongs to.
 */
export function weekSlot(now: number, off: number): number {
  const local = now + off;
  const d = Math.floor(local / 86400);
  const dow = (((d + 4) % 7) + 7) % 7;          // 0 = Sunday; 1 January 1970 was a Thursday
  let monday = d - ((dow - SEND_DOW + 7) % 7);
  if (local < monday * 86400 + SEND_HOUR * 3600) monday -= 7;
  return monday;
}

/**
 * Send the weekly summary to every channel that takes it, once a week, from
 * the first hourly run after Monday 08:00 on the first system's clock - so a
 * Worker that was down then sends it at the next run rather than skipping a
 * week. The first time any channel takes it, the week is only marked: the
 * first summary comes the next Monday, not the moment a channel is added.
 *
 * It carries the week's report, so it waits for it: until the agents have
 * written it (./agents, which run first, and are tried again an hour later if
 * they fail), or REPORT_WAIT_S past its time, when it goes without.
 *
 * The week is claimed before anything is posted, in one conditional write, so
 * two runs at once cannot both send it; a channel that fails is not retried,
 * and its failure shows in Settings. Returns whether it was sent.
 */
export async function sendWeekly(env: Env, now = nowSec()): Promise<boolean> {
  const rows = await channelsFor(env.DB, 'weekly');
  if (!rows.length) return false;
  const off = await zoneOf(env.DB);
  const slot = weekSlot(now, off);
  const seen = await env.DB.prepare('SELECT v FROM kv WHERE k = ?1').bind(SENT_KEY).first<{ v: string }>();
  const forever = now + 100 * 365 * 86400;
  if (!seen) {
    await env.DB.prepare('INSERT OR IGNORE INTO kv (k, v, expires_at) VALUES (?1, ?2, ?3)').bind(SENT_KEY, String(slot), forever).run();
    return false;
  }
  if (Number(seen.v) >= slot) return false;
  const due = slot * 86400 + SEND_HOUR * 3600 - off;
  const report = await env.DB.prepare("SELECT 1 FROM agent_reports WHERE kind = 'weekly' AND week = ?1").bind(slot).first();
  if (!report && now < due + REPORT_WAIT_S) return false;
  const claimed = await env.DB
    .prepare('UPDATE kv SET v = ?2 WHERE k = ?1 AND CAST(v AS INTEGER) < ?3')
    .bind(SENT_KEY, String(slot), slot)
    .run();
  if (!claimed.meta.changes) return false;
  const msg = await withReport(env.DB, summaryMessage(await buildSummary(env.DB, now)), slot);
  for (const row of rows) await deliver(env, row, msg, now);
  return true;
}

/**
 * The summary with the agents' note on the same week (./agents weeklyReport)
 * added, when it has been written - which, at the same Monday run, it has.
 */
export async function withReport(db: D1Database, msg: Message, slot: number): Promise<Message> {
  const report = await db.prepare("SELECT body FROM agent_reports WHERE kind = 'weekly' AND week = ?1").bind(slot).first<{ body: string }>();
  return report ? { ...msg, body: `${msg.body}\n\nIn short: ${report.body}` } : msg;
}

/** The week a summary sent now belongs to, on the first system's clock. */
export async function currentSlot(db: D1Database, now = nowSec()): Promise<number> {
  return weekSlot(now, await zoneOf(db));
}
