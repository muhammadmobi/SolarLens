import { describe, expect, it } from 'vitest';
import { aliasFor, maskSerial, publicDevices, publicInverters, publicRows, publicAlarms, safeTelemetry, vendorSignals } from '../../src/public-view';

/**
 * The dashboard is served to anyone with the link, so these functions are the
 * only thing standing between a vendor account identifier and the open
 * internet. The tests below check both directions: that nothing identifying
 * survives, and that the dashboard still gets the keys it joins on.
 */
describe('aliasFor', () => {
  const ids = ['solarman:station:62000000', 'soliscloud:station:1000000000000000001'];

  it('gives a stable positional alias, not the id', () => {
    const alias = aliasFor(ids);
    expect(alias('solarman:station:62000000')).toBe('s1');
    expect(alias('soliscloud:station:1000000000000000001')).toBe('s2');
  });

  it('does not depend on the order the ids arrive in', () => {
    expect(aliasFor(ids)('solarman:station:62000000'))
      .toBe(aliasFor([...ids].reverse())('solarman:station:62000000'));
  });

  it('maps the bare vendor id to the same alias as the full one', () => {
    // The inverters table holds "solarman:station:62000000"; the devices table
    // holds "62000000" in plant_id, and the dashboard joins one to the other.
    const alias = aliasFor(ids);
    expect(alias('62000000')).toBe(alias('solarman:station:62000000'));
  });

  it('refuses to echo an id it has never seen', () => {
    expect(aliasFor(ids)('solarman:station:99999999')).toBe('unknown');
  });

  it('passes null through', () => {
    expect(aliasFor(ids)(null)).toBeNull();
  });
});

describe('maskSerial', () => {
  it('keeps the last four so two units can be told apart', () => {
    expect(maskSerial('1234567890ABCD')).toBe('••••ABCD');
  });

  it('hides a short serial entirely rather than revealing all of it', () => {
    expect(maskSerial('ABC')).toBe('••••');
  });

  it('passes null and empty through', () => {
    expect(maskSerial(null)).toBeNull();
    expect(maskSerial('')).toBeNull();
  });
});

describe('publicInverters', () => {
  const alias = aliasFor(['solarman:station:62000000']);
  const row = {
    id: 'solarman:station:62000000',
    provider: 'solarman',
    vendor_id: '62000000',
    plant_id: '62000000',
    plant_name: 'Demo Plant',
    serial: 'SN1234567890',
    name: 'Demo Plant',
    capacity_w: 3500,
    ac_power_w: 1200,
    raw: { latitude: '51.4779', ownerEmail: 'someone@example.com' },
  };

  it('publishes no vendor identifier and no raw payload', () => {
    const [out] = publicInverters([row], alias) as Record<string, unknown>[];
    expect(out.vendor_id).toBeUndefined();
    expect(out.plant_id).toBeUndefined();
    expect(out.raw).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('62000000');
    expect(JSON.stringify(out)).not.toContain('SN1234567890');
  });

  it('still publishes what the dashboard draws', () => {
    const [out] = publicInverters([row], alias) as Record<string, unknown>[];
    expect(out.id).toBe('s1');
    expect(out.ac_power_w).toBe(1200);
    expect(out.capacity_w).toBe(3500);
    expect(out.name).toBe('Demo Plant');
  });
});

describe('publicDevices', () => {
  const alias = aliasFor(['solarman:station:62000000']);
  const row = {
    id: 'solarman:device:9911',
    provider: 'solarman',
    plant_id: '62000000',
    kind: 'inverter',
    sn: 'INV9876543210',
    model: 'S5-GR3P10K',
    status: 'online',
    raw: { addr: '1 Example Street' },
  };

  it('hides the serial, the plant id and the raw payload', () => {
    const [out] = publicDevices([row], alias) as Record<string, unknown>[];
    expect(out.raw).toBeUndefined();
    expect(out.sn).toBe('••••3210');
    expect(JSON.stringify(out)).not.toContain('62000000');
    expect(JSON.stringify(out)).not.toContain('INV9876543210');
    expect(JSON.stringify(out)).not.toContain('Example Street');
  });

  it('keeps the join key pointing at the same system as the inverter', () => {
    const [out] = publicDevices([row], alias) as Record<string, unknown>[];
    const [inv] = publicInverters([{ id: 'solarman:station:62000000' }], alias) as Record<string, unknown>[];
    expect(out.plant_id).toBe(inv.id);
  });

  it('keeps the model and status the Devices tab shows', () => {
    const [out] = publicDevices([row], alias) as Record<string, unknown>[];
    expect(out.model).toBe('S5-GR3P10K');
    expect(out.status).toBe('online');
  });
});

