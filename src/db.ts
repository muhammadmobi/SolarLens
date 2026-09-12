import type { Device, Inverter, Reading } from './providers/types';
import type { TokenStore } from './providers/solarman';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  SOLIS_KEY_ID?: string;
  SOLIS_KEY_SECRET?: string;
  SOLARMAN_APP_ID?: string;
  SOLARMAN_APP_SECRET?: string;
  SOLARMAN_EMAIL?: string;
  SOLARMAN_PASSWORD_SHA256?: string;
  /** Web-session fallback (phase 3): tokens copied from a browser login. */
  SOLARMAN_WEB_REFRESH_TOKEN?: string;
  SOLARMAN_WEB_ACCESS_TOKEN?: string;
  /** Comma-separated vendor plant ids to poll; unset = every plant the accounts can see. */
  INCLUDE_PLANTS?: string;
  API_TOKEN?: string;
  INGEST_TOKEN?: string;
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export async function upsertInverter(db: D1Database, inv: Inverter, seenAt = nowSec()): Promise<void> {
  await db
    .prepare(
      `INSERT INTO inverters (id, provider, vendor_id, serial, name, plant_id, plant_name, capacity_w, tz_offset_sec, first_seen, last_seen)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?10, ?9, ?9)
       ON CONFLICT(id) DO UPDATE SET
         serial     = COALESCE(excluded.serial, inverters.serial),
         name       = COALESCE(excluded.name, inverters.name),
         plant_id   = excluded.plant_id,
         plant_name = CASE WHEN excluded.plant_name = '' THEN inverters.plant_name ELSE excluded.plant_name END,
         capacity_w = COALESCE(excluded.capacity_w, inverters.capacity_w),
         tz_offset_sec = COALESCE(excluded.tz_offset_sec, inverters.tz_offset_sec),
         last_seen  = excluded.last_seen`,
    )
    .bind(inv.id, inv.provider, inv.vendorId, inv.serial, inv.name, inv.plantId, inv.plantName, inv.capacityW, seenAt, inv.tzOffsetSec ?? null)
    .run();
}

/**
 * INSERT OR IGNORE on the (inverter, ts, source) key means re-polling a vendor
 * that has not produced a new sample is a no-op rather than a duplicate row.
 */
export async function insertReading(db: D1Database, r: Reading): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO readings
         (inverter_id, ts, source, ac_power_w, dc_power_w, today_kwh, total_kwh,
          battery_soc, battery_power_w, grid_power_w, load_power_w, temp_c, status, raw, metrics)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
    )
    .bind(
      r.inverterId,
      r.ts,
      r.source,
      r.acPowerW,
      r.dcPowerW,
      r.todayKwh,
      r.totalKwh,
      r.batterySoc,
      r.batteryPowerW,
      r.gridPowerW,
      r.loadPowerW,
      r.tempC,
      r.status,
      JSON.stringify(r.raw ?? null),
      r.metrics ? JSON.stringify(r.metrics) : null,
    )
    .run();
  if ((res.meta.changes ?? 0) > 0) return true;

  // The sample already existed. That is not a no-op: the vendor can revise a
  // payload without moving its timestamp - an inverter going offline keeps the
  // same dataTimestamp and only flips its state field - and the normaliser can
  // have learned to read more of it since. So the whole row is refreshed from
  // the newest payload, not just some of it. Refreshing a subset is worse than
  // refreshing none: it leaves a row whose status disagrees with the raw
  // payload sitting in the column beside it. Still not a new sample.
  await db
    .prepare(
      `UPDATE readings SET
         ac_power_w = ?4, dc_power_w = ?5, today_kwh = ?6, total_kwh = ?7,
         battery_soc = ?8, battery_power_w = ?9, grid_power_w = ?10, load_power_w = ?11,
         temp_c = ?12, status = ?13, raw = ?14, metrics = ?15
       WHERE inverter_id = ?1 AND ts = ?2 AND source = ?3`,
    )
    .bind(
      r.inverterId, r.ts, r.source,
      r.acPowerW, r.dcPowerW, r.todayKwh, r.totalKwh,
      r.batterySoc, r.batteryPowerW, r.gridPowerW, r.loadPowerW,
      r.tempC, r.status,
      JSON.stringify(r.raw ?? null),
      r.metrics ? JSON.stringify(r.metrics) : null,
    )
    .run();
  return false;
}

