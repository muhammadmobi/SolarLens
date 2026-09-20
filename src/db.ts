import type { Device, Inverter, Reading } from './providers/types';
import type { TokenStore } from './providers/solarman';
import type { Alarm, Period } from './providers/events';
import { offsetOfZoneAt } from './providers/units';
import type { RelayStatus } from './relays';

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
      `INSERT INTO inverters (id, provider, vendor_id, serial, name, plant_id, plant_name, capacity_w, tz_name, tz_offset_sec, first_seen, last_seen)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?10, ?11, ?9, ?9)
       ON CONFLICT(id) DO UPDATE SET
         serial     = COALESCE(excluded.serial, inverters.serial),
         name       = COALESCE(excluded.name, inverters.name),
         plant_id   = excluded.plant_id,
         plant_name = CASE WHEN excluded.plant_name = '' THEN inverters.plant_name ELSE excluded.plant_name END,
         capacity_w = COALESCE(excluded.capacity_w, inverters.capacity_w),
         tz_name       = COALESCE(excluded.tz_name, inverters.tz_name),
         tz_offset_sec = COALESCE(excluded.tz_offset_sec, inverters.tz_offset_sec),
         last_seen  = excluded.last_seen`,
    )
    .bind(inv.id, inv.provider, inv.vendorId, inv.serial, inv.name, inv.plantId, inv.plantName, inv.capacityW, seenAt, inv.tzName ?? null, inv.tzOffsetSec ?? null)
    .run();
}

/**
 * INSERT OR IGNORE on the (inverter, ts, source) key means re-polling a vendor
 * that has not produced a new sample is a no-op rather than a duplicate row.
 */
/**
 * The offset in force where this plant is, at the moment this reading was
 * taken.
 *
 * A zone name is asked what it meant at that instant; a plant whose vendor only
 * ever states a number falls back to that number, which is the best that can be
 * said for it. Stored on the reading rather than read from the inverter later,
 * so a day's rows keep the boundary they were recorded under even after the
 * clocks change.
 */
async function offsetForReading(db: D1Database, inverterId: string, tsSec: number): Promise<number | null> {
  const row = await db
    .prepare('SELECT tz_name, tz_offset_sec FROM inverters WHERE id = ?1')
    .bind(inverterId)
    .first<{ tz_name: string | null; tz_offset_sec: number | null }>();
  if (!row) return null;
  if (row.tz_name) return offsetOfZoneAt(row.tz_name, tsSec) ?? row.tz_offset_sec;
  return row.tz_offset_sec;
}

