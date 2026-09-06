import type { Device, Inverter, Metrics, Plant, Provider, Reading } from './types';
import { emptyMetrics } from './types';
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

export const STATION_PREFIX = 'solarman:station:';

/**
 * Station-level snapshot -> Reading. The same field names come back from the
 * official `/station/v1.0/realTime` and the portal's `fast/system` (see
 * docs/api-notes.md), all in W / kWh with no unit strings:
 *   generationPower, usePower, batterySoc, batteryPower, chargePower,
 *   dischargePower, purchasePower|buyPower (import), gridPower (export),
 *   wirePower (net, observed + while buying), generationValue (today kWh),
 *   generationUploadTotal (lifetime kWh), lastUpdateTime (epoch s).
 */
export function stationReading(inv: Inverter, s: Rec, source = 'solarman'): Reading {
  const buy = num(pick(s, 'purchasePower', 'buyPower'));
  const sell = num(pick(s, 'gridPower'));
  const wire = num(pick(s, 'wirePower'));
  const gridPowerW = buy !== null || sell !== null ? (buy ?? 0) - (sell ?? 0) : wire;

  const charge = num(pick(s, 'chargePower')) ?? 0;
  const discharge = num(pick(s, 'dischargePower')) ?? 0;
  const rawBattery = num(pick(s, 'batteryPower'));
  const batteryStatus = String(pick(s, 'batteryStatus') ?? '').toUpperCase();
  let batteryPowerW: number | null;
  if (charge !== 0 || discharge !== 0) batteryPowerW = charge - discharge;
  else if (rawBattery === null) batteryPowerW = null;
  else if (batteryStatus === 'CHARGING') batteryPowerW = Math.abs(rawBattery);
  else if (batteryStatus === 'DISCHARGING') batteryPowerW = -Math.abs(rawBattery);
  else batteryPowerW = rawBattery; // STATIC: a few watts of idle drift, sign irrelevant

  const metrics = emptyMetrics();
  // Today values (kWh) and lifetime "Upload" totals present on fast/system and
  // operating/system; month/year present only on operating/system.
  metrics.genMonthKwh = num(pick(s, 'generationMonth'));
  metrics.genYearKwh = num(pick(s, 'generationYear'));
  metrics.genTotalKwh = num(pick(s, 'generationUploadTotal', 'generationTotal'));
  metrics.loadTodayKwh = num(pick(s, 'useValue'));
  metrics.loadTotalKwh = num(pick(s, 'useTotal', 'useUploadTotal'));
  metrics.gridImportTodayKwh = num(pick(s, 'buyValue'));
  metrics.gridExportTodayKwh = num(pick(s, 'gridValue'));
  metrics.gridImportTotalKwh = num(pick(s, 'buyTotal', 'buyUploadTotal'));
  metrics.gridExportTotalKwh = num(pick(s, 'gridTotal', 'gridUploadTotal'));
  metrics.battChargeTodayKwh = num(pick(s, 'chargeValue'));
  metrics.battDischargeTodayKwh = num(pick(s, 'dischargeValue'));
  metrics.battChargeTotalKwh = num(pick(s, 'chargeTotal', 'chargeUploadTotal'));
  metrics.battDischargeTotalKwh = num(pick(s, 'dischargeTotal', 'dischargeUploadTotal'));
  metrics.selfUseTodayKwh = num(pick(s, 'selfGenAndUseValue'));
  metrics.batteryStatus = (pick(s, 'batteryStatus') as string | null) ?? null;
  metrics.gridStatus = (pick(s, 'wireStatus') as string | null) ?? null;

  const network = String(pick(s, 'networkStatus') ?? '').toUpperCase();
  const warning = String(pick(s, 'warningStatus') ?? '').toUpperCase();
  let status: string | null = null;
  if (warning && warning !== 'NORMAL') status = 'alarm';
  else if (network === 'NORMAL') status = 'online';
  else if (network) status = network.toLowerCase();

  return {
    inverterId: inv.id,
    ts: toEpochSeconds(pick(s, 'lastUpdateTime')),
    source,
    acPowerW: num(pick(s, 'generationPower')),
    dcPowerW: null,
    todayKwh: toKwh(pick(s, 'generationValue'), 'kWh'),
    totalKwh: toKwh(pick(s, 'generationUploadTotal', 'generationTotal'), 'kWh'),
    batterySoc: num(pick(s, 'batterySoc')),
    batteryPowerW,
    gridPowerW,
    loadPowerW: num(pick(s, 'usePower')),
    tempC: num(pick(s, 'temperature')),
    status,
    metrics,
    raw: s,
  };
}

