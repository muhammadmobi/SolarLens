import type { Device, Inverter, Plant, Provider, Reading } from './types';
import { CallQueue } from './queue';
import { num, pick, toWatts } from './units';
import { STATION_PREFIX, deviceFromRecord, stationInverter, stationReading, type TokenStore } from './solarman';

/**
 * UNOFFICIAL fallback: drives the same endpoints the SOLARMAN Smart web portal
 * uses, authenticated with tokens copied from a browser login. Password login
 * is deliberately NOT implemented - the portal requires a Cloudflare Turnstile
 * token with every password grant, and that is a human step by design.
 *
 * Use it only until the official Business API keys arrive (see solarman.ts).
 * It can break whenever the portal changes; the refresh grant below is a
 * standard OAuth2 form and has not yet been exercised against the real server.
 */
export interface SolarmanWebCredentials {
  refreshToken: string;
  /** Optional seed; otherwise the first poll refreshes straight away. */
  accessToken?: string;
}

const BASE_URL = 'https://home.solarmanpv.com';
const TOKEN_KEY = 'solarman-web';
const REFRESH_KEY = 'solarman-web-refresh';

const queue = new CallQueue(1500);

type Rec = Record<string, unknown>;

export class SolarmanWebProvider implements Provider {
  readonly id = 'solarman' as const;

  constructor(
    private readonly creds: SolarmanWebCredentials,
    private readonly tokens: TokenStore,
  ) {}

  private async refresh(): Promise<string> {
    const stored = await this.tokens.get(REFRESH_KEY);
    const refreshToken = stored?.accessToken ?? this.creds.refreshToken;
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: 'test',
      system: 'SOLARMAN',
      identity_type: '2',
    });
    const json = await queue.run(async () => {
      const res = await fetch(`${BASE_URL}/mdc-eu/oauth2-s/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
      });
      if (!res.ok) throw new Error(`solarman-web: refresh HTTP ${res.status}`);
      return (await res.json()) as Rec;
    });
    const access = pick(json, 'access_token') as string | null;
    if (!access) throw new Error(`solarman-web: refresh refused - ${pick(json, 'msg', 'error') ?? 'unknown'}`);
    // Portal access tokens last 24 h; renew with an hour to spare.
    const ttl = num(pick(json, 'expires_in')) ?? 86_400;
    const now = Math.floor(Date.now() / 1000);
    await this.tokens.set(TOKEN_KEY, access, now + ttl - 3600);
    const rotated = pick(json, 'refresh_token') as string | null;
    if (rotated) await this.tokens.set(REFRESH_KEY, rotated, now + 90 * 24 * 3600);
    return access;
  }

  private async token(force = false): Promise<string> {
    if (!force) {
      const cached = await this.tokens.get(TOKEN_KEY);
      if (cached && cached.expiresAt > Date.now() / 1000) return cached.accessToken;
      if (this.creds.accessToken) return this.creds.accessToken;
    }
    return this.refresh();
  }

  private async call<T>(method: 'GET' | 'POST', path: string, payload?: unknown, retry = true): Promise<T> {
    const bearer = await this.token();
    const res = await queue.run(() =>
      fetch(BASE_URL + path, {
        method,
        headers: {
          Authorization: `Bearer ${bearer}`,
          Accept: 'application/json',
          ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: payload !== undefined ? JSON.stringify(payload) : undefined,
      }),
    );
    if (res.status === 401 && retry) {
      await this.token(true);
      return this.call<T>(method, path, payload, false);
    }
    if (!res.ok) throw new Error(`solarman-web: HTTP ${res.status} on ${path}`);
    return (await res.json()) as T;
  }

  private plants = new Map<string, Plant>();

  async listPlants(): Promise<Plant[]> {
    const json = await this.call<{ data?: Rec[] }>('POST', '/maintain-s/operating/station/search', {});
    const plants = (json.data ?? []).map((s) => ({
      id: String(s.id),
      name: String(pick(s, 'name', 'stationName') ?? `Station ${s.id}`),
      capacityW: toWatts(pick(s, 'installedCapacity'), 'kW'),
    }));
    for (const p of plants) this.plants.set(p.id, p);
    return plants;
  }

  async listInverters(plantId: string): Promise<Inverter[]> {
    const plant = this.plants.get(plantId) ?? { id: plantId, name: `Station ${plantId}` };
    return [stationInverter(plant)];
  }

  /**
   * Hardware behind the station. The portal only ever asks for INVERTER, so
   * the datalogger (COLLECTOR) - and with it the signal strength and logger
   * firmware - needs an explicit second call.
   */
  async listDevices(plantId: string): Promise<Device[]> {
    const out: Device[] = [];
    for (const type of ['INVERTER', 'COLLECTOR'] as const) {
      const rows = await this
        .call<Rec[]>('GET', `/maintain-s/fast/device/${plantId}/device-list?deviceType=${type}`)
        .catch(() => [] as Rec[]);
      for (const r of rows ?? []) out.push(deviceFromRecord(r, plantId));
    }
    return out;
  }

  async getReading(inv: Inverter): Promise<Reading | null> {
    if (!inv.id.startsWith(STATION_PREFIX)) return null;
    // operating/system is the richest single snapshot: live power + battery +
    // today/month/year/total energy in one call (fast/system lacks month/year).
    const s = await this.call<Rec>('GET', `/maintain-s/operating/system/${inv.plantId}`);
    return s ? stationReading(inv, s, 'solarman-web') : null;
  }
}
