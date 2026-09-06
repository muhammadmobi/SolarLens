import type { Device, Inverter, Metrics, Plant, Provider, Reading } from './types';
import { emptyMetrics } from './types';
import { CallQueue } from './queue';
import { num, pick, toEpochSeconds, toKwh, toWatts } from './units';

export interface SolisCredentials {
  keyId: string;
  keySecret: string;
}

const BASE_URL = 'https://www.soliscloud.com:13333';
const CONTENT_TYPE = 'application/json';

// 3 calls / 5 s per IP is the documented ceiling; 2 s spacing leaves headroom
// for a second Worker isolate sharing the same egress IP.
const queue = new CallQueue(2000);

const enc = new TextEncoder();

function b64(buf: ArrayBuffer): string {
  let s = '';
  for (const byte of new Uint8Array(buf)) s += String.fromCharCode(byte);
  return btoa(s);
}

async function contentMd5(body: string): Promise<string> {
  // MD5 is a documented Cloudflare Workers extension to WebCrypto. It is not
  // in the standard, so this line is Workers-only by design; the Node probe
  // script re-implements it with node:crypto.
  return b64(await crypto.subtle.digest('MD5', enc.encode(body)));
}

async function hmacSha1(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  return b64(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

/**
 * Authorization = "API " + KeyId + ":" + base64(HmacSHA1(KeySecret,
 *   VERB + LF + Content-MD5 + LF + Content-Type + LF + Date + LF + CanonicalizedResource))
 */
export async function signedHeaders(
  creds: SolisCredentials,
  path: string,
  body: string,
): Promise<Record<string, string>> {
  const md5 = await contentMd5(body);
  const date = new Date().toUTCString();
  const stringToSign = ['POST', md5, CONTENT_TYPE, date, path].join('\n');
  const sign = await hmacSha1(creds.keySecret, stringToSign);
  return {
    'Content-Type': CONTENT_TYPE,
    'Content-MD5': md5,
    Date: date,
    Authorization: `API ${creds.keyId}:${sign}`,
  };
}

interface SolisEnvelope<T> {
  success?: boolean;
  code?: string | number;
  msg?: string;
  data?: T;
}

interface SolisPage<T> {
  page?: { records?: T[]; total?: number };
}

async function call<T>(creds: SolisCredentials, path: string, payload: unknown): Promise<T> {
  const body = JSON.stringify(payload);
  const headers = await signedHeaders(creds, path, body);
  return queue.run(async () => {
    const res = await fetch(BASE_URL + path, { method: 'POST', headers, body });
    if (res.status === 408) {
      throw new Error('soliscloud: HTTP 408 - clock skew >15 min between caller and SolisCloud');
    }
    if (!res.ok) throw new Error(`soliscloud: HTTP ${res.status} on ${path}`);
    const json = (await res.json()) as SolisEnvelope<T>;
    const ok = json.success === true || String(json.code) === '0';
    if (!ok || json.data === undefined) {
      throw new Error(`soliscloud: ${path} -> code=${json.code} msg=${json.msg ?? 'unknown'}`);
    }
    return json.data;
  });
}

type Rec = Record<string, unknown>;

/** SolisCloud `state`: 1 online, 2 offline, 3 alarm. */
function mapState(state: unknown): string | null {
  switch (String(state ?? '')) {
    case '1':
      return 'online';
    case '2':
      return 'offline';
    case '3':
      return 'alarm';
    case '':
      return null;
    default:
      return `state:${state}`;
  }
}

/** Ids of plant-level pseudo-inverters, used when a plant lists no inverters (see below). */
const STATION_PREFIX = 'soliscloud:station:';

/**
 * Plant-level snapshot -> Reading. Field names confirmed on the live portal
 * (docs/api-notes.md): `power`/`powerStr`, `dayEnergy`/`dayEnergyStr`,
 * `allEnergy`/`allEnergyStr`, `psum` (positive = export), `dataTimestamp` (ms).
 */
/** Paired value+unit energy field -> kWh; SolisCloud names them `x` / `xStr`. */
function kwhPair(d: Rec, key: string): number | null {
  return toKwh(pick(d, key), pick(d, `${key}Str`));
}

/**
 * An on-grid plant still reports `batteryCapacitySoc2: 0` and zeroed battery
 * counters. Taking those at face value invents a permanently-empty battery, so
 * the plant's own inventory decides whether battery fields mean anything.
 */
function plantHasBattery(d: Rec): boolean {
  const count = num(pick(d, 'batteryCount'));
  if (count !== null && count > 0) return true;
  const list = pick(d, 'batteries');
  return Array.isArray(list) && list.length > 0;
}

function stationMetrics(d: Rec): Metrics {
  const m = emptyMetrics();
  m.genMonthKwh = kwhPair(d, 'monthEnergy');
  m.genYearKwh = kwhPair(d, 'yearEnergy');
  m.genTotalKwh = kwhPair(d, 'allEnergy');
  m.loadTodayKwh = kwhPair(d, 'homeLoadEnergy') ?? kwhPair(d, 'homeLoadTodayEnergy');
  m.loadTotalKwh = kwhPair(d, 'homeLoadTotalEnergy');
  m.gridImportTodayKwh = kwhPair(d, 'gridPurchasedDayEnergy');
  m.gridExportTodayKwh = kwhPair(d, 'gridSellDayEnergy');
  m.gridImportTotalKwh = kwhPair(d, 'gridPurchasedTotalEnergy');
  m.gridExportTotalKwh = kwhPair(d, 'gridSellTotalEnergy');
  if (plantHasBattery(d)) {
    m.battChargeTodayKwh = kwhPair(d, 'batteryChargeEnergy');
    m.battDischargeTodayKwh = kwhPair(d, 'batteryDischargeEnergy');
    m.battChargeTotalKwh = kwhPair(d, 'batteryChargeTotalEnergy');
    m.battDischargeTotalKwh = kwhPair(d, 'batteryDischargeTotalEnergy');
  }
  return m;
}

export function stationReading(inv: Inverter, d: Rec, source = 'soliscloud'): Reading {
  const psum = toWatts(pick(d, 'psum'), pick(d, 'psumStr'));
  const battery = plantHasBattery(d);
  return {
    inverterId: inv.id,
    ts: toEpochSeconds(pick(d, 'dataTimestamp')),
    source,
    acPowerW: toWatts(pick(d, 'power'), pick(d, 'powerStr')),
    dcPowerW: null,
    todayKwh: toKwh(pick(d, 'dayEnergy'), pick(d, 'dayEnergyStr')),
    totalKwh: toKwh(pick(d, 'allEnergy'), pick(d, 'allEnergyStr')),
    batterySoc: battery ? num(pick(d, 'batteryCapacitySoc', 'batteryCapacitySoc2')) : null,
    batteryPowerW: battery ? toWatts(pick(d, 'batteryPower'), pick(d, 'batteryPowerStr')) : null,
    gridPowerW: psum === null ? null : -psum,
    loadPowerW: toWatts(pick(d, 'familyLoadPower'), pick(d, 'familyLoadPowerStr')),
    tempC: null,
    status: mapState(pick(d, 'state')),
    metrics: stationMetrics(d),
    raw: d,
  };
}

/**
 * The vendor device records carry the site's postal address, coordinates and
 * account identifiers. None of that is needed to monitor an inverter, so it is
 * dropped before the payload is stored rather than filtered at render time.
 */
const PII_KEY = /addr|latitude|longitude|iccid|userId|mobile|email|picUrl|position|region|city|county|country/i;

export function stripPii<T>(rec: T): T {
  if (Array.isArray(rec)) return rec.map(stripPii) as unknown as T;
  if (rec && typeof rec === 'object') {
    const out: Rec = {};
    for (const [k, v] of Object.entries(rec as Rec)) {
      if (PII_KEY.test(k)) continue;
      out[k] = stripPii(v);
    }
    return out as unknown as T;
  }
  return rec;
}

/** Epoch ms (number or string, as SolisCloud mixes both) -> epoch seconds. */
function msToSec(v: unknown): number | null {
  const n = num(v);
  return n === null || n === 0 ? null : Math.floor(n / 1000);
}

/** `pow1`…`pow32` are per-MPPT-string DC watts; only report strings that produce. */
function pvStrings(d: Rec): { index: number; powerW: number }[] {
  const out: { index: number; powerW: number }[] = [];
  for (let i = 1; i <= 32; i++) {
    const w = num(pick(d, `pow${i}`));
    if (w !== null && w > 0) out.push({ index: i, powerW: w });
  }
  return out;
}

/** A record from `inverter/listV2` -> Device. */
export function deviceFromInverter(d: Rec, plantId: string | null = null): Device {
  const sn = (pick(d, 'sn', 'inverterSn') as string | null) ?? null;
  return {
    id: `soliscloud:inverter:${sn ?? String(pick(d, 'id') ?? 'unknown')}`,
    provider: 'soliscloud',
    plantId: plantId ?? (pick(d, 'stationId') as string | null) ?? null,
    kind: 'inverter',
    sn,
    name: (pick(d, 'name') as string | null) ?? null,
    model: (pick(d, 'machine', 'inverterSeries', 'productModel') as string | null) ?? null,
    firmware: (pick(d, 'inverterSoftwareVersion') as string | null) ?? null,
    ratedPowerW: toWatts(pick(d, 'power'), pick(d, 'powerStr')),
    status: mapState(pick(d, 'state')),
    signalDbm: null,
    signalPct: null,
    uploadCycleS: null,
    commissionedAt: msToSec(pick(d, 'fisTime', 'fisGenerateTime')),
    warrantyUntil: msToSec(pick(d, 'updateShelfEndTime')),
    lastSeen: msToSec(pick(d, 'dataTimestamp')),
    strings: pvStrings(d),
    raw: stripPii(d),
  };
}

/** A record from `collector/listV2` (the datalogger stick) -> Device. */
export function deviceFromCollector(d: Rec, plantId: string | null = null): Device {
  const sn = (pick(d, 'sn') as string | null) ?? null;
  return {
    id: `soliscloud:datalogger:${sn ?? String(pick(d, 'id') ?? 'unknown')}`,
    provider: 'soliscloud',
    plantId: plantId ?? (pick(d, 'stationId') as string | null) ?? null,
    kind: 'datalogger',
    sn,
    name: (pick(d, 'machine', 'model') as string | null) ?? null,
    model: (pick(d, 'machine') as string | null) ?? (pick(d, 'model') as string | null),
    firmware: (pick(d, 'version') as string | null) ?? null,
    ratedPowerW: null,
    status: mapState(pick(d, 'state')),
    signalDbm: num(pick(d, 'rssi')),
    signalPct: null,
    uploadCycleS: num(pick(d, 'dataUploadCycle')),
    commissionedAt: msToSec(pick(d, 'collectorActiveDate')),
    warrantyUntil: msToSec(pick(d, 'updateShelfEndTime')),
    lastSeen: msToSec(pick(d, 'dataTimestamp')),
    strings: null,
    raw: stripPii(d),
  };
}

export class SolisCloudProvider implements Provider {
  readonly id = 'soliscloud' as const;

  constructor(private readonly creds: SolisCredentials) {}

  async listPlants(): Promise<Plant[]> {
    const data = await call<SolisPage<Rec>>(this.creds, '/v1/api/userStationList', {
      pageNo: 1,
      pageSize: 50,
    });
    return (data.page?.records ?? []).map((r) => ({
      id: String(r.id),
      name: String(pick(r, 'stationName', 'name') ?? r.id),
      capacityW: toWatts(pick(r, 'capacity'), pick(r, 'capacityStr')),
    }));
  }

  async listInverters(plantId: string): Promise<Inverter[]> {
    const data = await call<SolisPage<Rec>>(this.creds, '/v1/api/inverterList', {
      pageNo: 1,
      pageSize: 50,
      stationId: plantId,
    });
    const invs = (data.page?.records ?? []).map((r): Inverter => {
      const vendorId = String(r.id);
      const serial = pick(r, 'sn') as string | null;
      return {
        id: `soliscloud:${vendorId}`,
        provider: 'soliscloud',
        vendorId,
        serial,
        name: String(pick(r, 'name', 'sn') ?? vendorId),
        plantId,
        plantName: String(pick(r, 'stationName') ?? ''),
        capacityW: toWatts(pick(r, 'power'), pick(r, 'powerStr')),
      };
    });
    if (invs.length > 0) return invs;

    // The portal's own inverter list came back empty for a plant that reports
    // inverterCount=1, so treat the plant itself as the unit of monitoring:
    // for a single-inverter plant the station snapshot is the same numbers.
    return [
      {
        id: STATION_PREFIX + plantId,
        provider: 'soliscloud',
        vendorId: plantId,
        serial: null,
        name: '',
        plantId,
        plantName: '',
        capacityW: null,
      },
    ];
  }

  async getReading(inv: Inverter): Promise<Reading | null> {
    if (inv.id.startsWith(STATION_PREFIX)) {
      const d = await call<Rec>(this.creds, '/v1/api/stationDetail', { id: inv.vendorId });
      if (!d) return null;
      if (!inv.name) inv.name = String(pick(d, 'stationName') ?? inv.vendorId);
      if (!inv.serial) inv.serial = (pick(d, 'sno') as string | null) ?? null;
      if (inv.capacityW === null) inv.capacityW = toWatts(pick(d, 'capacity'), pick(d, 'capacityStr'));
      return stationReading(inv, d);
    }

    const d = await call<Rec>(this.creds, '/v1/api/inverterDetail', {
      id: inv.vendorId,
      sn: inv.serial ?? undefined,
    });
    if (!d) return null;

    // psum: the portal draws positive as export, so negate for the SolarLens
    // convention of "+ import / - export". batteryPower: positive = charging.
    const psum = toWatts(pick(d, 'psum'), pick(d, 'psumStr'));

    return {
      inverterId: inv.id,
      ts: toEpochSeconds(pick(d, 'dataTimestamp', 'timeStamp')),
      source: 'soliscloud',
      acPowerW: toWatts(pick(d, 'pac'), pick(d, 'pacStr')),
      dcPowerW: toWatts(pick(d, 'dcPac', 'pow'), pick(d, 'dcPacStr', 'powStr')),
      todayKwh: toKwh(pick(d, 'eToday', 'etoday'), pick(d, 'eTodayStr', 'etodayStr')),
      totalKwh: toKwh(pick(d, 'eTotal', 'etotal'), pick(d, 'eTotalStr', 'etotalStr')),
      batterySoc: num(pick(d, 'batteryCapacitySoc', 'batterySoc')),
      batteryPowerW: toWatts(pick(d, 'batteryPower'), pick(d, 'batteryPowerStr')),
      gridPowerW: psum === null ? null : -psum,
      loadPowerW: toWatts(pick(d, 'familyLoadPower'), pick(d, 'familyLoadPowerStr')),
      tempC: num(pick(d, 'inverterTemperature')),
      status: mapState(pick(d, 'state', 'currentState')),
      raw: d,
    };
  }
}
