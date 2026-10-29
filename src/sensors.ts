/**
 * Every figure a Home Assistant sensor wants, in one flat answer that keeps its
 * shape: GET /api/sensors.
 *
 * Home Assistant's REST integration reads one address on a timer and lifts
 * each sensor out of the JSON with a template - `value_json.power_w`,
 * `value_json.systems.s1.today_kwh` - so what matters here is that the names
 * never move and every figure is a plain number in a known unit: watts, kWh,
 * percent, seconds. docs/home-assistant.md has the configuration to paste.
 *
 * It follows the same rules as the page: a system is offline when its vendor
 * says so or nothing has arrived for 25 minutes, and an offline system's live
 * figures are zero rather than whatever it managed just before it dropped. The
 * cumulative ones - today, lifetime - stay, since that energy was made. Systems
 * are named by their alias, as in every public answer, and the read follows the
 * dashboard's own switch: open to all, or - when sign-in is required - to the
 * owner and to a share link, which Home Assistant can send as a bearer token.
 */
import { latest, nowSec } from './db';
import { aliasFor } from './public-view';
import { getTariff, valueOf } from './settings';

/** How long without a reading before a system counts as offline: the page's own figure. */
export const STALE_AFTER_S = 25 * 60;

const parse = (s: string | null): Record<string, unknown> | null => {
  try { return s ? (JSON.parse(s) as Record<string, unknown>) : null; } catch { return null; }
};
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;

export async function sensors(db: D1Database, now = nowSec()) {
  const [rows, tariff, faultRows] = await Promise.all([
    latest(db),
    getTariff(db),
    db.prepare(`SELECT inverter_id, COUNT(*) AS n FROM alarms WHERE state = 'active' AND end_ts IS NULL GROUP BY inverter_id`)
      .all<{ inverter_id: string; n: number }>(),
  ]);
  // Named as /api/latest names them, from the same rows.
  const alias = aliasFor(rows.map((r) => r.id));
  const faults = new Map(faultRows.results.map((f) => [f.inverter_id, f.n]));

  const systems: Record<string, Record<string, unknown>> = {};
  let power = 0, today = 0, total = 0, online = 0, saved = 0, co2 = 0, anyValue = false, newest = 0;
  for (const r of rows) {
    const live = !!r.ts && now - r.ts <= STALE_AFTER_S && r.status !== 'offline';
    const m = parse(r.metrics);
    const value = valueOf(r.today_kwh, num(m?.gridExportTodayKwh), tariff);
    const zeroIfDown = (v: number | null) => (v === null ? null : live ? v : 0);
    const id = alias(r.id) ?? 'unknown';
    systems[id] = {
      name: r.name,
      provider: r.provider,
      capacity_w: r.capacity_w,
      online: live,
      status: !r.ts ? 'no data' : r.status === 'alarm' ? 'alarm' : live ? 'online' : 'offline',
      updated: r.ts,
      power_w: live ? (r.ac_power_w ?? 0) : 0,
      today_kwh: r.today_kwh,
      total_kwh: r.total_kwh,
      battery_soc: r.battery_soc,
      battery_power_w: zeroIfDown(r.battery_power_w),
      grid_power_w: zeroIfDown(r.grid_power_w),
      load_power_w: zeroIfDown(r.load_power_w),
      load_today_kwh: num(m?.loadTodayKwh),
      grid_import_today_kwh: num(m?.gridImportTodayKwh),
      grid_export_today_kwh: num(m?.gridExportTodayKwh),
      faults_active: faults.get(r.id) ?? 0,
      saved_today: value ? round(value.money, 2) : null,
      co2_today_kg: value ? round(value.co2, 1) : null,
    };
    if (live) { power += r.ac_power_w ?? 0; online++; }
    today += r.today_kwh ?? 0;
    total += r.total_kwh ?? 0;
    if (value) { saved += value.money; co2 += value.co2; anyValue = true; }
    newest = Math.max(newest, r.ts ?? 0);
  }
  return {
    now,
    updated: newest || null,
    power_w: power,
    today_kwh: round(today, 2),
    total_kwh: round(total, 1),
    systems_count: rows.length,
    online,
    faults_active: [...faults.values()].reduce((a, n) => a + n, 0),
    currency: tariff?.currency ?? null,
    saved_today: anyValue ? round(saved, 2) : null,
    co2_today_kg: anyValue ? round(co2, 1) : null,
    systems,
  };
}
