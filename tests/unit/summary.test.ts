/**
 * The weekly summary, and what Home Assistant reads.
 *
 * The summary is held to its figures - each system's week against the one
 * before, its best day, the days it reported, the money and CO2 by the
 * owner's tariff, the faults - to its words, and to its schedule: Monday
 * 08:00 on the first system's clock, once a week, never twice, and not the
 * moment a channel is added. /api/sensors is held to the page's own rules for
 * an offline system, to names that never carry an internal id, and to the
 * dashboard's switch - with a share link, sent as a bearer token, as the way
 * Home Assistant reads a private dashboard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addChannel, parseChannel, type NewChannel } from '../../src/channels';
import { createShare, revokeShare, setRequired } from '../../src/auth/sessions';
import { insertReading, upsertInverter } from '../../src/db';
import { setTariff } from '../../src/settings';
import { STALE_AFTER_S } from '../../src/sensors';
import { REPORT_WAIT_S, buildSummary, currentSlot, sendWeekly, summaryMessage, summaryWindow, weekSlot } from '../../src/summary';
import { HOURLY, bearer, createHarness, testInverter, testReading, type Harness } from '../helpers/worker';

/** The week's report (../../src/agents), written as the agents write it: the summary carries it, and waits for it. */
const report = async (h: Harness, ts: number) => h.env.DB
  .prepare("INSERT OR REPLACE INTO agent_reports (id, kind, week, inverter_id, title, body, data, worded, flagged, created_at) VALUES (?1, 'weekly', ?2, NULL, 'Week', 'A steady week.', NULL, 'solarlens', 0, ?3)")
  .bind(`weekly:${await currentSlot(h.env.DB, ts)}`, await currentSlot(h.env.DB, ts), ts)
  .run();

const API = 'api-token-for-tests';
const DAY = 86400;
/** Monday 28 September 2026, 09:00 UTC: the week before is Monday 21 to Sunday 27. */
const MONDAY_9 = Date.UTC(2026, 8, 28, 9) / 1000;
const HOOK = 'https://hooks.example.net/api/webhook/made-up-hook-id';

afterEach(() => { vi.unstubAllGlobals(); });

/** Every POST the Worker makes, recorded. */
function stubServices() {
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body ?? 'null')) });
    return new Response('{}', { status: 200 });
  }));
  return sent;
}

describe('the window and the schedule', () => {
  it('is the seven full days before today, and the seven before them', () => {
    const w = summaryWindow(MONDAY_9, 0);
    expect(w.days).toEqual(['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27']);
    expect(w.before[0]).toBe('2026-09-14');
    expect(w.before[6]).toBe('2026-09-20');
    expect(w.startTs).toBe(Date.UTC(2026, 8, 21) / 1000);
    expect(w.endTs).toBe(Date.UTC(2026, 8, 28) / 1000);
    // Five hours east, it is already the 28th at 21:00 UTC on the 27th.
    expect(summaryWindow(Date.UTC(2026, 8, 27, 21) / 1000, 5 * 3600).days[6]).toBe('2026-09-27');
  });

  it('belongs to the Monday whose 08:00 has most recently passed, on the plants\' clock', () => {
    const monday = Date.UTC(2026, 8, 28) / 1000 / DAY;
    expect(weekSlot(MONDAY_9, 0)).toBe(monday);
    expect(weekSlot(Date.UTC(2026, 8, 28, 8) / 1000, 0)).toBe(monday);
    expect(weekSlot(Date.UTC(2026, 8, 28, 7, 59) / 1000, 0)).toBe(monday - 7);
    expect(weekSlot(Date.UTC(2026, 9, 4, 23) / 1000, 0)).toBe(monday);          // the Sunday after
    // 08:00 in a zone five hours east is 03:00 UTC.
    expect(weekSlot(Date.UTC(2026, 8, 28, 3) / 1000, 5 * 3600)).toBe(monday);
    expect(weekSlot(Date.UTC(2026, 8, 28, 2) / 1000, 5 * 3600)).toBe(monday - 7);
  });
});