export async function insertReading(db: D1Database, r: Reading): Promise<boolean> {
  const tzOffsetSec = await offsetForReading(db, r.inverterId, r.ts);
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO readings
         (inverter_id, ts, source, ac_power_w, dc_power_w, today_kwh, total_kwh,
          battery_soc, battery_power_w, grid_power_w, load_power_w, temp_c, status, raw, metrics, tz_offset_sec)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
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
      tzOffsetSec,
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
              date(r.ts + COALESCE(r.tz_offset_sec, i.tz_offset_sec, ?3), 'unixepoch') AS day,
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

// ---------- fault history and vendor period totals ----------

/** D1 caps how much one batch may carry; fifty statements stays well inside it. */
async function inBatches(db: D1Database, stmts: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
}

/**
 * Store alarms, updating any already known. An alarm is usually first read
 * while active and later again once recovered, so the end, state and advice
 * are taken from the newer read; the first-seen time is kept from the first.
 */
export async function upsertAlarms(db: D1Database, alarms: Alarm[], seenAt = nowSec()): Promise<number> {
  const stmts = alarms.map((a) =>
    db.prepare(
      `INSERT INTO alarms (id, inverter_id, provider, code, message, severity, vendor_level, advice,
                           begin_ts, end_ts, state, first_seen, last_seen)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
       ON CONFLICT(id) DO UPDATE SET
         message   = COALESCE(excluded.message, alarms.message),
         severity  = COALESCE(excluded.severity, alarms.severity),
         advice    = COALESCE(excluded.advice, alarms.advice),
         end_ts    = COALESCE(excluded.end_ts, alarms.end_ts),
         state     = CASE WHEN excluded.state = 'unknown' THEN alarms.state ELSE excluded.state END,
         last_seen = excluded.last_seen`,
    ).bind(a.id, a.inverterId, a.provider, a.code, a.message, a.severity, a.vendorLevel, a.advice,
      a.beginTs, a.endTs, a.state, seenAt));
  await inBatches(db, stmts);
  return stmts.length;
}

export interface AlarmRow {
  id: string;
  inverter_id: string;
  provider: string;
  code: string;
  message: string | null;
  severity: string | null;
  vendor_level: number | null;
  advice: string | null;
  begin_ts: number;
  end_ts: number | null;
  state: string;
}

/** Newest first. Capped, because a flapping grid can raise dozens in a week. */
export async function listAlarms(db: D1Database, sinceTs: number, limit = 1000): Promise<AlarmRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, inverter_id, provider, code, message, severity, vendor_level, advice, begin_ts, end_ts, state
       FROM alarms WHERE begin_ts >= ?1 ORDER BY begin_ts DESC LIMIT ?2`,
    )
    .bind(sinceTs, limit)
    .all<AlarmRow>();
  return results;
}

/** Store the vendor's own totals; a newer fetch of the same period replaces the older. */
export async function upsertPeriods(db: D1Database, periods: Period[], fetchedAt = nowSec()): Promise<number> {
  const stmts = periods.map((p) =>
    db.prepare(
      `INSERT INTO vendor_periods (inverter_id, period, key, yield_kwh, load_kwh, import_kwh, export_kwh,
                                   charge_kwh, discharge_kwh, full_hours, source, fetched_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
       ON CONFLICT(inverter_id, period, key) DO UPDATE SET
         yield_kwh = excluded.yield_kwh, load_kwh = excluded.load_kwh,
         import_kwh = excluded.import_kwh, export_kwh = excluded.export_kwh,
         charge_kwh = excluded.charge_kwh, discharge_kwh = excluded.discharge_kwh,
         full_hours = excluded.full_hours, source = excluded.source, fetched_at = excluded.fetched_at`,
    ).bind(p.inverterId, p.period, p.key, p.yieldKwh, p.loadKwh, p.importKwh, p.exportKwh,
      p.chargeKwh, p.dischargeKwh, p.fullHours, p.source, fetchedAt));
  await inBatches(db, stmts);
  return stmts.length;
}

export interface PeriodRow {
  inverter_id: string;
  period: string;
  key: string;
  yield_kwh: number | null;
  load_kwh: number | null;
  import_kwh: number | null;
  export_kwh: number | null;
  charge_kwh: number | null;
  discharge_kwh: number | null;
  full_hours: number | null;
  source: string;
}

/**
 * Month and year totals only. Daily totals exist too, but the page already has
 * its own record of every day since it began; what it lacks is the months and
 * years from before that, and a year of day rows is not worth a read per view.
 */
export async function listPeriods(db: D1Database): Promise<PeriodRow[]> {
  const { results } = await db
    .prepare(
      `SELECT inverter_id, period, key, yield_kwh, load_kwh, import_kwh, export_kwh,
              charge_kwh, discharge_kwh, full_hours, source
       FROM vendor_periods WHERE period IN ('month', 'year') ORDER BY key DESC`,
    )
    .all<PeriodRow>();
  return results;
}

/**
 * A small "has this run lately?" memory, in the kv table migration 0007 made.
 * Alarm history and period totals change far more slowly than the five-minute
 * cron, so each is fetched only when its key has expired.
 */
export async function isDue(db: D1Database, key: string, now = nowSec()): Promise<boolean> {
  const row = await db.prepare('SELECT expires_at FROM kv WHERE k = ?1').bind(key).first<{ expires_at: number }>();
  return !row || row.expires_at <= now;
}

export async function markDone(db: D1Database, key: string, everySec: number, now = nowSec()): Promise<void> {
  await db
    .prepare(
      `INSERT INTO kv (k, v, expires_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v, expires_at = excluded.expires_at`,
    )
    .bind(key, String(now), now + everySec)
    .run();
}

// ---------- relays ----------

/** Store a relay's report. A newer expiry replaces an older one; a report without one keeps what is known. */
export async function upsertRelay(db: D1Database, r: RelayStatus, now = nowSec()): Promise<void> {
  await db
    .prepare(
      `INSERT INTO relays (id, provider, name, state, login_expires_at, first_seen, last_seen, last_ok_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, CASE WHEN ?4 = 'ok' THEN ?6 END)
       ON CONFLICT(id) DO UPDATE SET
         name             = COALESCE(excluded.name, relays.name),
         state            = excluded.state,
         login_expires_at = COALESCE(excluded.login_expires_at, relays.login_expires_at),
         last_seen        = excluded.last_seen,
         last_ok_at       = CASE WHEN excluded.state = 'ok' THEN excluded.last_seen ELSE relays.last_ok_at END`,
    )
    .bind(r.id, r.provider, r.name, r.state, r.loginExpiresAt, now)
    .run();
}

export interface RelayRow {
  id: string;
  provider: string;
  name: string | null;
  state: string;
  login_expires_at: number | null;
  first_seen: number;
  last_seen: number;
  last_ok_at: number | null;
}

/** Relays heard from since `sinceTs`, oldest first, so their numbering is stable. */
export async function listRelays(db: D1Database, sinceTs: number): Promise<RelayRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, provider, name, state, login_expires_at, first_seen, last_seen, last_ok_at
       FROM relays WHERE last_seen >= ?1 ORDER BY first_seen, id`,
    )
    .bind(sinceTs)
    .all<RelayRow>();
  return results;
}
