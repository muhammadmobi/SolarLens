/**
 * Where each system is, and the sunlight it has had.
 *
 * What a system *should* have made depends on the weather, and neither vendor
 * says how much sun fell on the roof. Open-Meteo does - free, with no key - for
 * any point on the map, hour by hour, and for days already gone. So:
 *
 * - each vendor's plant record gives its position (SolisCloud's latitude and
 *   longitude, SolarMan's locationLat and locationLng), kept in plant_location;
 * - once an hour the cron asks Open-Meteo for each position's sunlight,
 *   temperature and cloud - once for all the systems at one position - and
 *   keeps them in weather_hourly: the first time for the last three months,
 *   after that for the last day;
 * - the page sets each system's output against its sunlight: the expected
 *   line on its day curve, and an alert when it makes far less than the sun
 *   allowed.
 *
 * A position is the owner's alone. It is served only to a signed-in owner, for
 * the site map, and sent nowhere but to Open-Meteo - rounded to two decimal
 * places, about a kilometre, which changes nothing about the weather and keeps
 * the exact rooftop out of anyone else's logs.
 */
import { nowSec } from './db';

// Reading a position out of a vendor's record is the providers' business: they
// read the rest of it. It lives with them, and is passed on from here for the
// relay's ingest route, which reads one too.
export { locationOf } from './providers/units';

type Rec = Record<string, unknown>;

/**
 * Keep a system's position - or, in one statement, the position of every
 * system of a plant, which is the plant's. A record that carries none leaves
 * the known one alone.
 */
export async function upsertLocation(db: D1Database, inverterIds: string | string[], loc: { lat: number; lng: number } | null, at = nowSec()): Promise<void> {
  const ids = typeof inverterIds === 'string' ? [inverterIds] : inverterIds;
  if (!loc || !ids.length) return;
  await db
    .prepare(
      `INSERT INTO plant_location (inverter_id, lat, lng, updated_at)
       SELECT value, ?2, ?3, ?4 FROM json_each(?1) WHERE true
       ON CONFLICT(inverter_id) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, updated_at = excluded.updated_at`,
    )
    .bind(JSON.stringify(ids), loc.lat, loc.lng, at)
    .run();
}

export interface LocationRow {
  inverter_id: string;
  lat: number;
  lng: number;
}

/** Every known position. For the owner's site map and for the weather fetch; never public. */
export async function locations(db: D1Database): Promise<LocationRow[]> {
  const { results } = await db.prepare('SELECT inverter_id, lat, lng FROM plant_location ORDER BY inverter_id').all<LocationRow>();
  return results;
}

// ---------------------------------------------------------------- the weather

export const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast';
/** How far back the first fetch reaches: Open-Meteo's forecast API keeps 92 days. */
export const FIRST_DAYS = 92;
/** How long an hour of weather is kept. */
export const WEATHER_KEEP_S = 400 * 86400;

/** Two decimal places: about a kilometre, which is all the weather needs. */
const rounded = (v: number) => Math.round(v * 100) / 100;

export interface WeatherHour {
  ts: number;
  ghi_wm2: number | null;
  temp_c: number | null;
  cloud_pct: number | null;
}

/**
 * Open-Meteo's hourly answer, as rows. Its times are Unix seconds, and
 * shortwave_radiation at a time is the average over the hour *before* it - so
 * each row's ts is the end of the hour it describes, the moment its sunlight
 * had all fallen, which is how weather_hourly stores it.
 */
export function parseWeather(json: unknown): WeatherHour[] {
  const h = (json as { hourly?: Rec } | null)?.hourly;
  if (!h || !Array.isArray(h.time)) return [];
  const col = (k: string) => (Array.isArray(h[k]) ? (h[k] as unknown[]) : []);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return (h.time as unknown[]).flatMap((t, i) => (typeof t === 'number'
    ? [{ ts: t, ghi_wm2: num(col('shortwave_radiation')[i]), temp_c: num(col('temperature_2m')[i]), cloud_pct: num(col('cloud_cover')[i]) }]
    : []));
}

