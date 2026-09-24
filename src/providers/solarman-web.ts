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
import type { Device, Inverter, Plant, Provider, Reading } from './types';
import { CallQueue } from './queue';
import { num, offsetOfZoneAt, pick, toWatts, tzNameOf, tzOffsetSec } from './units';
import { STATION_PREFIX, deviceFromRecord, deviceFromV3Detail, stationInverter, stationReading, type TokenStore } from './solarman';
import { solarmanAdvice, solarmanAlert, solarmanOccurrences, solarmanPeriods, type Alarm, type Period } from './events';

export interface SolarmanWebCredentials {
  refreshToken: string;
  /** Optional seed; otherwise the first poll refreshes straight away. */
  accessToken?: string;
}

const BASE_URL = 'https://home.solarmanpv.com';
const TOKEN_KEY = 'solarman-web';
const REFRESH_KEY = 'solarman-web-refresh';

export const queue = new CallQueue(1500);

/** How many of the newest alerts are asked for their detail and timeline each hour. */
const DETAILED_ALERTS = 5;

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

  /** Every plant the portal account can see, remembered for its zone and name. */
  async listPlants(): Promise<Plant[]> {
    const json = await this.call<{ data?: Rec[] }>('POST', '/maintain-s/operating/station/search', {});
    const plants = (json.data ?? []).map((s) => ({
      id: String(s.id),
      name: String(pick(s, 'name', 'stationName') ?? `Station ${s.id}`),
      capacityW: toWatts(pick(s, 'installedCapacity'), 'kW'),
      tzOffsetSec: tzOffsetSec(s),
      tzName: tzNameOf(s),
    }));
    for (const p of plants) this.plants.set(p.id, p);
    return plants;
  }

  /**
   * The portal treats the plant as the unit: one Inverter standing for the
   * station, whose readings come from the station snapshot below.
   */
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

    // device-list only summarises. The inverter's own page carries per-string
    // DC, per-phase AC, BMS and temperatures, so fetch it per inverter and let
    // the upsert merge the two views of the same device.
    for (const d of out.filter((x) => x.kind === 'inverter')) {
      const deviceId = (d.raw as Record<string, unknown> | null)?.deviceId;
      if (deviceId === undefined || deviceId === null) continue;
      try {
        const detail = await this.call<Rec>('POST', '/device-s/device/v3/detail', {
          deviceId, siteId: Number(plantId), language: 'en', needRealTimeDataFlag: true,
        });
        if (detail) out.push(deviceFromV3Detail(detail, plantId));
      } catch { /* detail is a bonus; the list already carries the essentials */ }
    }
    return out;
  }

  /**
   * The plant's alert list, newest first: the same call the portal's Alert page
   * makes. A hundred covers far more than an owner's plant raises between two
   * hourly reads, and alerts already stored are updated rather than duplicated.
   *
   * The list names a fault and the day it was raised, and nothing else. The
   * newest few are then asked the two questions the portal's own detail panel
   * asks - what SolarMan advises, and when on that day the fault was active -
   * which gives each occurrence an end, and the history the occurrences the list
   * folds away. Only the newest few, because each costs two vendor calls and the
   * hourly run shares its request budget with everything else; an alert gets
   * its turn while it is among the newest, which is while it can still change.
   * If either call fails, the alert is stored as the list gave it.
   */
  async listAlarms(plantId: string, nowTs = Math.floor(Date.now() / 1000)): Promise<Alarm[]> {
    const json = await this.call<{ data?: Rec[] }>(
      'POST',
      '/maintain-s/operating/alert/search?order.direction=DESC&order.property=alertTime&page=1&size=100',
      { deviceType: '', language: 'en', level: '', startTime: '', levelList: null, plantId: Number(plantId) },
    );
    // Advice is per rule, so it is asked once per device and rule; the results
    // are keyed by alarm id, so an occurrence the list and a timeline both
    // produce is stored once.
    const advice = new Map<string, string | null>();
    const out = new Map<string, Alarm>();
    let asked = 0;
    for (const rec of json.data ?? []) {
      const listed = solarmanAlert(plantId, rec);
      if (!listed) continue;
      // Past the newest few, or with nothing to ask the detail calls about,
      // the alert is kept as the list gave it.
      if (asked >= DETAILED_ALERTS || rec.deviceId == null || rec.ruleId == null) {
        if (!out.has(listed.id)) out.set(listed.id, listed);
        continue;
      }
      asked++;
      try {
        const rule = `${rec.deviceId}|${rec.ruleId}`;
        if (!advice.has(rule)) {
          const detail = await this.call<Rec>('POST', '/maintain-s/operating/alert/detail',
            { deviceId: rec.deviceId, ruleId: rec.ruleId, language: 'en' });
          advice.set(rule, solarmanAdvice(detail));
        }
        // The timeline is asked for one day, in the plant's own calendar: work
        // out the plant-local day the alert fell on, and when that day ends.
        const zone = typeof rec.timezone === 'string' ? rec.timezone : null;
        const offset = (zone ? offsetOfZoneAt(zone, listed.beginTs) : null) ?? this.plants.get(plantId)?.tzOffsetSec ?? 0;
        const dayStart = Math.floor((listed.beginTs + offset) / 86400) * 86400 - offset;
        const alertDay = new Date((dayStart + offset) * 1000).toISOString().slice(0, 10).replace(/-/g, '');
        const points = await this.call<unknown>('POST', '/maintain-s/operating/alert/timeline',
          { deviceId: rec.deviceId, ruleId: rec.ruleId, alertDay });
        for (const a of solarmanOccurrences(plantId, rec, points, advice.get(rule) ?? null, dayStart + 86400, nowTs)) {
          out.set(a.id, a);
        }
      } catch {
        if (!out.has(listed.id)) out.set(listed.id, listed);
      }
    }
    return [...out.values()];
  }

  /**
   * The plant's own totals: one row per day for a month, or per month for a
   * year. SolarMan files these under the battery, but they cover the whole
   * system - generation, consumption, both directions of grid and the battery.
   */
  async listPeriods(plantId: string, year: number, month?: number): Promise<Period[]> {
    const path = month
      ? `/maintain-s/history/batteryPower/${plantId}/stats/month?year=${year}&month=${month}`
      : `/maintain-s/history/batteryPower/${plantId}/stats/year?year=${year}`;
    const json = await this.call<{ records?: Rec[] }>('GET', path);
    return solarmanPeriods(plantId, month ? 'month' : 'year', year, json.records ?? []);
  }

  /** The station's newest snapshot as a Reading. */
  async getReading(inv: Inverter): Promise<Reading | null> {
    if (!inv.id.startsWith(STATION_PREFIX)) return null;
    // operating/system is the richest single snapshot: live power + battery +
    // today/month/year/total energy in one call (fast/system lacks month/year).
    const s = await this.call<Rec>('GET', `/maintain-s/operating/system/${inv.plantId}`);
    return s ? stationReading(inv, s, 'solarman-web') : null;
  }
}
