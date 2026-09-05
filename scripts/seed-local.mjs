#!/usr/bin/env node
/**
 * Seeds the LOCAL D1 with two fake inverters and a plausible bell-curve of
 * readings for today, so the dashboard can be worked on without credentials.
 * Never touches the remote database.
 *
 *   npm run seed:local
 */
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const now = Math.floor(Date.now() / 1000);
const day = new Date();
day.setHours(0, 0, 0, 0);
const t0 = Math.floor(day.getTime() / 1000);

const inverters = [
  { id: 'soliscloud:demo1', provider: 'soliscloud', vendorId: 'demo1', serial: 'SOLIS-DEMO-001', name: 'Solis 5K hybrid', plant: 'Home (Solis)', cap: 5000, peak: 4200, battery: true },
  { id: 'solarman:demo2', provider: 'solarman', vendorId: 'demo2', serial: 'SM-DEMO-002', name: 'Deye 3.6K', plant: 'Home (SolarMan)', cap: 3600, peak: 3100, battery: false },
];

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const sql = [];
sql.push('DELETE FROM readings; DELETE FROM inverters; DELETE FROM poll_log;');
for (const inv of inverters) {
  sql.push(
    `INSERT INTO inverters (id, provider, vendor_id, serial, name, plant_id, plant_name, capacity_w, first_seen, last_seen)
     VALUES (${q(inv.id)}, ${q(inv.provider)}, ${q(inv.vendorId)}, ${q(inv.serial)}, ${q(inv.name)}, 'p1', ${q(inv.plant)}, ${inv.cap}, ${t0}, ${now});`,
  );
  let today = 0;
  for (let ts = t0; ts <= now; ts += 300) {
    const h = (ts - t0) / 3600;
    // Daylight roughly 06:30-19:30; sine hump peaking around 13:00.
    const sun = Math.max(0, Math.sin(((h - 6.5) / 13) * Math.PI));
    const jitter = 0.9 + Math.random() * 0.2;
    const ac = Math.round(inv.peak * sun * jitter);
    today += (ac / 1000) * (300 / 3600);
    const load = 400 + Math.round(Math.random() * 900);
    const grid = load - ac;
    const soc = inv.battery ? Math.round(30 + 60 * Math.min(1, Math.max(0, (h - 7) / 8))) : null;
    const battP = inv.battery ? (ac > load ? Math.min(2500, ac - load) : -Math.min(1500, load - ac)) : null;
    sql.push(
      `INSERT OR IGNORE INTO readings (inverter_id, ts, source, ac_power_w, dc_power_w, today_kwh, total_kwh, battery_soc, battery_power_w, grid_power_w, load_power_w, temp_c, status, raw)
       VALUES (${q(inv.id)}, ${ts}, ${q(inv.provider)}, ${ac}, ${Math.round(ac * 1.04)}, ${today.toFixed(2)}, ${(12345 + today).toFixed(1)}, ${soc}, ${battP}, ${inv.battery ? grid - (battP ?? 0) : grid}, ${load}, ${(28 + 12 * sun).toFixed(1)}, 'online', '{"seed":true}');`,
    );
  }
}
sql.push(`INSERT INTO poll_log (ts, provider, ok, detail) VALUES (${now}, 'seed', 1, 'seeded ${inverters.length} demo inverters');`);

const file = join(mkdtempSync(join(tmpdir(), 'solarlens-seed-')), 'seed.sql');
writeFileSync(file, sql.join('\n'));
const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'solar-lens', '--local', `--file=${file}`], { stdio: 'inherit', shell: true });
process.exit(r.status ?? 1);
