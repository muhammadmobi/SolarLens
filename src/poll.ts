import type { Env } from './db';
import { insertReading, logPoll, tokenStore, upsertInverter } from './db';
import { SolisCloudProvider } from './providers/soliscloud';
import { SolarmanProvider } from './providers/solarman';
import type { Provider } from './providers/types';

/**
 * A provider is "configured" purely by which secrets are present, so the same
 * deploy works with one cloud today and both once the SolarMan keys arrive.
 */
export function buildProviders(env: Env): Provider[] {
  const providers: Provider[] = [];
  if (env.SOLIS_KEY_ID && env.SOLIS_KEY_SECRET) {
    providers.push(new SolisCloudProvider({ keyId: env.SOLIS_KEY_ID, keySecret: env.SOLIS_KEY_SECRET }));
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
  }
  return providers;
}

export interface PollSummary {
  provider: string;
  ok: boolean;
  inverters: number;
  newReadings: number;
  error?: string;
}

async function pollProvider(env: Env, p: Provider): Promise<PollSummary> {
  let inverters = 0;
  let newReadings = 0;
  try {
    const plants = await p.listPlants();
    for (const plant of plants) {
      const invs = await p.listInverters(plant.id);
      for (const inv of invs) {
        if (!inv.plantName) inv.plantName = plant.name;
        if (inv.capacityW === null) inv.capacityW = plant.capacityW ?? null;
        await upsertInverter(env.DB, inv);
        inverters++;
        const reading = await p.getReading(inv);
        if (reading && (await insertReading(env.DB, reading))) newReadings++;
      }
    }
    await logPoll(env.DB, p.id, true, `inverters=${inverters} new=${newReadings}`);
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
