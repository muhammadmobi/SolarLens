import { describe, expect, it } from 'vitest';
import { aliasFor, maskSerial, publicDevices, publicInverters, publicRows } from '../../src/public-view';

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
