/**
 * The agents: the weekly health check and report, and what they lead to.
 *
 * Held to src/agents.ts: the health check flags a system slowly making less
 * for its sunlight, by the figures alone, and that becomes an alert told once;
 * the weekly report is written by the model when there is one and held to the
 * figures, and by SolarLens itself otherwise, and says what the week's analysis
 * found needs a look and what to do; both run once a week, and the report goes
 * out with the weekly summary. Workers AI is a script of replies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_TRIES, latestReports, runWeeklyAgents } from '../../src/agents';
import { addChannel, parseChannel, type NewChannel } from '../../src/channels';
import { announce, pushEvents } from '../../src/push';
import { sendWeekly } from '../../src/summary';
import { createShare, setRequired } from '../../src/auth/sessions';
import { HOURLY, bearer, createHarness, type Harness } from '../helpers/worker';
import { addDay, addFault, addSun, addSystem, dayNumber, isoOf } from '../helpers/solar-days';

/** Monday 28 September 2026, 09:00 UTC: the week before is 21 to 27 September. */
const NOW = Date.UTC(2026, 8, 28, 9) / 1000;
const WEEK = 7 * 86400;
const ROOF = 'solarman:station:alpha';
const GARAGE = 'solarman:station:beta';
const HOOK = 'https://hooks.example.net/api/webhook/made-up-hook-id';

afterEach(() => { vi.unstubAllGlobals(); });

/**
 * Twelve weeks before Monday 28 September: Roof makes 20 kWh a day in 5 kWh/m²
 * of sun for eight weeks, then 16 for the last four - slowly making less.
 * Garage makes 16 throughout.
 */
async function quarter(db: D1Database) {
  await addSystem(db, { id: ROOF, name: 'Roof', kwp: 5 });
  await addSystem(db, { id: GARAGE, name: 'Garage', kwp: 4 });
  const monday = dayNumber('2026-09-28');
  for (let n = monday - 84; n < monday; n++) {
    await addDay(db, ROOF, isoOf(n), n >= monday - 28 ? 16 : 20);
    await addDay(db, GARAGE, isoOf(n), 16);
    await addSun(db, ROOF, isoOf(n), 5);
    await addSun(db, GARAGE, isoOf(n), 5);
  }
}

/** A Workers AI that answers from a script, and remembers what it was sent. */
function scriptedAi(replies: unknown[]) {
  const sent: string[] = [];
  return {
    sent,
    AI: { async run(_m: string, inputs: Record<string, unknown>) { sent.push(JSON.stringify(inputs)); const r = replies.shift(); if (r instanceof Error) throw r; return r; } },
  };
}

