/**
 * The shapes a device record arrives in, and the fallbacks each one takes.
 *
 * A vendor's device list is the least consistent thing either portal returns:
 * a serial is sometimes absent, a plant id is sometimes only inside the record,
 * a status is a number in one payload and missing in the next. Every one of
 * those is a fallback in the normalisers, and a fallback nothing exercises is a
 * guess. These walk each arm deliberately.
 */
import { describe, expect, it } from 'vitest';
import {
  deviceFromRecord, deviceFromV3Detail, stationInverter, stationReading as solarmanStation,
} from '../../src/providers/solarman';
import {
  deviceFromCollector, deviceFromInverter, deviceFromInverterDetail, historyFromChart,
  hasGridMetering, stationReading as solisStation, stripPii,
} from '../../src/providers/soliscloud';

describe('SolarMan device records', () => {
  it('reads a datalogger as a datalogger, whatever case the type arrives in', () => {
    expect(deviceFromRecord({ deviceType: 'collector', deviceSn: 'LOG1' }, 'p1').kind).toBe('datalogger');
    expect(deviceFromRecord({ deviceType: 'COLLECTOR', deviceSn: 'LOG1' }, 'p1').kind).toBe('datalogger');
    expect(deviceFromRecord({ deviceType: 'INVERTER', deviceSn: 'INV1' }, 'p1').kind).toBe('inverter');
    // No type at all: an inverter is the safe reading, since that is what a
    // station has at least one of.
    expect(deviceFromRecord({ deviceSn: 'X1' }, 'p1').kind).toBe('inverter');
  });

  it('names a device by serial, then by device id, then not at all', () => {
    expect(deviceFromRecord({ deviceSn: 'INV1', deviceId: 11 }, 'p1').id).toBe('solarman:inverter:INV1');
    expect(deviceFromRecord({ deviceId: 11 }, 'p1').id).toBe('solarman:inverter:11');
    expect(deviceFromRecord({}, 'p1').id).toBe('solarman:inverter:unknown');
  });

  it('takes the plant from the record when the caller did not say', () => {
    expect(deviceFromRecord({ deviceSn: 'X', stationId: 62000000 }, null).plantId).toBe('62000000');
    expect(deviceFromRecord({ deviceSn: 'X' }, null).plantId).toBeNull();
    expect(deviceFromRecord({ deviceSn: 'X', stationId: 62000000 }, 'p1').plantId).toBe('p1');
    // A station id present but empty is no station id at all - and must not
    // become the string "null", which is what it did until this was written.
    expect(deviceFromRecord({ deviceSn: 'X', stationId: null }, null).plantId).toBeNull();
    expect(deviceFromRecord({ deviceSn: 'X', stationId: '' }, null).plantId).toBeNull();
  });

  it('maps every status the portal uses, and leaves an unknown one null', () => {
    const status = (deviceStatus: unknown) => deviceFromRecord({ deviceSn: 'X', deviceStatus }, 'p1').status;
    expect(status(1)).toBe('online');
    expect(status(2)).toBe('alarm');
    expect(status(3)).toBe('offline');
    expect(status(9)).toBeNull();
    expect(status(undefined)).toBeNull();
  });

  it('reads the inverter detail page, including a field with no unit and one with no key', () => {
    const d = deviceFromV3Detail({
      deviceSn: 'INV1', deviceId: 11,
      dataList: [
        { key: 'APo_t1', value: '1620', unit: 'W' },
        { key: 'DC_V1', value: '380' },          // no unit
        { value: '5' },                           // no key at all
      ],
    }, 'p1');
    expect(d.id).toBe('solarman:inverter:INV1');
    expect(d.kind).toBe('inverter');
  });

  it('falls back through serial, device id and nothing on the detail page too', () => {
    expect(deviceFromV3Detail({ deviceId: 11 }, 'p1').id).toBe('solarman:inverter:11');
    expect(deviceFromV3Detail({}, 'p1').id).toBe('solarman:inverter:unknown');
  });

  it('carries a plant through as the unit of monitoring', () => {
    expect(stationInverter({ id: '62000000', name: 'Hybrid Plant', capacityW: 3500 })).toMatchObject({
      id: 'solarman:station:62000000', vendorId: '62000000', plantName: 'Hybrid Plant', capacityW: 3500, serial: null,
    });
    // No nameplate and no zone stay null rather than becoming zero.
    expect(stationInverter({ id: '1', name: 'P' })).toMatchObject({ capacityW: null, tzOffsetSec: null });
  });
});

describe('SolarMan station figures', () => {
  const inv = {
    id: 'solarman:station:1', provider: 'solarman' as const, vendorId: '1', serial: null,
    name: 'Plant', plantId: '1', plantName: 'Plant', capacityW: 3500,
  };

  it('prefers the meter\'s import and export over the net wire figure', () => {
    // purchasePower / buyPower is import, gridPower is export, wirePower is net.
    expect(solarmanStation(inv, { purchasePower: 400, gridPower: 100 }).gridPowerW).toBe(300);
    expect(solarmanStation(inv, { buyPower: 400, gridPower: 100 }).gridPowerW).toBe(300);
    // One half present: the other counts as zero, not as missing.
    expect(solarmanStation(inv, { purchasePower: 400 }).gridPowerW).toBe(400);
    expect(solarmanStation(inv, { gridPower: 250 }).gridPowerW).toBe(-250);
    // Neither: the net figure stands in, and only then.
    expect(solarmanStation(inv, { wirePower: -600 }).gridPowerW).toBe(-600);
    expect(solarmanStation(inv, {}).gridPowerW).toBeNull();
  });

  it('signs battery power from charge and discharge, or from the pack\'s own word', () => {
    expect(solarmanStation(inv, {}).batteryPowerW).toBeNull();
    expect(solarmanStation(inv, { chargePower: 800 }).batteryPowerW).toBe(800);
    expect(solarmanStation(inv, { dischargePower: 500 }).batteryPowerW).toBe(-500);
    // A bare figure is unsigned, so the pack's status decides its direction.
    expect(solarmanStation(inv, { batteryPower: 300, batteryStatus: 'CHARGING' }).batteryPowerW).toBe(300);
    expect(solarmanStation(inv, { batteryPower: 300, batteryStatus: 'DISCHARGING' }).batteryPowerW).toBe(-300);
  });
});

