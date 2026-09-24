/**
 * The two paths that turn a vendor's reply into a reading: SolisCloud's
 * inverter page, and SolarMan's per-device registers on top of its station
 * snapshot. Both existed untested, and both are where a sign convention or a
 * missing register becomes a wrong number on the dashboard rather than an
 * error anybody sees.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { SolisCloudProvider, queue as solisQueue } from '../../src/providers/soliscloud';
import { SolarmanProvider, queue as solarmanQueue, type TokenStore } from '../../src/providers/solarman';

const realDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);

/** SolisCloud signs with MD5, which only the Workers runtime offers WebCrypto. */
function installMd5Shim() {
  vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation(
    async (algo: AlgorithmIdentifier, data: BufferSource) => {
      const name = typeof algo === 'string' ? algo : algo.name;
      if (name.toUpperCase() !== 'MD5') return realDigest(algo, data);
      const buf = Buffer.from(crypto.createHash('md5').update(Buffer.from(data as ArrayBuffer)).digest());
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    },
  );
}

/** Replace fetch with one that answers from a table of URL fragments, and records each call. */
function stubFetch(routes: Array<[string, unknown]>) {
  const calls: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const hit = routes.find(([frag]) => url.includes(frag));
    if (!hit) throw new Error('unstubbed request: ' + url);
    return new Response(JSON.stringify(hit[1]), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

/** A token store in memory, already holding a valid SolarMan token. */
function memoryTokens(): TokenStore {
  const shelf = new Map<string, { accessToken: string; expiresAt: number }>([
    ['solarman', { accessToken: 'access', expiresAt: Math.floor(Date.now() / 1000) + 3600 }],
  ]);
  return {
    async get(p) { return shelf.get(p) ?? null; },
    async set(p, accessToken, expiresAt) { shelf.set(p, { accessToken, expiresAt }); },
  };
}

beforeEach(() => { solisQueue.minGapMs = 0; solarmanQueue.minGapMs = 0; installMd5Shim(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const solisCreds = { keyId: 'key-id', keySecret: 'key-secret' };

describe('SolisCloud: a reading from the inverter page', () => {
  const inverter = {
    id: 'soliscloud:inv-1', provider: 'soliscloud' as const, vendorId: 'inv-1', serial: 'SN1',
    name: 'Inverter', plantId: 'plant-1', plantName: 'Plant', capacityW: 12_000,
  };

  it('reads power, energy and temperature, and negates the portal\'s grid sign', async () => {
    stubFetch([['/v1/api/inverterDetail', {
      success: true,
      data: {
        dataTimestamp: '1700000000000',
        pac: 8.47, pacStr: 'kW',
        dcPac: 8.9, dcPacStr: 'kW',
        eToday: 34.1, eTodayStr: 'kWh',
        eTotal: 12.5, eTotalStr: 'MWh',
        // The portal draws export as positive; SolarLens says import is positive.
        psum: 2.5, psumStr: 'kW',
        familyLoadPower: 1.2, familyLoadPowerStr: 'kW',
        inverterTemperature: 41.5,
        state: 1,
      },
    }]]);

    const reading = await new SolisCloudProvider(solisCreds).getReading(inverter);
    expect(reading).toMatchObject({
      inverterId: 'soliscloud:inv-1',
      source: 'soliscloud',
      acPowerW: 8470,
      dcPowerW: 8900,
      todayKwh: 34.1,
      totalKwh: 12_500,
      gridPowerW: -2500,
      loadPowerW: 1200,
      tempC: 41.5,
    });
    expect(reading?.ts).toBe(1_700_000_000);
  });

  it('leaves a figure the vendor did not send as null rather than zero', async () => {
    stubFetch([['/v1/api/inverterDetail', { success: true, data: { pac: 1, pacStr: 'kW' } }]]);
    const reading = await new SolisCloudProvider(solisCreds).getReading(inverter);
    expect(reading).toMatchObject({ acPowerW: 1000, gridPowerW: null, batterySoc: null, tempC: null });
  });

  it('returns nothing when the page itself is empty', async () => {
    stubFetch([['/v1/api/inverterDetail', { success: true, data: null }]]);
    expect(await new SolisCloudProvider(solisCreds).getReading(inverter)).toBeNull();
  });

  it('fills in a plant-level unit\'s name, serial and nameplate from the station page', async () => {
    stubFetch([['/v1/api/stationDetail', {
      success: true,
      data: { stationName: 'Ongrid Plant', sno: 'STATIONSN', capacity: 12, capacityStr: 'kWp', power: 3.2, powerStr: 'kW' },
    }]]);
    const station = { ...inverter, id: 'soliscloud:station:plant-1', vendorId: 'plant-1', name: '', serial: null, capacityW: null };
    const reading = await new SolisCloudProvider(solisCreds).getReading(station);
    expect(reading).toMatchObject({ acPowerW: 3200 });
    expect(station.name).toBe('Ongrid Plant');
    expect(station.serial).toBe('STATIONSN');
    expect(station.capacityW).toBe(12_000);
  });
});

describe('SolarMan: registers on top of the station snapshot', () => {
  const realTime = {
    success: true, code: '0',
    lastUpdateTime: 1_700_000_000,
    generationPower: 1500, usePower: 900, gridPower: -600, batteryPower: 200, batterySoc: 75,
  };

  const inverter = {
    id: 'solarman:INV1', provider: 'solarman' as const, vendorId: 'INV1', serial: 'INV1',
    name: 'Inverter', plantId: '62000000', plantName: 'Plant', capacityW: 3500,
  };

  it('prefers the device\'s own registers, and keeps the station\'s splits', async () => {
    stubFetch([
      ['/station/v1.0/realTime', realTime],
      ['/device/v1.0/currentData', {
        success: true, code: '0',
        collectionTime: 1_700_000_300,
        dataList: [
          { key: 'APo_t1', value: '1620', unit: 'W' },
          { key: 'DPi_t1', value: '1.71', unit: 'kW' },
          { key: 'Etdy_ge1', value: '5.4', unit: 'kWh' },
          { key: 'Et_ge0', value: '9.1', unit: 'MWh' },
          { key: 'B_left_cap1', value: '77', unit: '%' },
          { key: 'AC_RDT_T1', value: '38.5', unit: '°C' },
          { key: 'INV_ST1', value: 'Generating' },
        ],
      }],
    ]);

    const reading = await new SolarmanProvider(
      { appId: 'a', appSecret: 'b', email: 'c', passwordSha256: 'd' }, memoryTokens(),
    ).getReading(inverter);

    expect(reading).toMatchObject({
      ts: 1_700_000_300,       // the device's own collection time, not the station's
      acPowerW: 1620,
      dcPowerW: 1710,
      todayKwh: 5.4,
      totalKwh: 9100,
      batterySoc: 77,
      tempC: 38.5,
      status: 'Generating',
      // From the station, where the sign is unambiguous. SolarMan draws import
      // as negative; SolarLens stores import as positive, so this flips.
      gridPowerW: 600,
    });
  });

  it('falls back to the station\'s figures for a register the device omits', async () => {
    stubFetch([
      ['/station/v1.0/realTime', realTime],
      ['/device/v1.0/currentData', { success: true, code: '0', dataList: [{ key: 'APo_t1', value: '1620', unit: 'W' }] }],
    ]);
    const reading = await new SolarmanProvider(
      { appId: 'a', appSecret: 'b', email: 'c', passwordSha256: 'd' }, memoryTokens(),
    ).getReading(inverter);
    expect(reading).toMatchObject({ acPowerW: 1620, batterySoc: 75 });
  });

  it('ignores a register present but empty, rather than reading it as zero', async () => {
    stubFetch([
      ['/station/v1.0/realTime', realTime],
      ['/device/v1.0/currentData', {
        success: true, code: '0',
        dataList: [{ key: 'B_left_cap1', value: '' }, { key: 'AC_RDT_T1', value: null }],
      }],
    ]);
    const reading = await new SolarmanProvider(
      { appId: 'a', appSecret: 'b', email: 'c', passwordSha256: 'd' }, memoryTokens(),
    ).getReading(inverter);
    expect(reading).toMatchObject({ batterySoc: 75 });   // the station's, not 0
  });

  it('asks only the station when the unit is the station itself', async () => {
    const calls = stubFetch([['/station/v1.0/realTime', realTime]]);
    const station = { ...inverter, id: 'solarman:station:62000000', vendorId: '62000000', serial: null };
    const reading = await new SolarmanProvider(
      { appId: 'a', appSecret: 'b', email: 'c', passwordSha256: 'd' }, memoryTokens(),
    ).getReading(station);
    expect(reading).toMatchObject({ acPowerW: 1500 });
    expect(calls.some((c) => c.url.includes('currentData'))).toBe(false);
  });
});
