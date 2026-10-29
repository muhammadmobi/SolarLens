/**
 * Whole days of made-up solar data, quickly: a system, a day's readings, the
 * day's sunlight, a fault. For the tests of the tools and the agents, which
 * need weeks of history - and a reading at a time is too slow for weeks.
 *
 * A day is written the way the relays and the cron leave it: readings every 13
 * minutes from 06:00 to past 19:30 (on the plant's clock), today_kwh climbing to the day's
 * total, so the daily rows see a full day with the total as its yield. Sunlight
 * is hourly, each row stamped at the end of its hour, as Open-Meteo's are
 * stored. Every name here is invented.
 */
export const DAY = 86400;
/** Readings a written day has: past MIN_SAMPLES (60), so it counts as fully recorded. */
export const READINGS = 64;

export const dayNumber = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 1000 / DAY;
export const isoOf = (n: number) => new Date(n * DAY * 1000).toISOString().slice(0, 10);

export async function addSystem(db: D1Database, s: { id: string; name: string; kwp: number | null; provider?: string; off?: number }) {
  await db
    .prepare(
      `INSERT INTO inverters (id, provider, vendor_id, name, plant_name, capacity_w, tz_offset_sec, first_seen, last_seen)
       VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, 1, 1)`,
    )
    .bind(s.id, s.provider ?? 'solarman', s.id.split(':').pop(), s.name, s.kwp == null ? null : s.kwp * 1000, s.off ?? 0)
    .run();
}

/**
 * One day's readings for a system: `kwh` made by the end of it, and optionally
 * what was sold and what the house used. `skip` leaves out the readings between
 * two clock times ('10:00'-'13:00') - a stretch the system went unrecorded.
 */
export async function addDay(
  db: D1Database, id: string, iso: string, kwh: number,
  o: { exported?: number; used?: number; off?: number; skip?: [string, string]; readings?: number } = {},
) {
  const off = o.off ?? 0;
  const start = dayNumber(iso) * DAY - off + 6 * 3600;
  const n = o.readings ?? READINGS;
  const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const values: string[] = [];
  const binds: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const ts = start + i * 780;
    const at = 6 * 60 + i * 13;
    if (o.skip && at > minutes(o.skip[0]) && at < minutes(o.skip[1])) continue;
    const share = (i + 1) / n;
    const metrics = JSON.stringify({
      ...(o.exported != null ? { gridExportTodayKwh: o.exported * share } : {}),
      ...(o.used != null ? { loadTodayKwh: o.used * share } : {}),
    });
    values.push(`(?${binds.length + 1}, ?${binds.length + 2}, 'test', ?${binds.length + 3}, ?${binds.length + 4}, ?${binds.length + 5}, ?${binds.length + 6})`);
    binds.push(id, ts, 1000, Math.round(kwh * share * 1000) / 1000, metrics, off);
  }
  if (!values.length) return;
  await db.prepare(`INSERT INTO readings (inverter_id, ts, source, ac_power_w, today_kwh, metrics, tz_offset_sec) VALUES ${values.join(', ')}`)
    .bind(...binds).run();
}

/** A day's sunlight for a system: `kwhM2` spread over the hours 07:00 to 19:00, with `cloud` percent cloud. */
export async function addSun(db: D1Database, id: string, iso: string, kwhM2: number, cloud = 20, off = 0) {
  const values: string[] = [];
  const binds: unknown[] = [];
  for (let h = 8; h <= 19; h++) {
    values.push(`(?${binds.length + 1}, ?${binds.length + 2}, ?${binds.length + 3}, 18, ?${binds.length + 4})`);
    binds.push(id, dayNumber(iso) * DAY - off + h * 3600, (kwhM2 * 1000) / 12, cloud);
  }
  await db.prepare(`INSERT OR REPLACE INTO weather_hourly (inverter_id, ts, ghi_wm2, temp_c, cloud_pct) VALUES ${values.join(', ')}`)
    .bind(...binds).run();
}

/** A vendor fault on a system, from `begin` to `end` (null: still active), in epoch seconds. */
export async function addFault(db: D1Database, id: string, key: string, begin: number, end: number | null, message: string, severity = 'warning') {
  await db
    .prepare(
      `INSERT INTO alarms (id, inverter_id, provider, code, message, severity, begin_ts, end_ts, state, first_seen, last_seen)
       VALUES (?1, ?2, 'solarman', '7', ?3, ?4, ?5, ?6, ?7, ?5, ?5)`,
    )
    .bind(key, id, message, severity, begin, end, end ? 'recovered' : 'active')
    .run();
}
