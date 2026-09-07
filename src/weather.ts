/**
 * Site weather from the Google Maps Platform Weather API.
 *
 * The vendors disagree about weather: SolisCloud ships a condition and a
 * min/max with every station snapshot, SolarMan ships none at all. Rather than
 * show one system's sky and leave the other blank, the Worker looks the weather
 * up once per site and stamps it onto both readings.
 *
 * The lookup is optional. With no GOOGLE_WEATHER_KEY set, nothing here runs and
 * whatever the vendor reported stands.
 */

import type { Env } from './db';
import type { Reading } from './providers/types';
import { emptyMetrics } from './providers/types';

const CURRENT = 'https://weather.googleapis.com/v1/currentConditions:lookup';
const FORECAST = 'https://weather.googleapis.com/v1/forecast/days:lookup';

/** How long a lookup stands before we pay for another one. */
const TTL_S = 1800;

export interface SiteWeather {
  text: string | null;
  tempC: number | null;
  tempMinC: number | null;
  tempMaxC: number | null;
  /** Local clock time at the site, "HH:MM". */
  sunrise: string | null;
  sunset: string | null;
}

export interface SiteCoords {
  lat: number;
  lon: number;
}

type Rec = Record<string, unknown>;

const rec = (v: unknown): Rec | null => (v && typeof v === 'object' ? (v as Rec) : null);
const numAt = (o: unknown, ...path: string[]): number | null => {
  let cur: unknown = o;
  for (const k of path) cur = rec(cur)?.[k];
  return typeof cur === 'number' && Number.isFinite(cur) ? cur : null;
};

/** Google hands back RFC3339 UTC; the useful form is the clock at the array. */
function localHhmm(iso: unknown, tz: string | null): string | null {
  if (typeof iso !== 'string' || !iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit', minute: '2-digit', hour12: false,
      ...(tz ? { timeZone: tz } : {}),
    }).format(d);
  } catch {
    return iso.slice(11, 16); // an unknown zone is still better than nothing
  }
}

/**
 * Pull the coordinates a vendor happened to include with the station payload.
 * SolisCloud ships them as strings; SolarMan ships none.
 */
export function coordsFromRaw(raw: unknown): SiteCoords | null {
  const r = rec(raw);
  if (!r) return null;
  const lat = Number(r.latitude ?? r.lat);
  const lon = Number(r.longitude ?? r.lon ?? r.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat === 0 && lon === 0) return null; // the vendor's "unset"
  return { lat, lon };
}

export async function fetchWeather(key: string, at: SiteCoords, fetchImpl = fetch): Promise<SiteWeather | null> {
  const loc = `location.latitude=${at.lat}&location.longitude=${at.lon}`;
  const [curRes, fcRes] = await Promise.all([
    fetchImpl(`${CURRENT}?key=${encodeURIComponent(key)}&${loc}&unitsSystem=METRIC`),
    fetchImpl(`${FORECAST}?key=${encodeURIComponent(key)}&${loc}&days=1&unitsSystem=METRIC`),
  ]);
  if (!curRes.ok && !fcRes.ok) return null;

  const cur = curRes.ok ? ((await curRes.json()) as Rec) : {};
  const fc = fcRes.ok ? ((await fcRes.json()) as Rec) : {};
  const day = rec((fc.forecastDays as unknown[] | undefined)?.[0]) ?? {};
  const tz = (rec(fc.timeZone)?.id as string | null) ?? (rec(cur.timeZone)?.id as string | null) ?? null;
  const sun = rec(day.sunEvents) ?? {};

  const text = (rec(rec(cur.weatherCondition)?.description)?.text as string | null) ?? null;
  const w: SiteWeather = {
    text,
    tempC: numAt(cur, 'temperature', 'degrees'),
    tempMinC: numAt(day, 'minTemperature', 'degrees'),
    tempMaxC: numAt(day, 'maxTemperature', 'degrees'),
    sunrise: localHhmm(sun.sunriseTime, tz),
    sunset: localHhmm(sun.sunsetTime, tz),
  };
  return Object.values(w).some((v) => v !== null) ? w : null;
}

/**
 * Cached lookup. Every inverter at the same coordinates shares one call, and a
 * cached answer stands for half an hour - the sky does not move at the five
 * minute cadence the inverters do.
 */
export async function siteWeather(
  db: D1Database,
  key: string | undefined,
  at: SiteCoords | null,
  now = Math.floor(Date.now() / 1000),
): Promise<SiteWeather | null> {
  if (!key || !at) return null;
  const k = `weather:${at.lat.toFixed(3)},${at.lon.toFixed(3)}`;
  const hit = await db
    .prepare(`SELECT v FROM kv WHERE k = ?1 AND expires_at > ?2`)
    .bind(k, now)
    .first<{ v: string }>();
  if (hit) return JSON.parse(hit.v) as SiteWeather;

  let fresh: SiteWeather | null = null;
  try {
    fresh = await fetchWeather(key, at);
  } catch {
    return null; // a weather outage must never fail the poll
  }
  if (!fresh) return null;

  await db
    .prepare(
      `INSERT INTO kv (k, v, expires_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v, expires_at = excluded.expires_at`,
    )
    .bind(k, JSON.stringify(fresh), now + TTL_S)
    .run();
  return fresh;
}

/**
 * Stamp the site's weather onto a reading, overwriting whatever the vendor
 * said. One source for both systems beats two half-filled ones - and SolarMan
 * has no weather of its own to lose.
 */
export async function stampWeather(env: Env, reading: Reading): Promise<void> {
  if (!env.GOOGLE_WEATHER_KEY) return;
  const at = coordsFromRaw(reading.raw) ?? envCoords(env);
  const w = await siteWeather(env.DB, env.GOOGLE_WEATHER_KEY, at);
  if (!w) return;
  const m = (reading.metrics ??= emptyMetrics());
  if (w.text !== null) m.weatherText = w.text;
  if (w.tempMinC !== null) m.tempMinC = w.tempMinC;
  if (w.tempMaxC !== null) m.tempMaxC = w.tempMaxC;
  if (w.tempC !== null) m.tempNowC = w.tempC;
  if (w.sunrise !== null) m.sunrise = w.sunrise;
  if (w.sunset !== null) m.sunset = w.sunset;
}

/** Fallback coordinates, for a vendor (SolarMan) that ships none. */
export function envCoords(env: Env): SiteCoords | null {
  const lat = Number(env.SITE_LAT), lon = Number(env.SITE_LON);
  if (!env.SITE_LAT || !env.SITE_LON || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}