/** Ask Open-Meteo for one position's hours, `pastDays` back to the end of today. */
export async function fetchWeather(loc: { lat: number; lng: number }, pastDays: number, fetcher: typeof fetch = fetch): Promise<WeatherHour[]> {
  const url = new URL(WEATHER_URL);
  url.searchParams.set('latitude', String(rounded(loc.lat)));
  url.searchParams.set('longitude', String(rounded(loc.lng)));
  url.searchParams.set('hourly', 'shortwave_radiation,temperature_2m,cloud_cover');
  url.searchParams.set('past_days', String(pastDays));
  url.searchParams.set('forecast_days', '1');
  url.searchParams.set('timeformat', 'unixtime');
  url.searchParams.set('timezone', 'GMT');
  const res = await fetcher(url.toString(), { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`weather: HTTP ${res.status}`);
  return parseWeather(await res.json());
}

/**
 * Keep hours of weather, for one system or for every system at one position. An hour already kept is
 * updated: a forecast becomes a measurement.
 */
export async function storeWeather(db: D1Database, inverterIds: string | string[], hours: WeatherHour[], now = nowSec()): Promise<number> {
  // Only hours that have happened: a forecast is not what the sun did.
  const past = hours.filter((h) => h.ts <= now);
  if (!past.length) return 0;
  // One statement for every hour and every system, read from JSON arrays: the
  // first fetch brings three months - over two thousand hours - and on D1's
  // free plan each query in an invocation counts against a small limit, a
  // batch's included.
  await db
    .prepare(
      `INSERT INTO weather_hourly (inverter_id, ts, ghi_wm2, temp_c, cloud_pct)
       SELECT s.value, json_extract(h.value, '$.ts'), json_extract(h.value, '$.ghi_wm2'), json_extract(h.value, '$.temp_c'), json_extract(h.value, '$.cloud_pct')
       FROM json_each(?1) AS s, json_each(?2) AS h WHERE true
       ON CONFLICT(inverter_id, ts) DO UPDATE SET ghi_wm2 = excluded.ghi_wm2, temp_c = excluded.temp_c, cloud_pct = excluded.cloud_pct`,
    )
    .bind(JSON.stringify(typeof inverterIds === 'string' ? [inverterIds] : inverterIds), JSON.stringify(past))
    .run();
  return past.length;
}

/** The most positions one hourly run fetches; any more wait for the hours after, the longest-waiting first. */
export const PLACES_PER_RUN = 6;

/**
 * The hourly cron's part (./cron hourly): the weather at each position whose
 * last hour gone is not kept yet - the first time reaching three months back.
 *
 * However many systems there are, a run asks a bounded amount of D1 and of
 * Open-Meteo. The systems of one plant share its position, so each position -
 * rounded, as it is sent - is fetched once and kept for all of them in one
 * statement; one query reads every position with the newest hour kept for it;
 * and at most PLACES_PER_RUN positions are fetched, so a run is at most that
 * many fetches and that many statements and two more. A failure for one
 * position is logged and leaves the others alone.
 */
export async function refreshWeather(db: D1Database, now = nowSec(), fetcher: typeof fetch = fetch): Promise<void> {
  // The newest hour kept for each system: one seek each, on weather_hourly's key.
  const { results } = await db
    .prepare(
      `SELECT l.inverter_id, l.lat, l.lng, (SELECT MAX(ts) FROM weather_hourly w WHERE w.inverter_id = l.inverter_id) AS last
       FROM plant_location l ORDER BY l.inverter_id`,
    )
    .all<LocationRow & { last: number | null }>();
  const places = new Map<string, { lat: number; lng: number; ids: string[]; last: number }>();
  for (const r of results) {
    const lat = rounded(r.lat), lng = rounded(r.lng);
    const place = places.get(`${lat},${lng}`) ?? { lat, lng, ids: [], last: Infinity };
    places.set(`${lat},${lng}`, place);
    place.ids.push(r.inverter_id);
    // A position is as far behind as its furthest-behind system: one with nothing kept, all the way.
    place.last = Math.min(place.last, r.last ?? 0);
  }
  // Open-Meteo's hours end on the hour: the one that has just ended is the one to have.
  const hourGone = now - (now % 3600);
  const due = [...places.values()].filter((p) => !p.last || p.last < hourGone).sort((a, b) => a.last - b.last).slice(0, PLACES_PER_RUN);
  for (const p of due) {
    try {
      await storeWeather(db, p.ids, await fetchWeather(p, p.last ? 1 : FIRST_DAYS, fetcher), now);
    } catch (e) {
      console.warn(JSON.stringify({ weather: 'failed', detail: String((e as Error)?.message ?? e).slice(0, 120) }));
    }
  }
  await db.prepare('DELETE FROM weather_hourly WHERE ts < ?1').bind(now - WEATHER_KEEP_S).run();
}

/** Every system's weather since `from`, oldest first. */
export async function weatherSince(db: D1Database, from: number): Promise<(WeatherHour & { inverter_id: string })[]> {
  const { results } = await db
    .prepare('SELECT inverter_id, ts, ghi_wm2, temp_c, cloud_pct FROM weather_hourly WHERE ts >= ?1 ORDER BY ts')
    .bind(from)
    .all<WeatherHour & { inverter_id: string }>();
  return results;
}