/**
 * A device record from `/maintain-s/fast/device/{stationId}/device-list`.
 *
 * `featureData` is a JSON *string* of raw register key/values - the collector
 * carries its firmware there as `MDUv1` (e.g. "LSW3_15_FFFF_1.0.78"), which is
 * the only place it appears. `signalIntensity` is a 0-100 percentage here, not
 * the dBm SolisCloud reports, so it is kept in its own field.
 */
export function deviceFromRecord(d: Rec, plantId: string | null = null): Device {
  const kind: Device['kind'] = String(pick(d, 'deviceType') ?? '').toUpperCase() === 'COLLECTOR'
    ? 'datalogger'
    : 'inverter';
  const sn = (pick(d, 'deviceSn') as string | null) ?? null;

  let feature: Rec = {};
  try {
    const raw = pick(d, 'featureData');
    if (typeof raw === 'string' && raw.trim().startsWith('{')) feature = JSON.parse(raw) as Rec;
  } catch { /* a malformed blob should not lose the rest of the device */ }

  // deviceStatus: 1 online, 2 alarm, 3 offline (0/absent = unknown).
  const firmware = (pick(feature, 'MDUv1') as string | null) ?? null;
  const statusCode = String(pick(d, 'deviceStatus') ?? '');
  const status = statusCode === '1' ? 'online' : statusCode === '2' ? 'alarm' : statusCode === '3' ? 'offline' : null;

  return {
    id: `solarman:${kind}:${sn ?? String(pick(d, 'deviceId') ?? 'unknown')}`,
    provider: 'solarman',
    plantId: plantId ?? (pick(d, 'stationId') !== undefined ? String(pick(d, 'stationId')) : null),
    kind,
    sn,
    name: (pick(d, 'deviceName') as string | null) ?? (kind === 'datalogger' ? 'Datalogger' : null),
    // MDUv1 is a firmware string like "LSW3_15_FFFF_1.0.78"; its first segment
    // names the logger family, which is the closest thing to a model here.
    model: firmware ? firmware.split('_')[0] : ((pick(d, 'productId') as string | null) ?? null),
    firmware,
    ratedPowerW: null,
    status,
    signalDbm: null,
    signalPct: kind === 'datalogger' ? num(pick(d, 'signalIntensity')) : null,
    uploadCycleS: null,
    commissionedAt: null,
    warrantyUntil: null,
    lastSeen: toEpochSeconds(pick(d, 'collectionTime')),
    // This hybrid reports only total DC input (DPi_t1); no per-string registers.
    strings: null,
    acPhases: null, frequencyHz: null, powerFactor: null, tempC: null, dcBusV: null,
    raw: { ...d, featureData: feature },
  };
}


/**
 * A record from `POST /device-s/device/v3/detail` - the inverter's own page.
 * Unlike `device-list`, whose `featureData` is only a summary, this returns
 * `paramCategoryList` -> `fieldList` entries keyed by `storageName`, which is
 * where SolarMan keeps per-string DC, per-phase AC, BMS and temperatures.
 *
 * Values arrive as strings with a separate `unit`, so everything is parsed
 * rather than trusted, and fields the device-list push owns are left null so
 * the upsert's COALESCE keeps them.
 */
export function deviceFromV3Detail(d: Rec, plantId: string | null = null): Device {
  // Flatten every category into storageName -> { value, unit }.
  const p = new Map<string, { value: unknown; unit: string | null }>();
  for (const cat of (pick(d, 'paramCategoryList') as Rec[] | null) ?? []) {
    for (const fl of (pick(cat, 'fieldList') as Rec[] | null) ?? []) {
      const key = pick(fl, 'storageName') as string | null;
      if (key) p.set(key, { value: pick(fl, 'value'), unit: (pick(fl, 'unit') as string | null) ?? null });
    }
  }
  const val = (k: string) => (p.has(k) ? num(p.get(k)!.value) : null);
  const str = (k: string) => (p.has(k) ? ((p.get(k)!.value as string | null) ?? null) : null);

  // DV/DC/DP are per-PV-string volts, amps and watts. A string wired but dark
  // still reports voltage, so any non-zero reading counts as "this string exists".
  const strings: { index: number; powerW: number; voltageV: number | null; currentA: number | null }[] = [];
  for (let i = 1; i <= 32; i++) {
    const v = val(`DV${i}`), a = val(`DC${i}`), w = val(`DP${i}`);
    if (v === null && a === null && w === null) continue;
    if ((v ?? 0) > 0 || (a ?? 0) > 0 || (w ?? 0) > 0) strings.push({ index: i, powerW: w ?? 0, voltageV: v, currentA: a });
  }

  // AV/AC are per-phase; a single-phase hybrid reports only phase 1.
  const acPhases: { index: number; voltageV: number | null; currentA: number | null }[] = [];
  for (let i = 1; i <= 3; i++) {
    const v = val(`AV${i}`), a = val(`AC${i}`);
    if (v !== null || a !== null) acPhases.push({ index: i, voltageV: v, currentA: a });
  }

  const sn = (pick(d, 'deviceSn') as string | null) ?? str('SN1');
  const state = String(pick(d, 'deviceState') ?? '');
  const firmware = [str('MAIN_1'), str('HMI')].filter(Boolean).join(' / ') || null;

  return {
    id: `solarman:inverter:${sn ?? String(pick(d, 'deviceId') ?? 'unknown')}`,
    provider: 'solarman',
    plantId: plantId ?? (pick(d, 'siteId') !== undefined ? String(pick(d, 'siteId')) : null),
    kind: 'inverter',
    sn,
    name: (pick(d, 'name') as string | null) ?? null,
    // "Single phase LV Hybrid" is the closest thing to a model SolarMan gives.
    model: str('INV_MOD1'),
    firmware,
    ratedPowerW: val('Pr1'),
    status: state === '1' ? 'online' : state === '2' ? 'alarm' : state === '3' ? 'offline' : null,
    signalDbm: null,
    signalPct: null,
    uploadCycleS: null,
    commissionedAt: null,
    warrantyUntil: null,
    lastSeen: toEpochSeconds(pick(d, 'collectionTime')),
    strings,
    acPhases: acPhases.length ? acPhases : null,
    frequencyHz: val('A_Fo1') ?? val('PG_F1'),
    powerFactor: null,
    // AC_T is the inverter's own heatsink; B_T1 is the battery pack's.
    tempC: val('AC_T') ?? val('T_DC'),
    dcBusV: null,
    raw: d,
  };
}