export interface LatestRow {
  id: string;
  provider: string;
  serial: string | null;
  name: string;
  plant_id: string | null;
  plant_name: string | null;
  capacity_w: number | null;
  display_order: number;
  /**
   * The plant's UTC offset in seconds, so the page can draw the array's day
   * rather than the reader's. Already implied by the plant-local sunrise and
   * sunset the vendors ship in metrics, so publishing it reveals nothing the
   * public response did not already carry.
   */
  tz_offset_sec: number | null;
  ts: number | null;
  source: string | null;
  ac_power_w: number | null;
  dc_power_w: number | null;
  today_kwh: number | null;
  total_kwh: number | null;
  battery_soc: number | null;
  battery_power_w: number | null;
  grid_power_w: number | null;
  load_power_w: number | null;
  temp_c: number | null;
  status: string | null;
  /** JSON-encoded Metrics (see providers/types.ts), or null. */
  metrics: string | null;
}

/** Newest reading per enabled inverter, whichever source produced it. */
export async function latest(db: D1Database): Promise<LatestRow[]> {
  const { results } = await db
    .prepare(
      `SELECT i.id, i.provider, i.serial, i.name, i.plant_id, i.plant_name, i.capacity_w, i.display_order,
              i.tz_offset_sec,
              r.ts, r.source, r.ac_power_w, r.dc_power_w, r.today_kwh, r.total_kwh,
              r.battery_soc, r.battery_power_w, r.grid_power_w, r.load_power_w, r.temp_c, r.status,
              r.metrics, r.raw
       FROM inverters i
       LEFT JOIN readings r
         ON r.rowid = (SELECT rowid FROM readings
                       WHERE inverter_id = i.id AND source NOT LIKE '%-history'
                       ORDER BY ts DESC LIMIT 1)
       WHERE i.enabled = 1
       ORDER BY i.display_order,
                CASE i.provider WHEN 'soliscloud' THEN 0 WHEN 'solarman' THEN 1 ELSE 2 END,
                i.id`,
    )
    .all<LatestRow>();
  return results;
}

export interface DeviceRow {
  id: string;
  provider: string;
  plant_id: string | null;
  kind: string;
  sn: string | null;
  name: string | null;
  model: string | null;
  firmware: string | null;
  rated_power_w: number | null;
  status: string | null;
  signal_dbm: number | null;
  signal_pct: number | null;
  upload_cycle_s: number | null;
  commissioned_at: number | null;
  warranty_until: number | null;
  last_seen: number | null;
  /** JSON [{index, powerW}] or null. */
  strings: string | null;
  ac_phases: string | null;
  frequency_hz: number | null;
  power_factor: number | null;
  temp_c: number | null;
  dc_bus_v: number | null;
  /** JSON BatteryDetail (see providers/types.ts), or null. */
  battery: string | null;
  updated_at: number;
  raw: string | null;
}

/**
 * Devices are re-pushed on every relay pass, so this is a full upsert rather
 * than INSERT OR IGNORE: the point is to keep status, signal and last_seen fresh.
 */
