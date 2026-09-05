import type { Inverter, Reading } from './providers/types';
import type { TokenStore } from './providers/solarman';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  SOLIS_KEY_ID?: string;
  SOLIS_KEY_SECRET?: string;
  /** Web-session fallback: portal token copied from a browser login, and the header it goes in. */
  SOLIS_WEB_TOKEN?: string;
  SOLIS_WEB_TOKEN_HEADER?: string;
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
          battery_soc, battery_power_w, grid_power_w, load_power_w, temp_c, status, raw)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
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
    )
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export interface LatestRow {
  id: string;
  provider: string;
  serial: string | null;
  name: string;
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
}

/** Newest reading per enabled inverter, whichever source produced it. */
export async function latest(db: D1Database): Promise<LatestRow[]> {
  const { results } = await db
    .prepare(
      `SELECT i.id, i.provider, i.serial, i.name, i.plant_name, i.capacity_w, i.display_order,
              r.ts, r.source, r.ac_power_w, r.dc_power_w, r.today_kwh, r.total_kwh,
              r.battery_soc, r.battery_power_w, r.grid_power_w, r.load_power_w, r.temp_c, r.status
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