describe('the weekly agents', () => {
  let h: Harness;
  afterEach(() => h.close());

  it("check each system's health, flag the one slowly making less, and write the week up from the figures", async () => {
    h = createHarness();
    await quarter(h.env.DB);
    expect(await runWeeklyAgents(h.env, NOW)).toBe(true);
    const { weekly, health } = await latestReports(h.env.DB, NOW);
    expect(health).toEqual([
      expect.objectContaining({ system: 's1', name: 'Roof', flagged: true, week_of: '2026-09-28', worded: 'solarlens', body: expect.stringContaining('Roof: for its sunlight it is making 20% less') }),
      expect.objectContaining({ system: 's2', name: 'Garage', flagged: false, body: expect.stringContaining('Garage: steady') }),
    ]);
    expect(health[0].data).toMatchObject({ verdict: 'declining', change_pct: -20 });
    expect(weekly).toMatchObject({ title: 'Week of 21 Sep 2026', worded: 'solarlens', week_of: '2026-09-28' });
    expect(weekly!.body.startsWith('21 Sep to 27 Sep: 224 kWh')).toBe(true);
    expect(weekly!.body).toContain('The lowest day was Mon 21 Sep 2026: Roof made 16 kWh');
    expect(weekly!.body).toContain('Roof: for its sunlight it is making 20% less');
    expect(JSON.stringify({ weekly, health: health.map(({ data, ...rest }) => rest) })).not.toMatch(/station|alpha|beta/);
  });

  it('say what needs a look, and what to do about it, from the week analysed', async () => {
    h = createHarness();
    await quarter(h.env.DB);
    // Both reporting this morning, and a fault on Garage since Thursday, still active.
    for (const id of [ROOF, GARAGE]) {
      await h.env.DB.prepare("INSERT INTO readings (inverter_id, ts, source, ac_power_w, today_kwh, metrics, tz_offset_sec) VALUES (?1, ?2, 'test', 800, 0.4, '{}', 0)").bind(id, NOW - 120).run();
    }
    await addFault(h.env.DB, GARAGE, 'f-garage', NOW - 4 * 86400, null, 'Grid overvoltage');
    await runWeeklyAgents(h.env, NOW);
    const { weekly } = await latestReports(h.env.DB, NOW);
    expect(weekly!.body).toContain("Needs a look: 1 fault is still active: Grid overvoltage on Garage. What to do: See what each one means, and the vendor's advice, on the Alerts tab.");
    // Roof slowly making less is the health check's to say, once.
    expect(weekly!.body.match(/making 20% less/g)).toHaveLength(1);
    const kept = await h.env.DB.prepare("SELECT data FROM agent_reports WHERE kind = 'weekly'").first<{ data: string }>();
    expect(JSON.parse(kept!.data).analysis).toContainEqual(expect.objectContaining({ stands: 'Needs a look', area: 'Faults' }));
  });

  it('run once a week, and again the next Monday', async () => {
    h = createHarness();
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5 });
    expect(await runWeeklyAgents(h.env, NOW)).toBe(true);
    expect(await runWeeklyAgents(h.env, NOW + 3 * 86400)).toBe(false);
    expect(await runWeeklyAgents(h.env, NOW + WEEK - 2 * 3600)).toBe(false);   // next Monday, before 08:00
    expect(await runWeeklyAgents(h.env, NOW + WEEK)).toBe(true);
    expect(await h.env.DB.prepare("SELECT COUNT(*) AS n FROM agent_reports WHERE kind = 'weekly'").first()).toEqual({ n: 2 });
  });

  it('do nothing with no systems', async () => {
    h = createHarness();
    expect(await runWeeklyAgents(h.env, NOW)).toBe(false);
  });

  it('let the model write the report, held to the figures it was given', async () => {
    const ai = scriptedAi([{ response: 'A steady week: 224 kWh, about the same as the week before. Roof is making 20% less for its sunlight than it was, so it is worth a look for dirt or shade.' }]);
    h = createHarness({ AI: ai.AI });
    await quarter(h.env.DB);
    await runWeeklyAgents(h.env, NOW);
    const { weekly } = await latestReports(h.env.DB, NOW);
    expect(weekly).toMatchObject({ worded: 'model', body: expect.stringContaining('Roof is making 20% less') });
    expect(ai.sent[0]).toContain('Do not add, subtract, average');
    expect(ai.sent[0]).not.toMatch(/station|alpha|beta/);
  });

  it("set aside a report with a number of the model's own", async () => {
    h = createHarness({ AI: scriptedAi([{ response: 'You made 999 kWh.' }]).AI });
    await quarter(h.env.DB);
    await runWeeklyAgents(h.env, NOW);
    expect((await latestReports(h.env.DB, NOW)).weekly).toMatchObject({ worded: 'solarlens' });
  });

  it('turn a system slowly making less into an alert, told once', async () => {
    h = createHarness();
    await quarter(h.env.DB);
    await runWeeklyAgents(h.env, NOW);
    const events = await pushEvents(h.env.DB, NOW);
    expect(events).toContainEqual({ key: `decline:${ROOF}`, title: 'Roof: slowly making less', body: expect.stringContaining('20% less') });
    expect(events.some((e) => e.key === `decline:${GARAGE}`)).toBe(false);
    // Told once, to a channel listening for alerts.
    const row = await addChannel(h.env.DB, 'api-token-for-tests', parseChannel({ kind: 'webhook', url: HOOK }) as NewChannel, 'https://dashboard.test', NOW);
    if (row === 'full') throw new Error('full');
    const posts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => { posts.push(String(init?.body)); return new Response('', { status: 200 }); }));
    expect(await announce(h.env, NOW)).toBeGreaterThan(0);
    expect(posts.join()).toContain('Roof: slowly making less');
    expect(await announce(h.env, NOW + 300)).toBe(0);
    // A check older than eight days no longer stands.
    expect((await pushEvents(h.env.DB, NOW + 9 * 86400)).some((e) => e.key.startsWith('decline:'))).toBe(false);
  });

  it('send the report out with the weekly summary', async () => {
    h = createHarness();
    await quarter(h.env.DB);
    const row = await addChannel(h.env.DB, 'api-token-for-tests', parseChannel({ kind: 'webhook', url: HOOK, alerts: false }) as NewChannel, 'https://dashboard.test', NOW);
    if (row === 'full') throw new Error('full');
    // The week before was the last one sent, so this Monday's is due.
    await h.env.DB.prepare("INSERT INTO kv (k, v, expires_at) VALUES ('summary:week', ?1, ?2)").bind(String(dayNumber('2026-09-21')), NOW + WEEK * 52).run();
    const posts: { message: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => { posts.push(JSON.parse(String(init?.body))); return new Response('', { status: 200 }); }));
    await runWeeklyAgents(h.env, NOW);
    expect(await sendWeekly(h.env, NOW)).toBe(true);
    const report = (await latestReports(h.env.DB, NOW)).weekly!;
    expect(posts[0].message).toContain(`\n\nIn short: ${report.body.slice(0, 60)}`);
  });

  it('run from the cron', async () => {
    h = createHarness();
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5 });
    // The five-minute cron keeps to the readings and the alerts; the week is the hourly one's.
    await h.cron();
    expect(await h.env.DB.prepare("SELECT COUNT(*) AS n FROM agent_reports WHERE kind = 'weekly'").first()).toEqual({ n: 0 });
    await h.cron(HOURLY);
    expect(await h.env.DB.prepare("SELECT COUNT(*) AS n FROM agent_reports WHERE kind = 'weekly'").first()).toEqual({ n: 1 });
  });
});

