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

/**
 * A day of a hybrid system with a house and a battery: a reading every 20 minutes from midnight; sun from
 * 06:00 to 18:00, peaking at `peakW` at noon; the house drawing `baseW`, and `eveningW` from 18:00 to 22:00;
 * the grid making up the difference; `middayW`, from 10:00 to 14:00, when given. The battery is kept full -
 * idle, its charge between 97 and 100% - or, with `cycle`, runs the house from 18:00, down to `cycle`% by
 * 06:00, and charges at up to 800 W until noon; `battery: false` is a house with none. The day counters
 * climb with the readings, as an inverter's do.
 */
export async function addHybridDay(
  db: D1Database, id: string, iso: string,
  o: { peakW?: number; baseW?: number; eveningW?: number; middayW?: number; cycle?: number; battery?: false } = {},
) {
  const peak = o.peakW ?? 3000;
  const base = o.baseW ?? 300;
  const evening = o.eveningW ?? 900;
  const has = o.battery !== false;
  const kwh = (w: number) => (w * 20) / 60 / 1000;
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  let made = 0, used = 0, bought = 0, sold = 0, charged = 0, gave = 0;
  const values: string[] = [];
  const binds: unknown[] = [];
  for (let i = 0; i < 72; i++) {
    const hour = i / 3;
    const power = hour >= 6 && hour < 18 ? Math.round(peak * Math.sin((Math.PI * (hour - 6)) / 12)) : 0;
    const load = hour >= 18 && hour < 22 ? evening : o.middayW != null && hour >= 10 && hour < 14 ? o.middayW : base;
    let battery = 0;
    let soc: number | null = has ? 97 + (i % 4) : null;
    if (o.cycle != null) {
      const night = hour < 6 || hour >= 18;
      const since = hour >= 18 ? hour - 18 : hour + 6;
      soc = night ? Math.round(100 - ((100 - o.cycle) * since) / 12) : Math.min(100, Math.round(o.cycle + ((100 - o.cycle) * (hour - 6)) / 6));
      battery = night ? -load : hour < 12 ? Math.min(power, 800) : 0;
    }
    // Battery power is above zero while charging: what charges it is drawn, what it gives covers the house.
    const grid = load + battery - power;
    made += kwh(power);
    used += kwh(load);
    if (grid > 0) bought += kwh(grid); else sold += kwh(-grid);
    if (battery > 0) charged += kwh(battery); else gave += kwh(-battery);
    const metrics = JSON.stringify({
      loadTodayKwh: r3(used), gridImportTodayKwh: r3(bought), gridExportTodayKwh: r3(sold),
      ...(has ? { battChargeTodayKwh: r3(charged), battDischargeTodayKwh: r3(gave) } : {}),
    });
    const n = binds.length;
    values.push(`(?${n + 1}, ?${n + 2}, 'test', ?${n + 3}, ?${n + 4}, ?${n + 5}, ?${n + 6}, ?${n + 7}, ?${n + 8}, ?${n + 9}, 0)`);
    binds.push(id, dayNumber(iso) * DAY + i * 1200, power, load, grid, has ? battery : null, soc, r3(made), metrics);
  }
  await db.prepare(`INSERT INTO readings (inverter_id, ts, source, ac_power_w, load_power_w, grid_power_w, battery_power_w, battery_soc, today_kwh, metrics, tz_offset_sec) VALUES ${values.join(', ')}`)
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
