/**
 * What happens when a vendor sends almost nothing.
 *
 * Every normaliser is a long list of "this field, or that one, or null", and
 * the branch that is never taken in practice is the one that breaks the day a
 * portal changes. These feed each path a payload with the optional half
 * missing, and check the answer is null - not zero, not a crash, and not a
 * figure invented from a neighbouring field.
 */
import { describe, expect, it } from 'vitest';
import { createTestD1 } from '../helpers/d1';
import { daily, insertReading, listDevices, series, upsertDevice, upsertInverter } from '../../src/db';
import { solarmanAlert, solarmanPeriods, solisAlarm, solisPeriods } from '../../src/providers/events';
import { publicDevices, publicInverters, publicRelays, publicRows, aliasFor } from '../../src/public-view';
import { parseRelayStatus } from '../../src/relays';

describe('an empty vendor payload', () => {
  it('yields no alarm rather than an empty one', () => {
    expect(solisAlarm('plant-1', {})).toBeNull();
    expect(solarmanAlert('62000000', {})).toBeNull();
  });

  it('yields no period rows', () => {
    expect(solisPeriods('plant-1', 'month', [])).toEqual([]);
    expect(solisPeriods('plant-1', 'month', [{}])).toEqual([]);
    expect(solarmanPeriods('62000000', 'month', 2026, [])).toEqual([]);
  });
});

describe('a database with nothing in it', () => {
  it('answers every read with an empty list', async () => {
    const d1 = createTestD1();
    expect(await series(d1.db, 0, 2_000_000_000)).toEqual([]);
    expect(await daily(d1.db, 0, 2_000_000_000, 0)).toEqual([]);
    expect(await listDevices(d1.db)).toEqual([]);
    d1.close();
  });
});

describe('a device the portal barely describes', () => {
  it('stores what there is and leaves the rest null', async () => {
    const d1 = createTestD1();
    await upsertDevice(d1.db, {
      id: 'soliscloud:datalogger:LOG1', provider: 'soliscloud', plantId: 'plant-1', kind: 'datalogger',
      sn: null, name: null, model: null, firmware: null, ratedPowerW: null, status: null,
      signalDbm: null, signalPct: null, uploadCycleS: null, commissionedAt: null, warrantyUntil: null,
      lastSeen: null, strings: null, acPhases: null, frequencyHz: null, powerFactor: null, tempC: null,
      dcBusV: null, battery: null, raw: null,
    } as never);

    const [row] = await listDevices(d1.db);
    expect(row).toMatchObject({ id: 'soliscloud:datalogger:LOG1', kind: 'datalogger' });
    expect(row.sn).toBeNull();
    d1.close();
  });

  it('merges a second, fuller view of the same device instead of replacing it', async () => {
    const d1 = createTestD1();
    const base = {
      id: 'soliscloud:inverter:INV1', provider: 'soliscloud', plantId: 'plant-1', kind: 'inverter',
      sn: 'INVSERIAL', name: 'Inverter', model: null, firmware: null, ratedPowerW: null, status: 'normal',
      signalDbm: null, signalPct: null, uploadCycleS: null, commissionedAt: null, warrantyUntil: null,
      lastSeen: null, strings: null, acPhases: null, frequencyHz: null, powerFactor: null, tempC: null,
      dcBusV: null, battery: null, raw: null,
    };
    await upsertDevice(d1.db, base as never);
    await upsertDevice(d1.db, { ...base, sn: null, status: null, tempC: 42, firmware: '1.2.3' } as never);

    const [row] = await listDevices(d1.db);
    expect(row).toMatchObject({ sn: 'INVSERIAL', status: 'normal', temp_c: 42, firmware: '1.2.3' });
    d1.close();
  });
});

describe('a reading with only the essentials', () => {
  it('stores nulls rather than zeros, and is served that way', async () => {
    const d1 = createTestD1();
    await upsertInverter(d1.db, {
      id: 'solarman:station:1', provider: 'solarman', vendorId: '1', serial: null, name: 'Plant',
      plantId: '1', plantName: 'Plant', capacityW: null,
    } as never);
    const stored = await insertReading(d1.db, {
      inverterId: 'solarman:station:1', ts: 1_700_000_000, source: 'test', acPowerW: 100,
      dcPowerW: null, todayKwh: null, totalKwh: null, batterySoc: null, batteryPowerW: null,
      gridPowerW: null, loadPowerW: null, tempC: null, status: null, metrics: null, raw: null,
    } as never);
    expect(stored).toBe(true);

    const rows = await series(d1.db, 1_699_999_000, 1_700_001_000);
    expect(rows[0]).toMatchObject({ ac_power_w: 100 });
    expect(rows[0].battery_soc).toBeNull();
    d1.close();
  });
});

describe('the public view, given rows it has no alias for', () => {
  it('answers "unknown" for an id it has no alias for, rather than echoing it', () => {
    const alias = aliasFor(['solarman:station:1']);
    const rows = publicRows([{ inverter_id: 'solarman:station:1' }, { inverter_id: 'solarman:station:62000000' }], alias);
    const text = JSON.stringify(rows);
    expect(text).toContain('s1');
    expect(text).toContain('unknown');
    // The point of the fallback: the vendor's own id still does not leave.
    expect(text).not.toContain('62000000');
  });

  it('masks a serial that is short, absent, or already masked', () => {
    const alias = aliasFor(['p:1']);
    const out = publicInverters([
      { id: 'p:1', serial: null },
      { id: 'p:1', serial: 'AB' },
      { id: 'p:1', serial: 'ABCDEFGH' },
    ], alias);
    const serials = out.map((o) => o.serial);
    expect(serials[0]).toBeNull();
    expect(String(serials[2])).toContain('EFGH');
    expect(String(serials[2])).not.toContain('ABCD');
  });

  it('names an unnamed relay by its position, and never by its id', () => {
    const out = publicRelays([{ id: 'abcdef0123456789', name: null }, { id: 'fedcba9876543210', name: 'Office' }]);
    expect(out.map((r) => r.name)).toEqual(['Relay 1', 'Office']);
    expect(JSON.stringify(out)).not.toContain('abcdef0123456789');
  });

  it('drops a device whose plant nothing else knows about', () => {
    const alias = aliasFor(['p:station:1']);
    const out = publicDevices([{ id: 'p:inverter:X', sn: 'SERIAL0001', plant_id: '1' }], alias);
    expect(JSON.stringify(out)).not.toContain('SERIAL0001');
  });
});

describe('a relay report at the edges of what is allowed', () => {
  const now = 1_700_000_000;

  it('refuses an expiry too far in the past or the future', () => {
    const base = { provider: 'soliscloud', id: 'abcdef0123456789', state: 'ok' };
    expect(parseRelayStatus({ ...base, loginExpiresAt: now - 40 * 86400 }, now)).toHaveProperty('error');
    expect(parseRelayStatus({ ...base, loginExpiresAt: now + 500 * 86400 }, now)).toHaveProperty('error');
  });

  it('accepts a report with no expiry and no name at all', () => {
    const parsed = parseRelayStatus({ provider: 'soliscloud', id: 'abcdef0123456789', state: 'error' }, now);
    expect(parsed).toMatchObject({ state: 'error', name: null, loginExpiresAt: null });
  });

  it('trims a nickname to what is safe to print', () => {
    const parsed = parseRelayStatus(
      { provider: 'soliscloud', id: 'abcdef0123456789', name: '  Office <b>laptop</b>  ', state: 'ok' },
      now,
    ) as { name: string };
    expect(parsed.name).not.toContain('<');
    expect(parsed.name).toContain('Office');
  });
});
