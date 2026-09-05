import type { Inverter, Plant, Provider, Reading } from './types';
import { CallQueue } from './queue';
import { num, pick, toEpochSeconds, toKwh, toWatts } from './units';

export interface SolarmanCredentials {
  appId: string;
  appSecret: string;
  email: string;
  /** sha256 hex of the SolarMan Smart password - the API never sees plaintext. */
  passwordSha256: string;
}

/** Where a bearer token lives between cron runs (D1 in production). */
export interface TokenStore {
  get(provider: string): Promise<{ accessToken: string; expiresAt: number } | null>;
  set(provider: string, accessToken: string, expiresAt: number): Promise<void>;
}

const BASE_URL = 'https://globalapi.solarmanpv.com';

// SolarMan's limits are undocumented but it is the same backend as SolisCloud,
// so the same spacing keeps us well clear of whatever they enforce.
const queue = new CallQueue(1500);

type Rec = Record<string, unknown>;

interface Envelope extends Rec {
  success?: boolean;
  code?: string | null;
  msg?: string | null;
}

type TokenResponse = Envelope & { access_token?: string; expires_in?: number | string };

export class SolarmanProvider implements Provider {
  readonly id = 'solarman' as const;

  constructor(
    private readonly creds: SolarmanCredentials,
    private readonly tokens: TokenStore,
  ) {}

  private async fetchToken(): Promise<string> {
    const url = `${BASE_URL}/account/v1.0/token?appId=${encodeURIComponent(this.creds.appId)}&language=en`;
    const json = await queue.run(async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appSecret: this.creds.appSecret,
          email: this.creds.email,
          password: this.creds.passwordSha256,
        }),
      });
      if (!res.ok) throw new Error(`solarman: token HTTP ${res.status}`);
      return (await res.json()) as TokenResponse;
    });
    if (json.success === false || !json.access_token) {
      throw new Error(`solarman: token refused - ${json.msg ?? json.code ?? 'unknown'}`);
    }
    // Tokens last ~60 days; refresh a day early so a cron never trips on expiry.
    const ttl = num(json.expires_in) ?? 60 * 24 * 3600;
    const expiresAt = Math.floor(Date.now() / 1000) + ttl - 24 * 3600;
    await this.tokens.set(this.id, json.access_token, expiresAt);
    return json.access_token;
  }

  private async token(force = false): Promise<string> {
    if (!force) {
      const cached = await this.tokens.get(this.id);
      if (cached && cached.expiresAt > Date.now() / 1000) return cached.accessToken;
    }
    return this.fetchToken();
  }

  private async call<T extends Envelope>(path: string, payload: unknown, retry = true): Promise<T> {
    const bearer = await this.token();
    const res = await queue.run(() =>
      fetch(BASE_URL + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `bearer ${bearer}` },
        body: JSON.stringify(payload),
      }),
    );
    if (res.status === 401 && retry) {
      await this.token(true);
      return this.call<T>(path, payload, false);
    }
    if (!res.ok) throw new Error(`solarman: HTTP ${res.status} on ${path}`);
    const json = (await res.json()) as T;
    if (json.success === false) {
      // 2101 is "token expired" in SolarMan's own code table.
      if (String(json.code) === '2101' && retry) {
        await this.token(true);
        return this.call<T>(path, payload, false);
      }
      throw new Error(`solarman: ${path} -> code=${json.code} msg=${json.msg ?? 'unknown'}`);
    }
    return json;
  }

  async listPlants(): Promise<Plant[]> {
    const json = await this.call<Envelope & { stationList?: Rec[] }>('/station/v1.0/list', {
      page: 1,
      size: 50,
    });
    return (json.stationList ?? []).map((s) => ({
      id: String(s.id),
      name: String(pick(s, 'name') ?? s.id),
      // installedCapacity is reported in kW.
      capacityW: toWatts(pick(s, 'installedCapacity'), 'kW'),
    }));
  }

  async listInverters(plantId: string): Promise<Inverter[]> {
    const json = await this.call<Envelope & { deviceListItems?: Rec[] }>('/station/v1.0/device', {
      stationId: Number(plantId),
      deviceType: 'INVERTER',
    });
    return (json.deviceListItems ?? []).map((d) => {
      const serial = String(pick(d, 'deviceSn') ?? '');
      const vendorId = String(pick(d, 'deviceId') ?? serial);
      return {
        id: `solarman:${vendorId}`,
        provider: 'solarman',
        vendorId,
        serial: serial || null,
        name: serial || vendorId,
        plantId,
        plantName: '',
        capacityW: null,
      };
    });
  }

  async getReading(inv: Inverter): Promise<Reading | null> {
    if (!inv.serial) return null;

    // Two calls per inverter: the device's own registers carry energy counters
    // and temperature; the station realtime view carries the unambiguous
    // charge/discharge and buy/sell splits that make sign conventions moot.
    const [device, station] = await Promise.all([
      this.call<Envelope & { dataList?: Rec[]; collectionTime?: unknown }>('/device/v1.0/currentData', {
        deviceSn: inv.serial,
      }),
      this.call<Envelope>('/station/v1.0/realTime', { stationId: Number(inv.plantId) }),
    ]);

    const reg = new Map<string, Rec>();
    for (const item of device.dataList ?? []) reg.set(String(item.key), item);
    const regVal = (...keys: string[]) => {
      for (const k of keys) {
        const item = reg.get(k);
        if (item && item.value !== null && item.value !== undefined && item.value !== '') {
          return { value: item.value, unit: item.unit };
        }
      }
      return null;
    };
    const regNum = (...keys: string[]) => num(regVal(...keys)?.value);
    const regW = (...keys: string[]) => {
      const v = regVal(...keys);
      return v ? toWatts(v.value, v.unit) : null;
    };
    const regKwh = (...keys: string[]) => {
      const v = regVal(...keys);
      return v ? toKwh(v.value, v.unit) : null;
    };

    const purchase = num(pick(station, 'purchasePower'));
    const feedIn = num(pick(station, 'wirePower'));
    const charge = num(pick(station, 'chargePower'));
    const discharge = num(pick(station, 'dischargePower'));

    const gridPowerW =
      purchase !== null || feedIn !== null
        ? (purchase ?? 0) - (feedIn ?? 0)
        : num(pick(station, 'gridPower'));
    const batteryPowerW =
      charge !== null || discharge !== null
        ? (charge ?? 0) - (discharge ?? 0)
        : num(pick(station, 'batteryPower'));

    return {
      inverterId: inv.id,
      ts: toEpochSeconds(pick(device, 'collectionTime') ?? pick(station, 'lastUpdateTime')),
      source: 'solarman',
      acPowerW: regW('APo_t1', 'P_AC') ?? num(pick(station, 'generationPower')),
      dcPowerW: regW('DPi_t1', 'P_DC'),
      todayKwh: regKwh('Etdy_ge1', 'E_Day'),
      totalKwh: regKwh('Et_ge0', 'Et_ge1', 'E_Total'),
      batterySoc: regNum('B_left_cap1', 'SOC') ?? num(pick(station, 'batterySoc')),
      batteryPowerW,
      gridPowerW,
      loadPowerW: num(pick(station, 'usePower')),
      tempC: regNum('AC_RDT_T1', 'T_AC_RDT1', 'INV_T0'),
      status: (regVal('INV_ST1', 'Inverter_Status')?.value as string | undefined) ?? null,
      raw: { device, station },
    };
  }
}