/**
 * Two systems on UTC. Roof makes 10 to 16 kWh across last week, 2 kWh of each
 * day exported, and 7 kWh a day the week before; Garage reported on five days
 * of last week, 20 kWh each, with no export figure, and nothing before.
 */
async function seed(h: Harness) {
  const roof = 'solarman:station:alpha';
  const garage = 'soliscloud:station:beta';
  await upsertInverter(h.env.DB, testInverter({ id: roof, vendorId: 'alpha', plantId: 'alpha', name: 'Roof' }) as never);
  await upsertInverter(h.env.DB, testInverter({ id: garage, provider: 'soliscloud', vendorId: 'beta', plantId: 'beta', name: 'Garage' }) as never);
  const noon = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)), 12) / 1000;
  const w = summaryWindow(MONDAY_9, 0);
  for (const [i, d] of w.days.entries()) {
    await insertReading(h.env.DB, testReading({ inverterId: roof, ts: noon(d), todayKwh: 10 + i, metrics: { gridExportTodayKwh: 2 } }) as never);
    if (i < 5) await insertReading(h.env.DB, testReading({ inverterId: garage, ts: noon(d), todayKwh: 20 }) as never);
  }
  for (const d of w.before) await insertReading(h.env.DB, testReading({ inverterId: roof, ts: noon(d), todayKwh: 7 }) as never);
  // Two faults last week, one still active; one the week before, which does not count.
  await h.env.DB.prepare(
    `INSERT INTO alarms (id, inverter_id, provider, code, message, severity, begin_ts, end_ts, state, first_seen, last_seen) VALUES
       ('a1', ?1, 'solarman', '7', 'DC voltage low', 'fault', ?2, ?3, 'recovered', ?2, ?3),
       ('a2', ?1, 'solarman', '9', 'Grid lost', 'warning', ?4, NULL, 'active', ?4, ?4),
       ('a3', ?5, 'soliscloud', '1015', 'Old', 'warning', ?6, ?6, 'recovered', ?6, ?6)`,
  ).bind(roof, noon('2026-09-23'), noon('2026-09-23') + 600, noon('2026-09-26'), garage, noon('2026-09-10')).run();
}

