/**
 * One cron run: build a client for every vendor whose secrets are present, and
 * for each of them list the plants, list the inverters, and store a reading for
 * each. Slower things - fault history hourly, the vendor's own period totals
 * daily - ride along through pollExtras when they are due.
 *
 * SolisCloud normally has no client here: its portal cannot be read from a
 * server, so a relay laptop pushes its readings to /api/ingest instead (see
 * agent/solis-relay.mjs). It appears here only once an official API key is set.
 */
import type { Env } from './db';
import { insertReading, isDue, logPoll, markDone, safeDetail, tokenStore, upsertAlarms, upsertDevice, upsertInverter, upsertPeriods } from './db';
import type { Period } from './providers/events';
import { upsertLocation } from './weather';
import { SolisCloudProvider } from './providers/soliscloud';
import { SolarmanProvider } from './providers/solarman';
import { SolarmanWebProvider } from './providers/solarman-web';
import type { Provider } from './providers/types';

/**
 * A provider is "configured" purely by which secrets are present, so the same
 * deploy works with one cloud today and both once the SolarMan keys arrive.
 * Official SolarMan keys win over the web-session fallback when both exist.
 */
export function buildProviders(env: Env): Provider[] {
  const providers: Provider[] = [];
  if (env.SOLIS_KEY_ID && env.SOLIS_KEY_SECRET) {
    providers.push(new SolisCloudProvider({ keyId: env.SOLIS_KEY_ID, keySecret: env.SOLIS_KEY_SECRET }));
  }
  // No SolisCloud key? The local relay agent (agent/solis-relay.mjs) pushes
  // readings through /api/ingest/station instead - nothing to build here.
  if (env.SOLARMAN_APP_ID && env.SOLARMAN_APP_SECRET && env.SOLARMAN_EMAIL && env.SOLARMAN_PASSWORD_SHA256) {
    providers.push(
      new SolarmanProvider(
        {
          appId: env.SOLARMAN_APP_ID,
          appSecret: env.SOLARMAN_APP_SECRET,
          email: env.SOLARMAN_EMAIL,
          passwordSha256: env.SOLARMAN_PASSWORD_SHA256,
        },
        tokenStore(env.DB, env.SECRET_KEY),
      ),
    );
  } else if (env.SOLARMAN_WEB_REFRESH_TOKEN) {
    providers.push(
      new SolarmanWebProvider(
        { refreshToken: env.SOLARMAN_WEB_REFRESH_TOKEN, accessToken: env.SOLARMAN_WEB_ACCESS_TOKEN },
        tokenStore(env.DB, env.SECRET_KEY),
      ),
    );
  }
  return providers;
}

