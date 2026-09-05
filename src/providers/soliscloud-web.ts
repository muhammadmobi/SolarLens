import type { Inverter, Plant, Provider, Reading } from './types';
import { CallQueue } from './queue';
import { pick, toWatts } from './units';
import { stationReading } from './soliscloud';

/**
 * UNOFFICIAL fallback: drives the SolisCloud *web portal's* own endpoints
 * (`https://www.soliscloud.com/api/...`) with a session token copied from a
 * browser login. Used only while the official API keys are pending (Solis
 * ticket) - the official adapter in soliscloud.ts takes over as soon as
 * SOLIS_KEY_ID is set. Password login is not implemented: the portal's login
 * has a puzzle step, which is a human action by design.
 *
 * Portal tokens have no documented lifetime and there is no refresh grant, so
 * when this route starts failing the fix is to copy a fresh token.
 */
export interface SolisWebCredentials {
  token: string;
  /** Request header the portal expects the token in (observed default: `token`). */
  headerName?: string;
}

const BASE_URL = 'https://www.soliscloud.com';
const queue = new CallQueue(2000);

type Rec = Record<string, unknown>;

interface Envelope<T> {
  success?: boolean;
  code?: string | number;
  msg?: string;
  data?: T;
}

const STATION_PREFIX = 'soliscloud:station:';

export class SolisCloudWebProvider implements Provider {
  readonly id = 'soliscloud' as const;

  constructor(private readonly creds: SolisWebCredentials) {}

  private async call<T>(path: string, payload: unknown): Promise<T> {
    const header = this.creds.headerName?.trim() || 'token';
    return queue.run(async () => {
      const res = await fetch(BASE_URL + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          Accept: 'application/json',
          [header]: this.creds.token,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`soliscloud-web: HTTP ${res.status} on ${path}`);
      const json = (await res.json()) as Envelope<T>;
      const ok = json.success === true || String(json.code) === '0';
      if (!ok || json.data === undefined) {
        // The portal answers a dead session with success=false and a login-ish
        // message rather than a 401 - surface it verbatim so the fix is obvious.
        throw new Error(`soliscloud-web: ${path} -> code=${json.code} msg=${json.msg ?? 'unknown'} (token expired? copy a fresh one)`);
      }
      return json.data;
    });
  }

  private plants = new Map<string, Plant>();

  async listPlants(): Promise<Plant[]> {
    const data = await this.call<{ page?: { records?: Rec[] } }>('/api/station/list', {
      pageNo: 1,
      pageSize: 50,
    });
    const plants = (data.page?.records ?? []).map((r) => ({
      id: String(r.id),
      name: String(pick(r, 'stationName') ?? r.id),
      capacityW: toWatts(pick(r, 'capacity'), pick(r, 'capacityStr')),
    }));
    for (const p of plants) this.plants.set(p.id, p);
    return plants;
  }

  /** The portal's inverter list came back empty for this account, so the plant is the unit. */
  async listInverters(plantId: string): Promise<Inverter[]> {
    const plant = this.plants.get(plantId) ?? { id: plantId, name: '' };
    return [
      {
        id: STATION_PREFIX + plantId,
        provider: 'soliscloud',
        vendorId: plantId,
        serial: null,
        name: plant.name,
        plantId,
        plantName: plant.name,
        capacityW: plant.capacityW ?? null,
      },
    ];
  }

  async getReading(inv: Inverter): Promise<Reading | null> {
    const d = await this.call<Rec>('/api/station/detailMix', { id: inv.vendorId });
    if (!d) return null;
    if (!inv.serial) inv.serial = (pick(d, 'sno') as string | null) ?? null;
    if (!inv.name) inv.name = String(pick(d, 'stationName') ?? inv.vendorId);
    return stationReading(inv, d, 'soliscloud-web');
  }
}
