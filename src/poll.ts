import type { Env } from './db';
import { insertReading, logPoll, tokenStore, upsertInverter } from './db';
import { SolisCloudProvider } from './providers/soliscloud';
import { SolisCloudWebProvider } from './providers/soliscloud-web';
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
  } else if (env.SOLIS_WEB_TOKEN) {
    providers.push(new SolisCloudWebProvider({ token: env.SOLIS_WEB_TOKEN, headerName: env.SOLIS_WEB_TOKEN_HEADER }));
  }
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

/** INCLUDE_PLANTS="1298491919449414894,62034057" limits polling to those vendor plant ids. */
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
    await logPoll(env.DB, p.id, true, `plants=${plants.length} inverters=${inverters} new=${newReadings}`);
    return { provider: p.id, ok: true, inverters, newReadings };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logPoll(env.DB, p.id, false, message);
    return { provider: p.id, ok: false, inverters, newReadings, error: message };
  }
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
