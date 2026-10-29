/**
 * The agents: the weekly report, the health check, and - through Ask
 * SolarLens's direct tool calls - "why was this day low?".
 *
 * Each is the read-only tools (./tools) put to one purpose on a schedule, with
 * the model only where words help:
 *
 * - **The health check** runs every Monday. For each system it takes the
 *   performance ratio - energy made against the sunlight on its panels - week
 *   by week over twelve weeks, and compares the last four with the eight
 *   before. A fall of 8% or more is flagged: dirt, shade, a failing panel or a
 *   string down look exactly like that, and too slow for anyone to notice on
 *   the day. Decided by the figures alone, never by the model; a flagged system
 *   is then an alert like any other (./push), told once.
 * - **The weekly report** is written after it: last week against the one
 *   before (./summary), the lowest day and its likely cause (the day_report
 *   tool), the health check, and the week analysed (the analysis tool) - what
 *   needs a look, and what to do about it - in three to five sentences by the
 *   model, held to the figures like any answer (./ask numbersAgree), and written
 *   from them by SolarLens itself when there is no model or no call left. It is
 *   kept for the Ask tab, and goes out with the weekly summary.
 * - **Why was this day low?** needs no schedule: the day_report tool, asked
 *   for directly from Historical Data or in a question.
 *
 * Reports are kept a year in agent_reports (migration 0019).
 */
import { aiModel, chat, dailyCalls, hasAi, takeCall } from './ai';
import { numbersAgree } from './ask';
import { daily, nowSec, type Env } from './db';
import { buildSummary, summaryMessage, weekSlot } from './summary';
import { dayWords, isoDay, loadSystems, runTool, trendWords, trends, zoneOf, type ToolResult } from './tools';

const WEEKS = 12;
const DONE_KEY = 'agents:week';
const KEEP_S = 400 * 86400;

const WEEKLY_PROMPT = [
  'You write a short weekly note for the owner of a solar installation, from the figures given only.',
  'Three to five plain sentences: how last week went against the week before; anything that stands out, such as a low day and its likely cause,',
  'or a system making less for its sunlight; and, from the analysis, what needs a look and what to do about it.',
  'Quote numbers exactly as they appear, with their units. Do not add, subtract, average, convert or otherwise work out any number that is not given.',
  'Plain text only: no markdown, no lists, no greeting, no sign-off.',
].join('\n');

/** A report as the Ask tab shows it. */
export interface Report {
  kind: 'weekly' | 'health';
  week_of: string;
  title: string;
  body: string;
  worded: 'model' | 'solarlens';
  flagged: boolean;
  created_at: number;
  system?: string | null;
  name?: string | null;
  data?: unknown;
}

/**
 * Run the week's agents once, from the first cron run after Monday 08:00 on
 * the first system's clock - the same moment as the weekly summary, which the
 * report then goes out with. The week is claimed in one conditional write
 * first, so two runs at once cannot both do it. Returns whether it ran.
 */
export async function runWeeklyAgents(env: Env, now = nowSec()): Promise<boolean> {
  const systems = await loadSystems(env.DB);
  if (!systems.length) return false;
  const slot = weekSlot(now, zoneOf(systems));
  const forever = now + 100 * 365 * 86400;
  const claim = await env.DB
    .prepare(
      `INSERT INTO kv (k, v, expires_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v WHERE CAST(kv.v AS INTEGER) < CAST(excluded.v AS INTEGER)`,
    )
    .bind(DONE_KEY, String(slot), forever)
    .run();
  if (!claim.meta.changes) return false;
  const health = await healthCheck(env, slot, now);
  await weeklyReport(env, slot, health, now);
  await env.DB.prepare('DELETE FROM agent_reports WHERE created_at < ?1').bind(now - KEEP_S).run();
  return true;
}

/** Every system's twelve weeks, stored as one health report each, flagged when declining. */
export async function healthCheck(env: Env, slot: number, now = nowSec()): Promise<Awaited<ReturnType<typeof trends>>> {
  const systems = await loadSystems(env.DB);
  const found = await trends(env.DB, systems, WEEKS, now, zoneOf(systems));
  const weekOf = dayWords(isoDay(slot));
  const stmts = found.trends.map((t) => env.DB
    .prepare(
      `INSERT OR REPLACE INTO agent_reports (id, kind, week, inverter_id, title, body, data, worded, flagged, created_at)
       VALUES (?1, 'health', ?2, ?3, ?4, ?5, ?6, 'solarlens', ?7, ?8)`,
    )
    .bind(`health:${slot}:${t.system.id}`, slot, t.system.id, `${t.system.name}: health, week of ${weekOf}`, trendWords(t, WEEKS),
      JSON.stringify({ verdict: t.verdict, change_pct: t.change_pct, recent: t.recent, earlier: t.earlier, weekly: t.weekly, mondays: found.mondays }),
      t.verdict === 'declining' ? 1 : 0, now));
  if (stmts.length) await env.DB.batch(stmts);
  return found;
}

/**
 * The weekly report: the week in figures, then in words. The figures are
 * gathered by the Worker; the model, when there is one and a call left today,
 * writes them up and is held to them.
 */