describe('SolisCloud device records', () => {
  it('names an inverter by serial, then id, then not at all', () => {
    expect(deviceFromInverter({ sn: 'INV1', id: '3000000000000000003' }, 'p1').id).toBe('soliscloud:inverter:INV1');
    expect(deviceFromInverter({ id: '3000000000000000003' }, 'p1').id).toBe('soliscloud:inverter:3000000000000000003');
    expect(deviceFromInverter({}, 'p1').id).toBe('soliscloud:inverter:unknown');
  });

  it('does the same for a datalogger, and takes the plant from the record when needed', () => {
    expect(deviceFromCollector({ sn: 'LOG1' }, 'p1').id).toBe('soliscloud:datalogger:LOG1');
    expect(deviceFromCollector({ id: '4000000000000000004' }, 'p1').id).toBe('soliscloud:datalogger:4000000000000000004');
    expect(deviceFromCollector({}, 'p1').id).toBe('soliscloud:datalogger:unknown');
    expect(deviceFromCollector({ sn: 'LOG1', stationId: 'p9' }, null).plantId).toBe('p9');
    expect(deviceFromCollector({ sn: 'LOG1' }, null).plantId).toBeNull();
  });

  it('reads per-phase AC when either the voltage or the current is present, and skips a phase with neither', () => {
    const d = deviceFromInverterDetail({
      sn: 'INV1',
      uAc1: 232.5, iAc1: 5.1,   // both
      uAc2: 231.0,              // voltage only
      iAc3: 4.8,                // current only
    }, 'p1');
    expect(d.acPhases?.map((p) => p.index)).toEqual([1, 2, 3]);
    expect(d.acPhases?.[1]).toMatchObject({ voltageV: 231, currentA: null });
    expect(d.acPhases?.[2]).toMatchObject({ voltageV: null, currentA: 4.8 });
  });

  it('falls back through serial and id on the detail page as well', () => {
    expect(deviceFromInverterDetail({ id: '3000000000000000003' }, 'p1').id).toBe('soliscloud:inverter:3000000000000000003');
    expect(deviceFromInverterDetail({}, 'p1').id).toBe('soliscloud:inverter:unknown');
  });
});

describe('SolisCloud day curve', () => {
  const noon = Date.UTC(2026, 8, 8, 7, 0, 0);

  it('skips a point whose time or power is missing, and keeps the rest', () => {
    const pts = historyFromChart({
      time: [noon, null, noon + 600_000],
      power: [1000, 2000, null],
      powerStr: 'W',
    });
    expect(pts.map((p) => p.acPowerW)).toEqual([1000]);
  });

  it('answers with nothing at all when no point survives', () => {
    expect(historyFromChart({ time: [], power: [], powerStr: 'W' })).toEqual([]);
    expect(historyFromChart({ nothing: 'useful' })).toEqual([]);
  });
});

describe('SolisCloud plant figures', () => {
  const inv = {
    id: 'soliscloud:station:1', provider: 'soliscloud' as const, vendorId: '1', serial: null,
    name: 'Plant', plantId: '1', plantName: 'Plant', capacityW: 12_000,
  };

  it('reads today\'s consumption under either name, but only on a metered plant', () => {
    const metered = { gridPurchasedTotalEnergy: 120, gridSellTotalEnergy: 80 };
    expect(JSON.stringify(solisStation(inv, { ...metered, homeLoadEnergy: 12.5, homeLoadEnergyStr: 'kWh' }).metrics)).toContain('12.5');
    expect(JSON.stringify(solisStation(inv, { ...metered, homeLoadTodayEnergy: 12.5, homeLoadTodayEnergyStr: 'kWh' }).metrics)).toContain('12.5');

    // Unmetered, the portal mirrors generation into load. A mirror is not a
    // measurement, so nothing is kept.
    expect(JSON.stringify(solisStation(inv, { homeLoadEnergy: 12.5, homeLoadEnergyStr: 'kWh' }).metrics)).not.toContain('12.5');
  });

  it('decides metering on the lifetime totals, not on a number being present', () => {
    expect(hasGridMetering({ gridPurchasedTotalEnergy: 120 })).toBe(true);
    expect(hasGridMetering({ gridSellTotalEnergy: 80 })).toBe(true);
    // Every field present and zero is exactly what an unmetered plant reports.
    expect(hasGridMetering({ gridPurchasedTotalEnergy: 0, gridSellTotalEnergy: 0 })).toBe(false);
    expect(hasGridMetering({})).toBe(false);
  });

  it('strips the owner out of a payload whatever case the key arrives in', () => {
    const cleaned = stripPii({ ownerEmail: 'a@example.com', UserName: 'someone', city: 'Nowhere', capacity: 12 }) as Record<string, unknown>;
    expect(cleaned.capacity).toBe(12);          // "capacity" contains "city" and must survive
    expect(Object.keys(cleaned)).toEqual(['capacity']);
  });
});
