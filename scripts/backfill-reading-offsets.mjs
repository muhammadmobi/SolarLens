/**
 * Give every reading stored before 2.9 the offset it was taken under.
 *
 * Migration 0012 adds `readings.tz_offset_sec`, and from 2.9 every new or
 * re-polled reading carries it. Rows already in the database do not: they come
 * back null, and `daily()` then falls back to the plant's *current* offset -
 * which is exactly the behaviour the migration exists to end. Waiting does not
 * fix them, because only a re-poll of that same timestamp would.
 *
 * So this walks them. For a plant whose vendor states a zone name, each row is
 * asked what that zone meant at its own timestamp; for a plant that only ever
 * sent a number, the number stands, which is the best that can be said for it.
 *
 * It is a no-op in a zone that does not observe daylight saving - every row
 * gets the same offset it would have had anyway - and it is worth running only
 * once, after deploying 2.9.
 *
 * A plant whose zone is not known yet is left alone rather than stamped with
 * today's number. Writing that number would look like a repair and could never
 * be undone - the rows would no longer be null, so no later run would revisit
 * them once a poll had learned the zone. Run this after a poll has been round,
 * or pass --use-current-offset for a plant whose vendor only ever sends one.
 *
 *   node scripts/backfill-reading-offsets.mjs            # what it would do
 *   node scripts/backfill-reading-offsets.mjs --apply    # do it
 *   node scripts/backfill-reading-offsets.mjs --apply --local
 *
 * Writes are batched and counted: D1's free tier allows 100,000 a day, and
 * this says how many it needs before it spends any of them.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APPLY = process.argv.includes('--apply');
const LOCAL = process.argv.includes('--local');
const NUMERIC_OK = process.argv.includes('--use-current-offset');
const BATCH = 200;

const WORK = mkdtempSync(join(tmpdir(), 'solarlens-backfill-'));

/**
 * One `wrangler d1 execute`, through the wrapper that fills in the database id.
 *
 * The statement goes in a file rather than on the command line: the wrapper
 * spawns wrangler with a shell, which splits every argument again at its
 * spaces, and a SQL statement is nothing but spaces. --file is handed one path
 * and reads the rest itself.
 */
function d1(sql) {
  const path = join(WORK, 'statement.sql');
  writeFileSync(path, sql);
  const args = ['scripts/wrangler.mjs', 'd1', 'execute', 'solar-lens', LOCAL ? '--local' : '--remote', '--json', '--file', path];
  const out = execFileSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const start = out.indexOf('[');
  const end = out.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('no JSON in wrangler output:\n' + out.slice(0, 400));
  const parsed = JSON.parse(out.slice(start, end + 1));
  return parsed[0]?.results ?? [];
}

/** What a zone meant at a given moment, or null when the runtime rejects it. */
function offsetAt(zone, tsSec) {
  try {
    const label = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(new Date(tsSec * 1000))
      .find((p) => p.type === 'timeZoneName')?.value;
    const m = label && /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/.exec(label);
    if (!m) return null;
    if (!m[1]) return 0;
    const secs = Number(m[2]) * 3600 + Number(m[3] ?? 0) * 60;
    return m[1] === '-' ? -secs : secs;
  } catch {
    return null;
  }
}

const plants = d1('SELECT id, tz_name, tz_offset_sec FROM inverters');
if (!plants.length) {
  console.log('No inverters yet: nothing to repair.');
  process.exit(0);
}

console.log(`${plants.length} system(s):`);
for (const p of plants) {
  console.log(`  ${p.id}  zone=${p.tz_name ?? '(none stated)'}  offset=${p.tz_offset_sec ?? '(none)'}`);
}

let planned = 0;
let written = 0;
let waiting = 0;

for (const plant of plants) {
  // No zone name, no way to ask what the clocks were doing: today's number is
  // a guess, and writing it would leave the row looking repaired forever.
  if (!plant.tz_name && !NUMERIC_OK) {
    const counted = d1(`SELECT COUNT(*) AS n FROM readings WHERE inverter_id = '${plant.id.replace(/'/g, "''")}' AND tz_offset_sec IS NULL`);
    const n = counted[0]?.n ?? 0;
    waiting += n;
    console.log(`\n${plant.id}: no zone reported yet, ${n} row(s) left as they are.`);
    console.log('  Run a poll first, so discovery can learn the zone - or, for a plant');
    console.log('  whose vendor only ever sends a number, re-run with --use-current-offset.');
    continue;
  }
  const rows = d1(`SELECT ts, source FROM readings WHERE inverter_id = '${plant.id.replace(/'/g, "''")}' AND tz_offset_sec IS NULL`);
  if (!rows.length) {
    console.log(`\n${plant.id}: nothing to repair.`);
    continue;
  }

  // Group by the offset each row should carry, so a zone without daylight
  // saving becomes one statement rather than thousands.
  const byOffset = new Map();
  for (const r of rows) {
    const offset = plant.tz_name ? (offsetAt(plant.tz_name, r.ts) ?? plant.tz_offset_sec) : plant.tz_offset_sec;
    if (offset === null || offset === undefined) continue;
    if (!byOffset.has(offset)) byOffset.set(offset, []);
    byOffset.get(offset).push(r.ts);
  }

  const total = [...byOffset.values()].reduce((n, list) => n + list.length, 0);
  planned += total;
  console.log(`\n${plant.id}: ${rows.length} row(s) with no offset, ${total} repairable`);
  for (const [offset, list] of byOffset) {
    console.log(`  ${list.length} row(s) at ${offset / 3600 >= 0 ? '+' : ''}${offset / 3600}h`);
  }

  if (!APPLY) continue;

  for (const [offset, list] of byOffset) {
    for (let i = 0; i < list.length; i += BATCH) {
      const chunk = list.slice(i, i + BATCH);
      d1(`UPDATE readings SET tz_offset_sec = ${offset}
          WHERE inverter_id = '${plant.id.replace(/'/g, "''")}'
            AND tz_offset_sec IS NULL
            AND ts IN (${chunk.join(',')})`);
      written += chunk.length;
      process.stdout.write(`\r  written ${written}/${planned}`);
    }
  }
  process.stdout.write('\n');
}

rmSync(WORK, { recursive: true, force: true });

console.log(APPLY
  ? `\nDone: ${written} reading(s) now carry the offset they were taken under.`
  : `\n${planned} reading(s) would be repaired. Run again with --apply to do it.`);
if (waiting) {
  console.log(`${waiting} reading(s) left alone, on plants whose zone nobody has reported yet.`);
  console.log('They stay null, so a later run can repair them once a poll knows where they are.');
}
