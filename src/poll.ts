import type { Env } from './db';
import { insertReading, isDue, logPoll, markDone, tokenStore, upsertAlarms, upsertDevice, upsertInverter, upsertPeriods } from './db';
import type { Period } from './providers/events';
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
        tokenStore(env.DB),
      ),
    );
  } else if (env.SOLARMAN_WEB_REFRESH_TOKEN) {
    providers.push(
      new SolarmanWebProvider(
        { refreshToken: env.SOLARMAN_WEB_REFRESH_TOKEN, accessToken: env.SOLARMAN_WEB_ACCESS_TOKEN },
        tokenStore(env.DB),
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

export interface PollSummary {
  provider: string;
  ok: boolean;
  inverters: number;
  newReadings: number;
  error?: string;
}

async function pollProvider(env: Env, p: Provider): Promise<PollSummary> {
  const wanted = plantFilter(env);
  let inverters = 0;
  let newReadings = 0;
  try {
    const plants = (await p.listPlants()).filter((plant) => wanted(plant.id));
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
    // expense: a failure here is logged by omission, not by failing the poll.
    for (const plant of plants) await pollExtras(env, p, plant.id).catch(() => {});
    await logPoll(env.DB, p.id, true, `plants=${plants.length} inverters=${inverters} new=${newReadings}`);
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
export async function pollAll(env: Env): Promise<PollSummary[]> {
  const providers = buildProviders(env);
  if (providers.length === 0) {
    await logPoll(env.DB, 'none', false, 'no provider credentials configured');
    return [];
  }
  return Promise.all(providers.map((p) => pollProvider(env, p)));
}