describe('publicRows', () => {
  it('renames the inverter but leaves the measurements alone', () => {
    const alias = aliasFor(['soliscloud:station:1000000000000000001']);
    const out = publicRows(
      [{ inverter_id: 'soliscloud:station:1000000000000000001', ts: 1788944452, ac_power_w: 4200 }],
      alias,
    );
    expect(out[0].inverter_id).toBe('s1');
    expect(out[0].ac_power_w).toBe(4200);
    expect(JSON.stringify(out)).not.toContain('1000000000000000001');
  });
});

describe('publicAlarms', () => {
  const rows = [{
    id: 'soliscloud:1000000000000000001:1015:1784359680', inverter_id: 'soliscloud:station:1000000000000000001',
    code: '1015', message: 'NO-Grid', begin_ts: 1784359680,
  }];

  it('never lets the alarm id out, because it spells the plant id', () => {
    const out = publicAlarms(rows, aliasFor(['soliscloud:station:1000000000000000001']));
    expect(JSON.stringify(out)).not.toContain('1000000000000000001');
    expect(out[0]).not.toHaveProperty('id');
  });

  it('names the system by alias and keeps the fault itself', () => {
    const [a] = publicAlarms(rows, aliasFor(['soliscloud:station:1000000000000000001']));
    expect(a).toEqual({ inverter_id: 's1', code: '1015', message: 'NO-Grid', begin_ts: 1784359680 });
  });
});

/**
 * The payload's alert fields, as named columns. The dashboard's alerts read
 * these; until 3.0 they read the raw payload, which was never sent.
 */
describe('vendorSignals', () => {
  it("reads SolisCloud's alarm counter and level, from stored JSON text", () => {
    const s = vendorSignals(JSON.stringify({ alarmCount: '2', alarmLevel: 1 }));
    expect(s.alarm_count).toBe(2);
    expect(s.alarm_level).toBe(1);
  });

  it("keeps SolisCloud's zero apart from a vendor that sends no counter", () => {
    expect(vendorSignals({ alarmCount: 0 }).alarm_count).toBe(0);
    expect(vendorSignals({ generationPower: 278 }).alarm_count).toBeNull();
    expect(vendorSignals({ alarmCount: '' }).alarm_count).toBeNull();
    expect(vendorSignals({ alarmCount: 'n/a' }).alarm_count).toBeNull();
  });

  it("reads SolarMan's flags and datalogger link as they are sent", () => {
    const s = vendorSignals({
      warningStatus: 'ABNORMAL', businessWarningStatus: 'NORMAL',
      consumerWarningStatus: 'NORMAL', networkStatus: 'OFFLINE',
    });
    expect(s).toMatchObject({
      warning_status: 'ABNORMAL', business_warning_status: 'NORMAL',
      consumer_warning_status: 'NORMAL', network_status: 'OFFLINE',
    });
  });

  it('refuses anything that is not a short status word', () => {
    expect(vendorSignals({ warningStatus: 'x'.repeat(33) }).warning_status).toBeNull();
    expect(vendorSignals({ warningStatus: { nested: 1 } }).warning_status).toBeNull();
    expect(vendorSignals({ warningStatus: '  ' }).warning_status).toBeNull();
  });

  it('answers all nulls for a missing or unreadable payload', () => {
    for (const raw of [null, undefined, '', 'not json', '[1,2]', 42]) {
      expect(Object.values(vendorSignals(raw)).every((v) => v === null), String(raw)).toBe(true);
    }
  });
});

/**
 * The payload as a table of measurements. Built by allowing rather than
 * stripping, so an identifier under a name nobody has seen yet is still left
 * out - these cases are the spellings the two vendors use today, and the
 * shapes a new one would most likely take.
 */
