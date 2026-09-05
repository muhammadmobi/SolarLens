import type { Inverter, Plant, Provider, Reading } from './types';
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
    return (data.page?.records ?? []).map((r) => {
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
  }

  async getReading(inv: Inverter): Promise<Reading | null> {
    const d = await call<Rec>(this.creds, '/v1/api/inverterDetail', {
      id: inv.vendorId,
      sn: inv.serial ?? undefined,
    });
    if (!d) return null;

    // Sign conventions to confirm against the SolisCloud app on first real data:
    //   psum         - grid; the app draws positive as export, so negate to get
    //                  the SolarLens convention of "+ import / - export".
    //   batteryPower - positive while charging, which is already our convention.
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