/** A plant treated as its own single monitoring unit. */
export function stationInverter(plant: Plant): Inverter {
  return {
    id: STATION_PREFIX + plant.id,
    provider: 'solarman',
    vendorId: plant.id,
    serial: null,
    name: plant.name,
    plantId: plant.id,
    plantName: plant.name,
    capacityW: plant.capacityW ?? null,
  };
}

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

  private plants = new Map<string, Plant>();

  async listPlants(): Promise<Plant[]> {
    const json = await this.call<Envelope & { stationList?: Rec[] }>('/station/v1.0/list', {
      page: 1,
      size: 50,
    });
    const plants = (json.stationList ?? []).map((s) => ({
      id: String(s.id),
      name: String(pick(s, 'name') ?? s.id),
      // installedCapacity is reported in kW.
      capacityW: toWatts(pick(s, 'installedCapacity'), 'kW'),
    }));
    for (const p of plants) this.plants.set(p.id, p);
    return plants;
  }

  async listInverters(plantId: string): Promise<Inverter[]> {
    const json = await this.call<Envelope & { deviceListItems?: Rec[] }>('/station/v1.0/device', {
      stationId: Number(plantId),
      deviceType: 'INVERTER',
    });
    const invs = (json.deviceListItems ?? []).map((d): Inverter => {
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
    if (invs.length > 0) return invs;
    // No device rows: fall back to the station as the monitoring unit, which
    // for a single-inverter plant carries the same live numbers anyway.
    const plant = this.plants.get(plantId) ?? { id: plantId, name: `Station ${plantId}` };
    return [stationInverter(plant)];
  }

  async getReading(inv: Inverter): Promise<Reading | null> {
    const station = await this.call<Envelope>('/station/v1.0/realTime', { stationId: Number(inv.plantId) });
    if (inv.id.startsWith(STATION_PREFIX) || !inv.serial) return stationReading(inv, station);

    // Device registers add per-inverter energy counters and temperature on top
    // of the station snapshot, which keeps the unambiguous grid/battery splits.
    const device = await this.call<Envelope & { dataList?: Rec[]; collectionTime?: unknown }>(
      '/device/v1.0/currentData',
      { deviceSn: inv.serial },
    );
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

    const base = stationReading(inv, station);
    return {
      ...base,
      ts: toEpochSeconds(pick(device, 'collectionTime') ?? pick(station, 'lastUpdateTime')),
      acPowerW: regW('APo_t1', 'P_AC') ?? base.acPowerW,
      dcPowerW: regW('DPi_t1', 'P_DC'),
      todayKwh: regKwh('Etdy_ge1', 'E_Day') ?? base.todayKwh,
      totalKwh: regKwh('Et_ge0', 'Et_ge1', 'E_Total') ?? base.totalKwh,
      batterySoc: regNum('B_left_cap1', 'SOC') ?? base.batterySoc,
      tempC: regNum('AC_RDT_T1', 'T_AC_RDT1', 'INV_T0') ?? base.tempC,
      status: (regVal('INV_ST1', 'Inverter_Status')?.value as string | undefined) ?? base.status,
      raw: { device, station },
    };
  }
}