describe('safeTelemetry', () => {
  const table = (raw: unknown) => JSON.parse(safeTelemetry(raw) ?? '{}') as Record<string, unknown>;

  it('keeps measurements, units, status words and booleans', () => {
    const t = table({ power: 5.08, powerStr: 'kW', state: 1, batteryStatus: 'STATIC', online: true, temperature: null });
    expect(t).toEqual({ power: 5.08, powerStr: 'kW', state: 1, batteryStatus: 'STATIC', online: true, temperature: null });
  });

  it('drops ids and serials in every spelling the vendors use', () => {
    const t = table({
      id: '1000000000000000001', sno: 'DEMO01', systemId: 1234, stationId: 5, deviceSn: 'X', collectorSn: 'Y',
      inverterSN: 'Z', serialNumber: 'Q', inverterNo: 'R', inverterId: 7, id_code: 1, deviceIds: '1,2',
      power: 1,
    });
    expect(t).toEqual({ power: 1 });
  });

  it('keeps words that only look like ids', () => {
    // "idle" starts with "id", "snapshot" with "sn"; neither is an identifier.
    expect(table({ idle: 0, snapshotPower: 12 })).toEqual({ idle: 0, snapshotPower: 12 });
  });

  it('drops names, people, places, network handles and links', () => {
    const t = table({
      stationName: 'Home', userName: 'u', ownerEmail: 'e', phone: 'p', addr: 'a', latitude: 1, lng: 2,
      cityStr: 'c', countryName: 'x', regionCode: 'r', mac: 'm', ip: '10.0.0.1', ssid: 's', imei: 'i',
      iccid: 'c', picUrl: 'u', token: 't', password: 'p', energy: 3,
    });
    expect(t).toEqual({ energy: 3 });
  });

  it('drops a long run of digits unless the name says it is a time or an energy total', () => {
    // Built rather than written out, so no id-shaped literal sits in the repo.
    const idLike = 7 * 10 ** 7 + 1;
    const epoch = 1.7e9;
    const t = table({
      belongsTo: idLike, plantRef: String(idLike),
      lastUpdateTime: epoch, dataTimestamp: String(epoch * 1000), generationTotal: 12_345_678, power: 123456,
    });
    expect(t).toEqual({ lastUpdateTime: epoch, dataTimestamp: String(epoch * 1000), generationTotal: 12_345_678, power: 123456 });
  });

  it('drops long strings, addresses, links, nested objects and private keys', () => {
    const t = table({
      note: 'x'.repeat(41), contact: 'someone@example.com', site: 'https://example.com', web: 'www.example.com',
      nested: { a: 1 }, list: [1, 2], _internal: 1, nan: Number.NaN, kept: 'ok',
    });
    expect(t).toEqual({ kept: 'ok' });
  });

  it('answers null when nothing survives, or there was nothing to read', () => {
    expect(safeTelemetry({ id: 1, sno: 'x' })).toBeNull();
    expect(safeTelemetry(null)).toBeNull();
    expect(safeTelemetry('not json')).toBeNull();
    expect(safeTelemetry([1, 2])).toBeNull();
  });

  it('is what publicInverters sends in place of raw', () => {
    const [out] = publicInverters([{ id: 'a', raw: JSON.stringify({ sno: 'SN', power: 2, alarmCount: 1 }) }], aliasFor(['a'])) as Record<string, unknown>[];
    expect(out.raw).toBeUndefined();
    expect(JSON.parse(String(out.telemetry))).toEqual({ power: 2, alarmCount: 1 });
    expect(out.alarm_count).toBe(1);
  });
});

describe("a device's own alert count", () => {
  const alias = aliasFor(['solarman:station:1']);
  it('comes across as alert_status, and nothing else of the payload does', () => {
    const [out] = publicDevices([{ id: 'd', plant_id: '1', raw: JSON.stringify({ alertStatus: 3, addr: 'x' }) }], alias) as Record<string, unknown>[];
    expect(out.alert_status).toBe(3);
    expect(JSON.stringify(out)).not.toContain('addr');
  });
  it("is null when the payload does not say, which is not SolarMan's -1", () => {
    expect((publicDevices([{ id: 'd', raw: null }], alias)[0] as Record<string, unknown>).alert_status).toBeNull();
    expect((publicDevices([{ id: 'd', raw: { alertStatus: -1 } }], alias)[0] as Record<string, unknown>).alert_status).toBe(-1);
  });
});