describe('the summary', () => {
  let h: Harness;
  beforeEach(() => { h = createHarness(); });
  afterEach(() => h.close());

  it("adds each system's week up, against the week before, with its best day and the faults", async () => {
    await seed(h);
    const s = await buildSummary(h.env.DB, MONDAY_9);
    expect(s).toMatchObject({
      from: '2026-09-21', to: '2026-09-27', days: 7,
      total_kwh: 191, prev_total_kwh: 49,
      // Only Roof has a week before; Garage, new this week, is not counted as more.
      change_pct: 86,
      saved: null, currency: null, co2_kg: null, faults: 2, faults_active: 1,
    });
    expect(s.systems).toEqual([
      { id: 's2', name: 'Garage', kwh: 100, prev_kwh: null, days: 5, best_day: '2026-09-21', best_kwh: 20, faults: 0 },
      { id: 's1', name: 'Roof', kwh: 91, prev_kwh: 49, days: 7, best_day: '2026-09-27', best_kwh: 16, faults: 2 },
    ]);
    expect(JSON.stringify(s)).not.toContain('station');
  });

  it("values the week by the owner's tariff, and says when part of it is an upper bound", async () => {
    await seed(h);
    await setTariff(h.env.DB, { currency: 'EUR', importPrice: 0.3, exportPrice: 0.1, netMetering: false, co2KgPerKwh: 0.4 });
    const s = await buildSummary(h.env.DB, MONDAY_9);
    // Roof: 0.3 x 91 - 0.2 x 14 = 24.5. Garage: 0.3 x 100 = 30, its export unknown.
    expect(s).toMatchObject({ saved: 54.5, currency: 'EUR', saved_assumed: true, co2_kg: 76.4 });
  });

  it('says it in a few short lines', async () => {
    await seed(h);
    await setTariff(h.env.DB, { currency: 'EUR', importPrice: 0.3, exportPrice: 0.1, netMetering: false, co2KgPerKwh: 0.4 });
    const m = summaryMessage(await buildSummary(h.env.DB, MONDAY_9));
    expect(m).toMatchObject({ kind: 'summary', title: 'Last week: 191 kWh made', path: '#/history', ts: MONDAY_9 });
    expect(m.body.split('\n')).toEqual([
      '21 Sep to 27 Sep: 191 kWh, 86% more than the week before.',
      'Garage: 100 kWh, reported on 5 of 7 days; best Mon 21 Sep with 20.0 kWh.',
      'Roof: 91.0 kWh (+86%); best Sun 27 Sep with 16.0 kWh.',
      'Saved up to €54.50 and avoided 76 kg of CO₂.',
      '2 faults recorded, 1 still active.',
    ]);
  });

  it('says so when nothing was recorded, and speaks of one system without naming it twice', async () => {
    expect(summaryMessage(await buildSummary(h.env.DB, MONDAY_9)).body).toBe('21 Sep to 27 Sep: 0.0 kWh.\nNo readings were recorded.\nNo faults recorded.');
    await upsertInverter(h.env.DB, testInverter() as never);
    const w = summaryWindow(MONDAY_9, 0);
    for (const [i, d] of w.days.entries()) await insertReading(h.env.DB, testReading({ ts: Date.parse(`${d}T12:00:00Z`) / 1000, todayKwh: i === 3 ? 30 : 20 }) as never);
    for (const d of w.before) await insertReading(h.env.DB, testReading({ ts: Date.parse(`${d}T12:00:00Z`) / 1000, todayKwh: 21.5 }) as never);
    const m = summaryMessage(await buildSummary(h.env.DB, MONDAY_9));
    expect(m.title).toBe('Last week: 150 kWh made');
    expect(m.body).toBe('21 Sep to 27 Sep: 150 kWh, about the same as the week before.\nBest day: Thu 24 Sep with 30.0 kWh.\nNo faults recorded.');
  });

  it('is served at /api/summary, for 1 to 31 days, with the words alongside', async () => {
    const res = await h.fetch('/api/summary');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { days: number; message: { title: string } };
    expect(body.days).toBe(7);
    expect(body.message.title).toBe('Last week: 0.0 kWh made');
    const days = async (q: string) => ((await (await h.fetch(`/api/summary?days=${q}`)).json()) as { days: number }).days;
    expect(await days('0')).toBe(1);
    expect(await days('99')).toBe(31);
    expect(await days('x')).toBe(7);
    expect(((await (await h.fetch('/api/summary?days=3')).json()) as { message: { title: string } }).message.title).toBe('The last 3 days: 0.0 kWh made');
  });
});