describe('/api/agents', () => {
  let h: Harness;
  beforeEach(() => { h = createHarness(); });
  afterEach(() => h.close());

  it('serves the newest report and health checks, as a read that follows the switch', async () => {
    const now = Math.floor(Date.now() / 1000);
    await addSystem(h.env.DB, { id: ROOF, name: 'Roof', kwp: 5 });
    expect(await (await h.fetch('/api/agents')).json()).toEqual({ weekly: null, health: [] });
    await runWeeklyAgents(h.env, now);
    const body = (await (await h.fetch('/api/agents')).json()) as { weekly: { title: string } | null; health: { system: string }[] };
    expect(body.weekly?.title).toMatch(/^Week of /);
    expect(body.health).toEqual([expect.objectContaining({ system: 's1', name: 'Roof', flagged: false })]);
    await setRequired(h.env.DB, true, now);
    expect((await h.fetch('/api/agents')).status).toBe(401);
    const share = await createShare(h.env.DB, 'Family', null, now);
    expect((await h.fetch('/api/agents', { headers: bearer(share.token) })).status).toBe(200);
  });
});

describe('the week, when a run of the agents fails', () => {
  let h: Harness;
  afterEach(() => h.close());
  const weekly = () => h.env.DB.prepare("SELECT COUNT(*) AS n FROM agent_reports WHERE kind = 'weekly'").first();
  // agent_reports taken away, and put back as it was: a database refusing, then answering again.
  const breakReports = () => h.d1.raw.exec('ALTER TABLE agent_reports RENAME TO agent_reports_away');
  const mendReports = () => h.d1.raw.exec('ALTER TABLE agent_reports_away RENAME TO agent_reports');

  it('is not marked done, so the next hour tries again - and then it is', async () => {
    h = createHarness();
    await quarter(h.env.DB);
    breakReports();
    await expect(runWeeklyAgents(h.env, NOW)).rejects.toThrow();
    mendReports();
    expect(await weekly()).toEqual({ n: 0 });
    expect(await runWeeklyAgents(h.env, NOW + 3600)).toBe(true);
    expect(await weekly()).toEqual({ n: 1 });
    // Done now: the rest of the week, nothing more.
    expect(await runWeeklyAgents(h.env, NOW + 7200)).toBe(false);
  });

  it(`gives up after ${MAX_TRIES} tries, so a fault that fails every time cannot spend the day's model calls`, async () => {
    h = createHarness();
    await quarter(h.env.DB);
    breakReports();
    for (let i = 0; i < MAX_TRIES; i++) await expect(runWeeklyAgents(h.env, NOW + i * 3600)).rejects.toThrow();
    mendReports();
    expect(await runWeeklyAgents(h.env, NOW + MAX_TRIES * 3600)).toBe(false);
    expect(await weekly()).toEqual({ n: 0 });
    // The next week starts afresh.
    expect(await runWeeklyAgents(h.env, NOW + WEEK)).toBe(true);
  });

  it('leaves the rest of the hourly work to the next hour, in the hour it runs', async () => {
    h = createHarness();
    await quarter(h.env.DB);
    const asked: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => { asked.push(String(input)); return Response.json({ hourly: { time: [], shortwave_radiation: [], temperature_2m: [], cloud_cover: [] } }); }));
    await h.env.DB.prepare("INSERT INTO plant_location (inverter_id, lat, lng, updated_at) VALUES (?1, 10, 20, 0)").bind(ROOF).run();
    const { hourly } = await import('../../src/cron');
    await hourly(h.env, NOW);
    expect(await weekly()).toEqual({ n: 1 });
    expect(asked.some((u) => u.includes('open-meteo'))).toBe(false);
    await hourly(h.env, NOW + 3600);
    expect(asked.some((u) => u.includes('open-meteo'))).toBe(true);
  });

  it('is logged, and the rest of the hour runs regardless - as does every step after one that fails', async () => {
    h = createHarness();
    await quarter(h.env.DB);
    // A row past its expiry, for the housekeeping to clear (../../src/db forgetExpiredKv).
    await h.env.DB.prepare("INSERT INTO kv (k, v, expires_at) VALUES ('weather:gone', '1', ?1)").bind(NOW - 60).run();
    breakReports();
    // The weather's own table taken away too, so the step before the housekeeping fails.
    h.d1.raw.exec('ALTER TABLE plant_location RENAME TO plant_location_away');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { hourly } = await import('../../src/cron');
    await hourly(h.env, NOW);
    // The summary has no channel to go to, so of the three steps only the weather fails.
    expect(errors.mock.calls.map(([step]) => step)).toEqual(['agents:', 'weather:']);
    expect(await h.env.DB.prepare("SELECT COUNT(*) AS n FROM kv WHERE k = 'weather:gone'").first()).toEqual({ n: 0 });
    errors.mockRestore();
  });
});
