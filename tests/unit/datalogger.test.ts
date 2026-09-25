/**
 * Everything a datalogger reports, and the history of its link.
 *
 * A datalogger is the part that fails quietly: the inverter keeps producing,
 * the logger stops talking, and the dashboard goes stale with no word as to
 * why. These hold the three things 3.0 adds for it: what each vendor's record
 * says about the logger beyond status and signal, the network handles that are
 * kept for the owner and never published, and a history of status and signal
 * that stays small enough for D1's free tier.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { linkOf, loggerDetail, loggerNetwork } from '../../src/providers/logger';
import { deviceFromCollector } from '../../src/providers/soliscloud';
import { deviceFromRecord } from '../../src/providers/solarman';
import {
  DEVICE_SAMPLES_KEEP_S, deviceSamples, forgetOldDeviceSamples, listDevices, recordDeviceSample, upsertDevice,
  upsertInverter,
} from '../../src/db';
import { createTestD1, type TestD1 } from '../helpers/d1';
import { bearer, createHarness, testInverter } from '../helpers/worker';

describe('how a logger reaches the internet', () => {
  it('is read from the model name both vendors give', () => {
    expect(linkOf('S3-WIFI-ST')).toBe('Wi-Fi');
    expect(linkOf('LSW-3')).toBe('Wi-Fi');
    // SolarMan names a logger by firmware; the LSW-3 stick's newer builds say MW3.
    expect(linkOf('MW3')).toBe('Wi-Fi');
    expect(linkOf('LSE-3')).toBe('Ethernet');
    expect(linkOf('S2-LAN')).toBe('Ethernet');
    expect(linkOf('S3-4G-ST')).toBe('Cellular');
    expect(linkOf('GPRS stick')).toBe('Cellular');
  });

  it('is left unknown rather than guessed', () => {
    expect(linkOf('Datalogger')).toBeNull();
    expect(linkOf(null)).toBeNull();
    expect(linkOf('')).toBeNull();
  });
});

describe('an empty description is no description', () => {
  it('is stored as null, not as an object of nulls', () => {
    expect(loggerDetail({})).toBeNull();
    expect(loggerNetwork({ operator: '  ', mac: null })).toBeNull();
  });
  it('keeps what there is, trimmed', () => {
    expect(loggerNetwork({ mac: ' AA:BB ' })).toEqual({ operator: null, cellArea: null, cellId: null, mac: 'AA:BB' });
  });
});

describe("SolisCloud's collector record", () => {
  // The fields the live record carries beside status and signal. The names and
  // units are real; every value is invented - a working time of 400 days, made
  // and warranted on round dates.
  const WORKING_S = 400 * 86400;
  const record = {
    sn: 'LOG0001SERIAL', machine: 'S3-WIFI-ST', version: '10186', state: 1, rssi: -59, rssiLevel: 3,
    dataUploadCycle: '300', currentWorkingTime: '7502', totalWorkingTime: String(WORKING_S), runingTime: String(WORKING_S),
    factoryTime: '1690000000', collectorActiveDate: 1700000000000, shelfEndTime: 1780000000000,
    connectionOperator: 'Operator', lac: 'A1', ci: 'B2',
  };

  it('describes the logger: link, signal bars, time since restart and in total, and when it was made', () => {
    const d = deviceFromCollector(record, 'p1');
    expect(d.logger).toEqual({ link: 'Wi-Fi', signalLevel: 3, uptimeS: 7502, workingS: WORKING_S, manufacturedAt: 1690000000 });
  });

  it('keeps the operator and the mast apart, for the owner', () => {
    expect(deviceFromCollector(record, 'p1').network).toEqual({ operator: 'Operator', cellArea: 'A1', cellId: 'B2', mac: null });
  });

  it('falls back to the original warranty when there is no extended one', () => {
    expect(deviceFromCollector(record, 'p1').warrantyUntil).toBe(1780000000);
    expect(deviceFromCollector({ ...record, updateShelfEndTime: 1800000000000 }, 'p1').warrantyUntil).toBe(1800000000);
  });

  it('reads a factory time sent in milliseconds, and ignores a zero one', () => {
    expect(deviceFromCollector({ ...record, factoryTime: 1690000000000 }, 'p1').logger?.manufacturedAt).toBe(1690000000);
    expect(deviceFromCollector({ ...record, factoryTime: 0 }, 'p1').logger?.manufacturedAt).toBeNull();
  });
});

describe("SolarMan's device list", () => {
  const collector = {
    deviceSn: 'LOG2', deviceType: 'COLLECTOR', deviceStatus: 1, signalIntensity: 84,
    featureData: JSON.stringify({ MDUv1: 'MW3_15U_5406_1.20', MDU_MAC_ADD1: 'AA:BB:CC:DD:EE:FF' }),
  };

  it('gives a logger its link, and keeps its MAC address for the owner', () => {
    const d = deviceFromRecord(collector, 'p2');
    expect(d.logger?.link).toBe('Wi-Fi');
    expect(d.network?.mac).toBe('AA:BB:CC:DD:EE:FF');
  });

  it('describes no inverter as a logger', () => {
    const d = deviceFromRecord({ ...collector, deviceType: 'INVERTER' }, 'p2');
    expect(d.logger).toBeNull();
    expect(d.network).toBeNull();
  });
});

describe('link history', () => {
  let d1: TestD1;
  afterEach(() => d1?.close());

  const logger = (over: Record<string, unknown> = {}) => ({
    ...deviceFromCollector({ sn: 'LOG0001SERIAL', machine: 'S3-WIFI-ST', state: 1, rssi: -60 }, 'p1'),
    ...over,
  });
  const rows = () => d1.raw.prepare('SELECT ts, status, signal_dbm FROM device_samples ORDER BY ts').all() as {
    ts: number; status: string; signal_dbm: number;
  }[];

  it('writes a row the first time a device is seen', async () => {
    d1 = createTestD1();
    await upsertDevice(d1.db, logger(), 1000);
    expect(rows()).toEqual([{ ts: 1000, status: 'online', signal_dbm: -60 }]);
  });

  it('writes nothing more while nothing moves, then one row an hour', async () => {
    d1 = createTestD1();
    for (let t = 0; t <= 3600; t += 300) await upsertDevice(d1.db, logger(), 1000 + t);
    // Thirteen passes over an hour: the first, and the one an hour later.
    expect(rows().map((r) => r.ts)).toEqual([1000, 4600]);
  });

  it('writes a row the moment the status changes, and again when it changes back', async () => {
    d1 = createTestD1();
    await upsertDevice(d1.db, logger(), 1000);
    await upsertDevice(d1.db, logger({ status: 'offline' }), 1300);
    await upsertDevice(d1.db, logger({ status: 'offline' }), 1600);
    await upsertDevice(d1.db, logger({ status: 'online' }), 1900);
    expect(rows().map((r) => [r.ts, r.status])).toEqual([[1000, 'online'], [1300, 'offline'], [1900, 'online']]);
  });

  it('ignores the few dBm a signal jitters by, and records a real change', async () => {
    d1 = createTestD1();
    await upsertDevice(d1.db, logger({ signalDbm: -60 }), 1000);
    await upsertDevice(d1.db, logger({ signalDbm: -62 }), 1300);
    await upsertDevice(d1.db, logger({ signalDbm: -70 }), 1600);
    expect(rows().map((r) => r.signal_dbm)).toEqual([-60, -70]);
  });

  it("does the same for SolarMan's percentage, at five points", async () => {
    d1 = createTestD1();
    const pct = (p: number) => ({ ...deviceFromRecord({ deviceSn: 'L2', deviceType: 'COLLECTOR', deviceStatus: 1, signalIntensity: p }, 'p2') });
    await upsertDevice(d1.db, pct(84), 1000);
    await upsertDevice(d1.db, pct(80), 1300);
    await upsertDevice(d1.db, pct(70), 1600);
    const got = d1.raw.prepare('SELECT signal_pct FROM device_samples ORDER BY ts').all() as { signal_pct: number }[];
    expect(got.map((r) => r.signal_pct)).toEqual([84, 70]);
  });

  it('records the merged row, so a push that carries no status keeps the one before', async () => {
    d1 = createTestD1();
    await upsertDevice(d1.db, logger(), 1000);
    await upsertDevice(d1.db, logger({ status: null, signalDbm: null }), 5000);
    expect(rows().map((r) => r.status)).toEqual(['online', 'online']);
  });

  it('writes nothing for a device that is not stored', async () => {
    d1 = createTestD1();
    await recordDeviceSample(d1.db, 'soliscloud:datalogger:missing', 1000);
    expect(rows()).toEqual([]);
  });

  it('hands back the window, and the last row before it, oldest first', async () => {
    d1 = createTestD1();
    await upsertDevice(d1.db, logger(), 1000);
    await upsertDevice(d1.db, logger({ status: 'offline' }), 2000);
    await upsertDevice(d1.db, logger({ status: 'online' }), 9000);
    const got = await deviceSamples(d1.db, 5000);
    // 2000 opens the window: the logger was offline when it began.
    expect(got.map((r) => [r.ts, r.status])).toEqual([[2000, 'offline'], [9000, 'online']]);
  });

  it('forgets rows older than the keep window, and only those', async () => {
    d1 = createTestD1();
    const now = 10 * DEVICE_SAMPLES_KEEP_S;
    await upsertDevice(d1.db, logger(), now - DEVICE_SAMPLES_KEEP_S - 10);
    await upsertDevice(d1.db, logger({ status: 'offline' }), now - 10);
    await forgetOldDeviceSamples(d1.db, now);
    expect(rows().map((r) => r.ts)).toEqual([now - 10]);
  });

  it('keeps the logger description and the network across a push that omits them', async () => {
    d1 = createTestD1();
    await upsertDevice(d1.db, deviceFromCollector({ sn: 'L1', machine: 'S3-WIFI-ST', rssiLevel: 2, lac: 'A', ci: 'B' }, 'p1'), 1000);
    await upsertDevice(d1.db, { ...logger({ id: 'soliscloud:datalogger:L1' }), logger: null, network: null }, 2000);
    const [row] = await listDevices(d1.db);
    expect(JSON.parse(String(row.logger)).signalLevel).toBe(2);
    expect(JSON.parse(String(row.network)).cellId).toBe('B');
  });
});

describe('GET /api/devices and /api/devices/history', () => {
  const post = (body: unknown) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...bearer('ingest-token-for-tests') },
    body: JSON.stringify(body),
  });

  async function withLogger() {
    const h = createHarness();
    await upsertInverter(h.env.DB, testInverter({ id: 'soliscloud:station:p1', provider: 'soliscloud', plantId: 'p1', vendorId: 'p1' }) as never);
    await h.fetch('/api/ingest/devices', post({
      provider: 'soliscloud', plantId: 'p1',
      collectors: [{ sn: 'LOG0001SERIAL', machine: 'S3-WIFI-ST', state: 1, rssi: -63, rssiLevel: 3, connectionOperator: 'Operator', lac: 'AREA1', ci: 'CELL1' }],
    }));
    return h;
  }

  it('publishes the logger description, and never its network handles', async () => {
    const h = await withLogger();
    const text = await (await h.fetch('/api/devices')).text();
    const [dev] = (JSON.parse(text) as { devices: Record<string, unknown>[] }).devices;
    expect(JSON.parse(String(dev.logger)).link).toBe('Wi-Fi');
    expect(dev).not.toHaveProperty('network');
    for (const secret of ['Operator', 'AREA1', 'CELL1', 'LOG0001SERIAL']) expect(text).not.toContain(secret);
    h.close();
  });

  it('serves the history under the same public name the device has', async () => {
    const h = await withLogger();
    const devices = (await (await h.fetch('/api/devices')).json()) as { devices: { id: string }[] };
    const body = (await (await h.fetch('/api/devices/history')).json()) as { days: number; samples: { device_id: string; status: string }[] };
    expect(body.days).toBe(7);
    expect(body.samples).toHaveLength(1);
    expect(body.samples[0].device_id).toBe(devices.devices[0].id);
    expect(body.samples[0].device_id).toBe('s1-datalogger-1');
    expect(JSON.stringify(body)).not.toContain('LOG0001SERIAL');
    h.close();
  });

  it('holds the window to between one day and thirty, and reads nonsense as the default', async () => {
    const h = await withLogger();
    const days = async (q: string) => ((await (await h.fetch(`/api/devices/history?days=${q}`)).json()) as { days: number }).days;
    expect(await days('0')).toBe(1);
    expect(await days('90')).toBe(30);
    expect(await days('abc')).toBe(7);
    h.close();
  });

  it('is pruned by the cron', async () => {
    const h = await withLogger();
    h.d1.raw.prepare('INSERT INTO device_samples (device_id, ts, status) VALUES (?, ?, ?)').run('soliscloud:datalogger:LOG0001SERIAL', 1, 'online');
    await h.cron();
    const left = h.d1.raw.prepare('SELECT COUNT(*) AS n FROM device_samples WHERE ts = 1').get() as { n: number };
    expect(left.n).toBe(0);
    h.close();
  });
});