describe('sending the weekly summary', () => {
  let h: Harness;
  beforeEach(() => { h = createHarness(); });
  afterEach(() => h.close());
  const hook = async (over: Record<string, unknown> = {}) => {
    const row = await addChannel(h.env.DB, API, parseChannel({ kind: 'webhook', url: HOOK, ...over }) as NewChannel, 'https://dashboard.test', MONDAY_9);
    if (row === 'full') throw new Error('full');
    return row;
  };

  it('does nothing while no channel takes it', async () => {
    await hook({ weekly: false });
    const sent = stubServices();
    expect(await sendWeekly(h.env, MONDAY_9)).toBe(false);
    expect(sent).toEqual([]);
    expect(await h.env.DB.prepare("SELECT v FROM kv WHERE k = 'summary:week'").first()).toBeNull();
  });

  it('marks the week the first time rather than sending at once, then sends each Monday from 08:00, once', async () => {
    await seed(h);
    await hook();
    await hook({ alerts: true, weekly: false, url: `${HOOK}-alerts-only` });
    const sent = stubServices();
    expect(await sendWeekly(h.env, MONDAY_9)).toBe(false);
    expect(sent).toEqual([]);
    // The rest of that week: already marked.
    expect(await sendWeekly(h.env, MONDAY_9 + 3 * DAY)).toBe(false);
    // The next Monday, before 08:00: not yet.
    expect(await sendWeekly(h.env, MONDAY_9 + 7 * DAY - 2 * 3600)).toBe(false);
    // From 08:00 - once the week's report is written, which the summary carries.
    expect(await sendWeekly(h.env, MONDAY_9 + 7 * DAY - 3600)).toBe(false);
    await report(h, MONDAY_9 + 7 * DAY - 3600);
    // Then once, to the channel that takes it and not the alerts-only one.
    expect(await sendWeekly(h.env, MONDAY_9 + 7 * DAY - 3600)).toBe(true);
    expect(sent.map((s) => s.url)).toEqual([HOOK]);
    expect(sent[0].body).toMatchObject({ kind: 'summary', url: 'https://dashboard.test/#/history' });
    expect(await sendWeekly(h.env, MONDAY_9 + 7 * DAY)).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it('catches up at the next run when the Worker missed Monday morning', async () => {
    await hook();
    const sent = stubServices();
    await sendWeekly(h.env, MONDAY_9);
    expect(await sendWeekly(h.env, MONDAY_9 + 9 * DAY)).toBe(true);          // Wednesday of the week after
    expect(sent).toHaveLength(1);
  });

  it('goes without the report once it has waited for it long enough', async () => {
    await hook();
    const sent = stubServices();
    await sendWeekly(h.env, MONDAY_9);
    const eight = MONDAY_9 + 7 * DAY - 3600;
    expect(await sendWeekly(h.env, eight + REPORT_WAIT_S - 60)).toBe(false);
    expect(await sendWeekly(h.env, eight + REPORT_WAIT_S)).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('runs from the hourly cron, not the five-minute one', async () => {
    await hook();
    // A week long past is the last one sent, and this week's report is written, so the hourly run is due to send.
    await h.env.DB.prepare("INSERT INTO kv (k, v, expires_at) VALUES ('summary:week', '1', ?1)").bind(MONDAY_9 + 365 * DAY).run();
    await report(h, Math.floor(Date.now() / 1000));
    const sent = stubServices();
    await h.cron();
    expect(sent.filter((s) => s.body?.kind === 'summary')).toHaveLength(0);
    await h.cron(HOURLY);
    expect(sent.filter((s) => s.body?.kind === 'summary')).toHaveLength(1);
  });

  it('goes out at once when the owner asks, to the channels that take it', async () => {
    const sent = stubServices();
    expect((await h.fetch('/api/settings/summary', { method: 'POST', headers: bearer(API) })).status).toBe(409);
    await hook();
    const res = await h.fetch('/api/settings/summary', { method: 'POST', headers: bearer(API) });
    expect(await res.json()).toMatchObject({ sent: 1, of: 1, title: 'Last week: 0.0 kWh made' });
    expect(sent).toHaveLength(1);
    const open = createHarness({ API_TOKEN: undefined });
    expect((await open.fetch('/api/settings/summary', { method: 'POST' })).status).toBe(503);
    open.close();
  });
});

// ------------------------------------------------------------------ Home Assistant

describe('/api/sensors', () => {
  let h: Harness;
  beforeEach(() => { h = createHarness(); });
  afterEach(() => h.close());

  /** Roof reporting a minute ago; Garage, whose last word was an hour ago, offline. */
  async function twoSystems() {
    const now = Math.floor(Date.now() / 1000);
    await upsertInverter(h.env.DB, testInverter({ id: 'solarman:station:alpha', vendorId: 'alpha', plantId: 'alpha', name: 'Roof' }) as never);
    await upsertInverter(h.env.DB, testInverter({ id: 'solarman:station:beta', vendorId: 'beta', plantId: 'beta', name: 'Garage' }) as never);
    await insertReading(h.env.DB, testReading({ inverterId: 'solarman:station:alpha', ts: now - 60, acPowerW: 2500, todayKwh: 9.5, totalKwh: 1200,
      gridPowerW: -1600, loadPowerW: 900, batteryPowerW: 300, metrics: { gridExportTodayKwh: 4, loadTodayKwh: 6.2, gridImportTodayKwh: 1.1 } }) as never);
    await insertReading(h.env.DB, testReading({ inverterId: 'solarman:station:beta', ts: now - STALE_AFTER_S - 600, acPowerW: 800, todayKwh: 3, totalKwh: 400,
      batteryPowerW: -150 }) as never);
    await h.env.DB.prepare(`INSERT INTO alarms (id, inverter_id, provider, code, begin_ts, end_ts, state, first_seen, last_seen)
      VALUES ('x1', 'solarman:station:beta', 'solarman', '9', ?1, NULL, 'active', ?1, ?1)`).bind(now - 3600).run();
    return now;
  }

  it('answers flat, in fixed units, with an offline system counted as making nothing', async () => {
    const now = await twoSystems();
    const res = await h.fetch('/api/sensors');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const s = (await res.json()) as Record<string, unknown> & { systems: Record<string, Record<string, unknown>> };
    expect(s).toMatchObject({ power_w: 2500, today_kwh: 12.5, total_kwh: 1600, systems_count: 2, online: 1, faults_active: 1, updated: now - 60, currency: null, saved_today: null });
    expect(s.systems.s1).toMatchObject({
      name: 'Roof', online: true, status: 'online', power_w: 2500, today_kwh: 9.5, grid_power_w: -1600, load_power_w: 900, battery_power_w: 300,
      load_today_kwh: 6.2, grid_import_today_kwh: 1.1, grid_export_today_kwh: 4, faults_active: 0,
    });
    // Offline: live figures zero, the day's energy kept.
    expect(s.systems.s2).toMatchObject({ name: 'Garage', online: false, status: 'offline', power_w: 0, battery_power_w: 0, today_kwh: 3, faults_active: 1 });
    expect(JSON.stringify(s)).not.toMatch(/station|alpha|beta|SERIAL/);
  });

  it("adds today's saving by the tariff, when there is one", async () => {
    await twoSystems();
    await setTariff(h.env.DB, { currency: 'EUR', importPrice: 0.3, exportPrice: 0.1, netMetering: false, co2KgPerKwh: 0.4 });
    const s = (await (await h.fetch('/api/sensors')).json()) as Record<string, unknown> & { systems: Record<string, Record<string, unknown>> };
    // Roof: 5.5 x 0.3 + 4 x 0.1 = 2.05. Garage: 3 x 0.3 = 0.9.
    expect(s.systems.s1).toMatchObject({ saved_today: 2.05, co2_today_kg: 3.8 });
    expect(s).toMatchObject({ currency: 'EUR', saved_today: 2.95, co2_today_kg: 5 });
  });

  it('follows the switch: with sign-in required, a share link sent as a bearer token reads, and nothing else does', async () => {
    await twoSystems();
    const now = Math.floor(Date.now() / 1000);
    await setRequired(h.env.DB, true, now);
    expect((await h.fetch('/api/sensors')).status).toBe(401);
    expect((await h.fetch('/api/sensors', { headers: bearer('not-a-token.at-all-no-no-no-no-no') })).status).toBe(401);
    const share = await createShare(h.env.DB, 'Home Assistant', null, now);
    expect((await h.fetch('/api/sensors', { headers: bearer(share.token) })).status).toBe(200);
    expect((await h.fetch('/api/latest', { headers: bearer(share.token) })).status).toBe(200);
    // A share reads and never writes.
    expect((await h.fetch('/api/poll', { method: 'POST', headers: bearer(share.token) })).status).toBe(401);
    // Taken back under Settings - Share to view: Home Assistant is refused at once.
    await revokeShare(h.env.DB, share.id, now);
    expect((await h.fetch('/api/sensors', { headers: bearer(share.token) })).status).toBe(401);
    // A link that ran out is refused too.
    const brief = await createShare(h.env.DB, 'brief', 1, now - 2 * DAY);
    expect((await h.fetch('/api/sensors', { headers: bearer(brief.token) })).status).toBe(401);
    // The API token is still the owner.
    expect((await h.fetch('/api/sensors', { headers: bearer(API) })).status).toBe(200);
  });
});