export async function upsertDevice(db: D1Database, d: Device, at = nowSec()): Promise<void> {
  await db
    .prepare(
      `INSERT INTO devices
         (id, provider, plant_id, kind, sn, name, model, firmware, rated_power_w, status,
          signal_dbm, signal_pct, upload_cycle_s, commissioned_at, warranty_until, last_seen, strings, ac_phases, frequency_hz, power_factor, temp_c, dc_bus_v, battery, updated_at, raw)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25)
       ON CONFLICT(id) DO UPDATE SET
         plant_id        = COALESCE(excluded.plant_id, devices.plant_id),
         name            = COALESCE(excluded.name, devices.name),
         model           = COALESCE(excluded.model, devices.model),
         firmware        = COALESCE(excluded.firmware, devices.firmware),
         rated_power_w   = COALESCE(excluded.rated_power_w, devices.rated_power_w),
         status          = COALESCE(excluded.status, devices.status),
         signal_dbm      = COALESCE(excluded.signal_dbm, devices.signal_dbm),
         signal_pct      = COALESCE(excluded.signal_pct, devices.signal_pct),
         upload_cycle_s  = COALESCE(excluded.upload_cycle_s, devices.upload_cycle_s),
         commissioned_at = COALESCE(excluded.commissioned_at, devices.commissioned_at),
         warranty_until  = COALESCE(excluded.warranty_until, devices.warranty_until),
         last_seen       = COALESCE(excluded.last_seen, devices.last_seen),
         strings         = COALESCE(excluded.strings, devices.strings),
         ac_phases       = COALESCE(excluded.ac_phases, devices.ac_phases),
         frequency_hz    = COALESCE(excluded.frequency_hz, devices.frequency_hz),
         power_factor    = COALESCE(excluded.power_factor, devices.power_factor),
         temp_c          = COALESCE(excluded.temp_c, devices.temp_c),
         dc_bus_v        = COALESCE(excluded.dc_bus_v, devices.dc_bus_v),
         battery         = COALESCE(excluded.battery, devices.battery),
         updated_at      = excluded.updated_at,
         raw             = COALESCE(excluded.raw, devices.raw)`,
    )
    .bind(
      d.id, d.provider, d.plantId, d.kind, d.sn, d.name, d.model, d.firmware, d.ratedPowerW,
      d.status, d.signalDbm, d.signalPct, d.uploadCycleS, d.commissionedAt, d.warrantyUntil, d.lastSeen,
      d.strings ? JSON.stringify(d.strings) : null,
      d.acPhases ? JSON.stringify(d.acPhases) : null,
      d.frequencyHz, d.powerFactor, d.tempC, d.dcBusV,
      d.battery ? JSON.stringify(d.battery) : null,
      at,
      d.raw ? JSON.stringify(d.raw) : null,
    )
    .run();
}