export async function weeklyReport(env: Env, slot: number, health: Awaited<ReturnType<typeof trends>>, now = nowSec()): Promise<Report> {
  const summary = await buildSummary(env.DB, now);
  const words = summaryMessage(summary);
  // The week's lowest day, all systems together, explained.
  const off = zoneOf(await loadSystems(env.DB));
  const byDay = new Map<string, number>();
  for (const r of await daily(env.DB, now - 9 * 86400, now, -off / 60)) {
    if (r.day >= summary.from && r.day <= summary.to && r.yield_kwh != null) byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.yield_kwh);
  }
  const lowest = [...byDay].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0]?.[0];
  const low = lowest ? await runTool(env.DB, 'day_report', { date: lowest }, now) : null;
  const lowDay = low && 'result' in low ? low.result : null;
  const notable = health.trends.filter((t) => t.verdict === 'declining' || t.verdict === 'improving');
  // The week analysed, as the Ask tab analyses any period: what needs a look, and what to do about it.
  const analysed = await runTool(env.DB, 'analysis', { from: summary.from, to: summary.to }, now);
  const findings = 'result' in analysed
    ? analysed.result.rows.map(([stands, area, said, todo]) => ({ stands: String(stands), area: String(area), said: String(said), todo: todo == null ? null : String(todo) }))
    : [];
  // A system slowly making less is said by the health check already.
  const toLook = findings.filter((f) => f.stands === 'Needs a look' && f.area !== 'Production');
  const todos = [...new Set(toLook.map((f) => f.todo).filter((t): t is string => !!t))];

  const facts = {
    week: { from: summary.from, to: summary.to },
    summary: words.body,
    lowest_day: lowDay ? { day: lowDay.period?.label, explained: lowDay.summary } : null,
    health: health.trends.map((t) => trendWords(t, WEEKS)),
    analysis: findings,
  };
  const fallback = [
    words.body.split('\n')[0],
    lowDay ? `The lowest day was ${lowDay.period?.label}: ${lowDay.summary}` : '',
    notable.length ? notable.map((t) => trendWords(t, WEEKS)).join(' ') : 'Every system is steady for its sunlight.',
    toLook.length ? `Needs a look: ${toLook.map((f) => f.said).join(' ')}${todos.length ? ` What to do: ${todos.join(' ')}` : ''}` : '',
  ].filter(Boolean).join(' ');

  let body = fallback;
  let worded: Report['worded'] = 'solarlens';
  if (hasAi(env) && (await takeCall(env.DB, dailyCalls(env), now))) {
    try {
      const { text } = await chat(env, [{ role: 'system', content: WEEKLY_PROMPT }, { role: 'user', content: JSON.stringify(facts) }], { maxTokens: 320 });
      const said = text.replace(/\s+/g, ' ').trim().slice(0, 1200);
      // Held to the figures it was given, like any answer.
      const evidence: ToolResult = {
        tool: 'weekly_report', title: '', period: null, columns: [], rows: [],
        facts: { data: JSON.stringify(facts) }, notes: [], summary: fallback, freshness: { newest: null, offline: [] },
      };
      if (said && numbersAgree(said, evidence)) { body = said; worded = 'model'; }
    } catch (e) {
      console.warn(JSON.stringify({ agents: 'weekly report wording failed', model: aiModel(env), error: String(e).slice(0, 200) }));
    }
  }
  const title = `Week of ${dayWords(summary.from)}`;
  await env.DB
    .prepare(
      `INSERT OR REPLACE INTO agent_reports (id, kind, week, inverter_id, title, body, data, worded, flagged, created_at)
       VALUES (?1, 'weekly', ?2, NULL, ?3, ?4, ?5, ?6, 0, ?7)`,
    )
    .bind(`weekly:${slot}`, slot, title, body, JSON.stringify(facts), worded, now)
    .run();
  return { kind: 'weekly', week_of: isoDay(slot), title, body, worded, flagged: false, created_at: now };
}

/**
 * The newest weekly report, and each system's newest health check from the
 * last fortnight, for the Ask tab: systems by alias and name, never by id.
 */
export async function latestReports(db: D1Database, now = nowSec()): Promise<{ weekly: Report | null; health: Report[] }> {
  const systems = await loadSystems(db);
  const weekly = await db
    .prepare("SELECT * FROM agent_reports WHERE kind = 'weekly' ORDER BY week DESC LIMIT 1")
    .first<{ week: number; title: string; body: string; worded: Report['worded']; created_at: number }>();
  const { results } = await db
    .prepare(
      `SELECT a.* FROM agent_reports a
       WHERE a.kind = 'health' AND a.created_at >= ?1
         AND a.week = (SELECT MAX(week) FROM agent_reports b WHERE b.kind = 'health' AND b.inverter_id = a.inverter_id)`,
    )
    .bind(now - 14 * 86400)
    .all<{ week: number; inverter_id: string; title: string; body: string; data: string | null; worded: Report['worded']; flagged: number; created_at: number }>();
  const health = systems.flatMap((s) => {
    const r = results.find((x) => x.inverter_id === s.id);
    if (!r) return [];
    let data: unknown = null;
    try { data = r.data ? JSON.parse(r.data) : null; } catch { data = null; }
    return [{ kind: 'health' as const, week_of: isoDay(r.week), title: r.title, body: r.body, worded: r.worded, flagged: !!r.flagged, created_at: r.created_at, system: s.alias, name: s.name, data }];
  });
  return {
    weekly: weekly ? { kind: 'weekly', week_of: isoDay(weekly.week), title: weekly.title, body: weekly.body, worded: weekly.worded, flagged: false, created_at: weekly.created_at } : null,
    health,
  };
}
