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
      `INSERT INTO inverters (id, provider, vendor_id, serial, name, plant_id, plant_name, capacity_w, first_seen, last_seen)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
       ON CONFLICT(id) DO UPDATE SET
         serial     = COALESCE(excluded.serial, inverters.serial),
         name       = COALESCE(excluded.name, inverters.name),
         plant_id   = excluded.plant_id,
         plant_name = CASE WHEN excluded.plant_name = '' THEN inverters.plant_name ELSE excluded.plant_name END,
         capacity_w = COALESCE(excluded.capacity_w, inverters.capacity_w),
         last_seen  = excluded.last_seen`,
    )
    .bind(inv.id, inv.provider, inv.vendorId, inv.serial, inv.name, inv.plantId, inv.plantName, inv.capacityW, seenAt)
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
  return (res.meta.changes ?? 0) > 0;
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
              r.ts, r.source, r.ac_power_w, r.dc_power_w, r.today_kwh, r.total_kwh,
              r.battery_soc, r.battery_power_w, r.grid_power_w, r.load_power_w, r.temp_c, r.status,
              r.metrics, r.raw
       FROM inverters i
       LEFT JOIN readings r
         ON r.rowid = (SELECT rowid FROM readings WHERE inverter_id = i.id ORDER BY ts DESC LIMIT 1)
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
          signal_dbm, signal_pct, upload_cycle_s, commissioned_at, warranty_until, last_seen, strings, ac_phases, frequency_hz, power_factor, temp_c, dc_bus_v, updated_at, raw)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24)
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
         updated_at      = excluded.updated_at,
         raw             = COALESCE(excluded.raw, devices.raw)`,
    )
    .bind(
      d.id, d.provider, d.plantId, d.kind, d.sn, d.name, d.model, d.firmware, d.ratedPowerW,
      d.status, d.signalDbm, d.signalPct, d.uploadCycleS, d.commissionedAt, d.warrantyUntil, d.lastSeen,
      d.strings ? JSON.stringify(d.strings) : null,
      d.acPhases ? JSON.stringify(d.acPhases) : null,
      d.frequencyHz, d.powerFactor, d.tempC, d.dcBusV,
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

export async function series(db: D1Database, fromTs: number, toTs: number): Promise<SeriesRow[]> {
  const { results } = await db
    .prepare(
      `SELECT inverter_id, ts, ac_power_w, today_kwh, battery_soc, grid_power_w
       FROM readings
       WHERE ts BETWEEN ?1 AND ?2
       ORDER BY ts ASC`,
    )
    .bind(fromTs, toTs)
    .all<SeriesRow>();
  return results;
}

export async function logPoll(db: D1Database, provider: string, ok: boolean, detail: string): Promise<void> {
  await db
    .prepare(`INSERT INTO poll_log (ts, provider, ok, detail) VALUES (?1, ?2, ?3, ?4)`)
    .bind(nowSec(), provider, ok ? 1 : 0, detail.slice(0, 500))
    .run();
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