export async function listDevices(db: D1Database): Promise<DeviceRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM devices
       ORDER BY CASE provider WHEN 'soliscloud' THEN 0 WHEN 'solarman' THEN 1 ELSE 2 END,
                CASE kind WHEN 'inverter' THEN 0 WHEN 'datalogger' THEN 1 WHEN 'battery' THEN 2 ELSE 3 END,
                sn`,
    )
    .all<DeviceRow>();
  return results;
}

export interface SeriesRow {
  inverter_id: string;
  ts: number;
  ac_power_w: number | null;
  today_kwh: number | null;
  battery_soc: number | null;
  grid_power_w: number | null;
}

/**
 * Readings in a range, one row per inverter per instant.
 *
 * A backfilled point and a live one can describe the same instant; the live one
 * wins, because it carries the whole reading rather than just a wattage. That
 * used to be a correlated NOT EXISTS, which ran once per row and could not use
 * an index - `source NOT LIKE '%-history'` is not something an index can
 * answer. Reading the rows once and folding them here costs a single indexed
 * range scan instead.
 */
export async function series(db: D1Database, fromTs: number, toTs: number): Promise<SeriesRow[]> {
  const { results } = await db
    .prepare(
      `SELECT inverter_id, ts, ac_power_w, today_kwh, battery_soc, grid_power_w, source
       FROM readings
       WHERE ts BETWEEN ?1 AND ?2
       ORDER BY ts ASC`,
    )
    .bind(fromTs, toTs)
    .all<SeriesRow & { source: string | null }>();

  const best = new Map<string, SeriesRow & { source: string | null }>();
  for (const r of results) {
    const key = `${r.inverter_id}|${r.ts}`;
    const seen = best.get(key);
    if (!seen || (isHistory(seen.source) && !isHistory(r.source))) best.set(key, r);
  }
  return [...best.values()]
    .sort((a, b) => a.ts - b.ts)
    .map(({ source: _source, ...row }) => row);
}

const isHistory = (source: string | null) => !!source && source.endsWith('-history');

const POLL_LOG_KEEP_S = 7 * 24 * 3600;

export interface DayRow {
  inverter_id: string;
  day: string;
  yield_kwh: number | null;
  peak_w: number | null;
  load_kwh: number | null;
  import_kwh: number | null;
  export_kwh: number | null;
  batt_charge_kwh: number | null;
  batt_discharge_kwh: number | null;
  samples: number;
  first_ts: number;
  last_ts: number;
}

/** Midnight, in the zone `offsetSec` east of UTC, on or before `atSec`. */
export function dayStartSec(atSec: number, offsetSec: number): number {
  return Math.floor((atSec + offsetSec) / 86400) * 86400 - offsetSec;
}

/**
 * The earliest "today" among the plants, so one fetch covers every system's
 * own day. Two plants five hours apart start their days five hours apart, and
 * a window cut to the later one would open with the earlier one's morning
 * already missing.
 */
export async function earliestDayStart(
  db: D1Database,
  atSec: number,
  fallbackOffsetSec: number,
): Promise<number> {
  const { results } = await db
    .prepare('SELECT tz_offset_sec FROM inverters WHERE enabled = 1')
    .all<{ tz_offset_sec: number | null }>();
  const starts = (results ?? []).map((r) =>
    dayStartSec(atSec, r.tz_offset_sec ?? fallbackOffsetSec),
  );
  return starts.length ? Math.min(...starts) : dayStartSec(atSec, fallbackOffsetSec);
}

/**
 * One row per inverter per day.
 *
 * Every "today" figure the vendors publish is a counter that climbs through
 * the day and resets at local midnight, so the day's total is simply the
 * largest value seen within it - no summing, and no double counting when the
 * same sample is stored twice.
 *
 * Local midnight is the *plant's*, where the vendor told us where the plant is:
 * inverters.tz_offset_sec, learned at discovery. A solar day ends at the
 * array's midnight, so reading the dashboard from another country used to blend
 * two of the plant's days into each row. Plants whose vendor says nothing fall
 * back to the caller's own offset, passed in as the browser's UTC offset in
 * minutes, which is what every plant used before.
 */
export async function daily(
  db: D1Database,
  fromTs: number,
  toTs: number,
  tzOffsetMin: number,
): Promise<DayRow[]> {
  const shift = -tzOffsetMin * 60; // JS offset is minutes to add to local to reach UTC
  const { results } = await db
    .prepare(
      `SELECT r.inverter_id AS inverter_id,
              date(r.ts + COALESCE(i.tz_offset_sec, ?3), 'unixepoch') AS day,
              MAX(r.today_kwh)                                    AS yield_kwh,
              MAX(r.ac_power_w)                                   AS peak_w,
              MAX(json_extract(r.metrics, '$.loadTodayKwh'))      AS load_kwh,
              MAX(json_extract(r.metrics, '$.gridImportTodayKwh')) AS import_kwh,
              MAX(json_extract(r.metrics, '$.gridExportTodayKwh')) AS export_kwh,
              MAX(json_extract(r.metrics, '$.battChargeTodayKwh')) AS batt_charge_kwh,
              MAX(json_extract(r.metrics, '$.battDischargeTodayKwh')) AS batt_discharge_kwh,
              COUNT(*) AS samples,
              MIN(r.ts)  AS first_ts,
              MAX(r.ts)  AS last_ts
       FROM readings r
       LEFT JOIN inverters i ON i.id = r.inverter_id
       WHERE r.ts BETWEEN ?1 AND ?2
       GROUP BY r.inverter_id, day
       ORDER BY day DESC, r.inverter_id`,
    )
    .bind(fromTs, toTs, shift)
    .all<DayRow>();
  return results;
}

/**
 * Query strings never reach the log.
 *
 * SolarMan's token endpoint wants the account's `appId` in the URL - their API,
 * not our choice - so a network failure there can hand us an Error whose
 * message carries the whole URL. That message is written to `poll_log`, which
 * is persisted for a week, returned by `/api/health` and printed in the
 * dashboard footer. A credential has no business travelling that far because a
 * DNS lookup failed, so anything query-shaped is cut out before the write.
 */
export function safeDetail(detail: string): string {
  return detail
    // A URL keeps its origin and path; the query goes.
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s]*/gi, '$1?<redacted>')
    // A bare parameter, for a path logged without its origin.
    .replace(/([?&](?:appId|appSecret|key|keyId|token|secret|password|passwd|sign|email)=)[^&\s]*/gi,
      '$1<redacted>');
}

export async function logPoll(db: D1Database, provider: string, ok: boolean, detail: string): Promise<void> {
  const now = nowSec();
  await db
    .prepare(`INSERT INTO poll_log (ts, provider, ok, detail) VALUES (?1, ?2, ?3, ?4)`)
    .bind(now, provider, ok ? 1 : 0, safeDetail(detail).slice(0, 500))
    .run();
  // Two feeds logging every five minutes is ~576 rows a day, and nothing else
  // ever deletes them. Prune occasionally rather than on every write: the log
  // is a debugging aid, not a ledger, and a week of it is plenty.
  if (Math.random() < 0.02) {
    await db.prepare(`DELETE FROM poll_log WHERE ts < ?1`).bind(now - POLL_LOG_KEEP_S).run();
  }
}

export interface PollRow { ts: number; provider: string; ok: number; detail: string }

/**
 * Newest log line per provider, so a quiet feed cannot hide behind a busy one.
 *
 * This was a SQL query with a correlated subquery - `WHERE ts = (SELECT MAX(ts)
 * ... WHERE provider = p.provider)` - which re-scanned the whole log for every
 * row in it. On a table of 869 rows that read 7,592 rows per call and, at one
 * call per dashboard refresh, accounted for 88% of a day's entire D1 read
 * budget on its own. It is a fold over a list, and it belongs in the language
 * that has one: the rows are already fetched for the poll history beside it.
 *
 * "none" is not a feed - it is the poller saying no credentials were configured
 * at all - so it is left out whenever a real provider has reported, or its
 * long-resolved error would sit in the footer forever.
 */
export function latestPerProvider(polls: PollRow[]): PollRow[] {
  const newest = new Map<string, PollRow>();
  for (const p of polls) {
    const seen = newest.get(p.provider);
    if (!seen || p.ts > seen.ts) newest.set(p.provider, p);
  }
  const all = [...newest.values()].sort((a, b) => a.provider.localeCompare(b.provider));
  const real = all.filter((p) => p.provider !== 'none');
  return real.length ? real : all;
}

export async function recentPolls(db: D1Database, limit = 20) {
  const { results } = await db
    .prepare(`SELECT ts, provider, ok, detail FROM poll_log ORDER BY ts DESC LIMIT ?1`)
    .bind(limit)
    .all<{ ts: number; provider: string; ok: number; detail: string }>();
  return results;
}

export function tokenStore(db: D1Database): TokenStore {
  return {
    async get(provider) {
      const row = await db
        .prepare(`SELECT access_token, expires_at FROM tokens WHERE provider = ?1`)
        .bind(provider)
        .first<{ access_token: string; expires_at: number }>();
      return row ? { accessToken: row.access_token, expiresAt: row.expires_at } : null;
    },
    async set(provider, accessToken, expiresAt) {
      await db
        .prepare(
          `INSERT INTO tokens (provider, access_token, expires_at) VALUES (?1, ?2, ?3)
           ON CONFLICT(provider) DO UPDATE SET access_token = excluded.access_token, expires_at = excluded.expires_at`,
        )
        .bind(provider, accessToken, expiresAt)
        .run();
    },
  };
}

/**
 * Every known inverter id, ordered, for building the public alias map.
 *
 * Two rows on a normal system, so this is cheap enough to call on any request
 * that has to hide an id it did not already load the inverters for.
 */
export async function inverterIds(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare('SELECT id FROM inverters ORDER BY id').all<{ id: string }>();
  return results.map((r) => r.id);
}