/** INCLUDE_PLANTS="<solis-plant-id>,<solarman-station-id>" limits polling to those vendor plant ids. */
export function plantFilter(env: Env): (plantId: string) => boolean {
  const ids = (env.INCLUDE_PLANTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length === 0 ? () => true : (id) => ids.includes(id);
}

/**
 * Which of a vendor's plants this cron run reads, once there are many.
 *
 * Each plant costs several vendor calls a run - the snapshot, the device list,
 * each inverter's detail - and the runs share one request budget with the
 * queue's pacing between calls (./providers/queue). Up to four plants are all
 * read every five minutes, as before. Past that, the plants are dealt into at
 * most three groups and each run reads one group in turn, so every plant is
 * still read at least every fifteen minutes - inside the 25 minutes after which
 * the page calls a system offline. Past twelve plants a group grows rather than
 * a plant waiting longer.
 *
 * `run` is the number of the five-minute slot, so consecutive runs take
 * consecutive groups and every group gets its turn.
 */
export const PLANTS_PER_RUN = 4;
export const MAX_GROUPS = 3;
export function plantsThisRun<T extends { id: string }>(plants: T[], run: number): T[] {
  if (plants.length <= PLANTS_PER_RUN) return plants;
  const groups = Math.min(MAX_GROUPS, Math.ceil(plants.length / PLANTS_PER_RUN));
  // Sorted, so a plant stays in its group from one run to the next even if
  // the vendor lists them in a different order.
  const sorted = [...plants].sort((a, b) => a.id.localeCompare(b.id));
  const turn = ((run % groups) + groups) % groups;
  return sorted.filter((_, i) => i % groups === turn);
}

export interface PollSummary {
  provider: string;
  ok: boolean;
  inverters: number;
  newReadings: number;
  error?: string;
}

/**
 * Poll one vendor end to end and log the outcome. A failure is caught and
 * written to the poll log rather than thrown, so one vendor being down never
 * stops the other being read.
 */
async function pollProvider(env: Env, p: Provider, run: number): Promise<PollSummary> {
  const wanted = plantFilter(env);
  let inverters = 0;
  let newReadings = 0;
  try {
    const all = (await p.listPlants()).filter((plant) => wanted(plant.id));
    const plants = plantsThisRun(all, run);
    for (const plant of plants) {
      const invs = await p.listInverters(plant.id);
      // Hardware inventory, where the provider exposes it. A failure here must
      // not lose the readings, which are the point of the poll.
      if (p.listDevices) {
        try {
          for (const d of await p.listDevices(plant.id)) await upsertDevice(env.DB, d);
        } catch { /* devices are supplementary */ }
      }
      for (const inv of invs) {
        // Where it is, for the weather and the owner's map; never published.
        await upsertLocation(env.DB, inv.id, plant.location ?? null);
        if (!inv.plantName) inv.plantName = plant.name;
        if (inv.capacityW === null) inv.capacityW = plant.capacityW ?? null;
        // getReading may fill in name/serial for plant-level units, so read first, then upsert.
        const reading = await p.getReading(inv);
        if (!inv.name) inv.name = plant.name;
        await upsertInverter(env.DB, inv);
        inverters++;
        if (reading && (await insertReading(env.DB, reading))) newReadings++;
      }
    }
    // Slow-moving extras, on their own schedules and never at the readings'
    // expense: a failure here is logged, not allowed to fail the poll. It used
    // to be dropped in silence, so fault history could stop with no trace.
    for (const plant of plants) {
      await pollExtras(env, p, plant.id).catch((e) => {
        console.warn(JSON.stringify({ poll: 'extras failed', provider: p.id, error: safeDetail(e instanceof Error ? e.message : String(e)).slice(0, 200) }));
      });
    }
    const of = plants.length < all.length ? ` of ${all.length}` : '';
    await logPoll(env.DB, p.id, true, `plants=${plants.length}${of} inverters=${inverters} new=${newReadings}`);
    return { provider: p.id, ok: true, inverters, newReadings };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logPoll(env.DB, p.id, false, message);
    return { provider: p.id, ok: false, inverters, newReadings, error: message };
  }
}

const HOUR = 3600;
const DAY = 86400;
// Far enough back for any system this dashboard is likely to watch. The loop
// stops earlier, at the first year before the plant existed.
const MAX_YEARS_BACK = 10;

/**
 * Fault history hourly and the vendor's own period totals daily - both change
 * far more slowly than the five-minute readings, and each fetch costs vendor
 * calls and D1 writes that the readings need more.
 *
 * The first daily run walks back year by year until a year comes back empty,
 * so the page can show months and years from before SolarLens began collecting.
 * Later runs refresh only this year and this month, which is all that changes.
 */
export async function pollExtras(env: Env, p: Provider, plantId: string, now = new Date()): Promise<void> {
  if (p.listAlarms && (await isDue(env.DB, `alarms:${p.id}:${plantId}`))) {
    await upsertAlarms(env.DB, await p.listAlarms(plantId));
    await markDone(env.DB, `alarms:${p.id}:${plantId}`, HOUR);
  }

  if (p.listPeriods && (await isDue(env.DB, `periods:${p.id}:${plantId}`))) {
    const year = now.getUTCFullYear();
    const backfilled = !(await isDue(env.DB, `periods-backfill:${p.id}:${plantId}`));
    const months: Period[] = [];
    for (let y = year, back = 0; back <= (backfilled ? 0 : MAX_YEARS_BACK); y--, back++) {
      const rows = await p.listPeriods(plantId, y);
      // An empty year before a year with data is the year before installation.
      if (!rows.length && months.length) break;
      months.push(...rows);
    }
    const days = await p.listPeriods(plantId, year, now.getUTCMonth() + 1);
    await upsertPeriods(env.DB, [...months, ...days, ...yearsFromMonths(months)]);
    await markDone(env.DB, `periods:${p.id}:${plantId}`, DAY);
    // A backfill is kept for a year, then re-run in case the vendor corrected history.
    if (!backfilled) await markDone(env.DB, `periods-backfill:${p.id}:${plantId}`, 365 * DAY);
  }
}

/**
 * Year totals built from the vendor's own month totals. SolarMan serves months
 * per year but no year-by-year summary; the sum of a year's months is that
 * year's total by the vendor's own count, with nothing estimated.
 */
export function yearsFromMonths(months: Period[]): Period[] {
  const add = (a: number | null, b: number | null) => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));
  const out = new Map<string, Period>();
  for (const m of months) {
    if (m.period !== 'month') continue;
    const key = `${m.inverterId}|${m.key.slice(0, 4)}`;
    const y = out.get(key) ?? {
      ...m, period: 'year' as const, key: m.key.slice(0, 4),
      yieldKwh: null, loadKwh: null, importKwh: null, exportKwh: null,
      chargeKwh: null, dischargeKwh: null, fullHours: null,
    };
    y.yieldKwh = add(y.yieldKwh, m.yieldKwh);
    y.loadKwh = add(y.loadKwh, m.loadKwh);
    y.importKwh = add(y.importKwh, m.importKwh);
    y.exportKwh = add(y.exportKwh, m.exportKwh);
    y.chargeKwh = add(y.chargeKwh, m.chargeKwh);
    y.dischargeKwh = add(y.dischargeKwh, m.dischargeKwh);
    y.fullHours = add(y.fullHours, m.fullHours);
    out.set(key, y);
  }
  return [...out.values()];
}

/** Providers hit different hosts, so they run concurrently; each one's own queue paces its calls. */
export async function pollAll(env: Env, at = Date.now()): Promise<PollSummary[]> {
  const providers = buildProviders(env);
  if (providers.length === 0) {
    await logPoll(env.DB, 'none', false, 'no provider credentials configured');
    return [];
  }
  const run = Math.floor(at / 300_000);
  return Promise.all(providers.map((p) => pollProvider(env, p, run)));
}
