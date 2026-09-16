import { describe, expect, it } from 'vitest';
import {
  readableFaultName, solarmanAlert, solarmanPeriods, solisAlarm, solisPeriods,
} from '../../src/providers/events';

/**
 * Shapes recorded from live owner accounts, with every identifier replaced. A
 * real SolisCloud alarm record also carries the owner's address, phone, email
 * and region; the fixtures keep those keys, filled with obvious fakes, so the
 * tests prove they are dropped rather than assume it.
 */
const solisRecord = (over: Record<string, unknown> = {}) => ({
  id: '-1', pk: '1_2_101500', stationId: '1000000000000000001', hasRead: 1,
  alarmDeviceSn: 'DEMOSN000001', alarmDeviceId: '2000000000000000002', stationName: 'Demo Plant',
  timeZone: 5, timeZoneStr: 'UTC+05:00', alarmDeviceType: '3', alarmType: 0,
  alarmLevel: '2', alarmCode: '1015', alarmCodeWarning: '1015',
  alarmBeginTime: 1784359680000, alarmBeginTimeStr: '18/07/2026 12:28 (UTC+05:00)',
  alarmEndTime: 1784360280294, alarmEndTimeStr: '18/07/2026 12:38 (UTC+05:00)',
  alarmLong: '600294', alarmLongStr: '<1h', state: '2',
  advice: 'No Action Required', alarmMsg: 'NO-Grid', series: 'S5-GR3P(3-20)K', machine: 'S5-GR3P10K',
  address: '1 Fake Street', mobile: '00000000000', email: 'owner@example.invalid',
  userName: 'demo-owner', userEmail: 'owner@example.invalid', countryStr: 'Nowhere', cityStr: 'Nowhere',
  ...over,
});

describe('solisAlarm', () => {
  it('reads code, message, level, advice and both times', () => {
    const a = solisAlarm('1000000000000000001', solisRecord());
    expect(a).toEqual({
      id: 'soliscloud:1000000000000000001:1015:1784359680',
      inverterId: 'soliscloud:station:1000000000000000001',
      provider: 'soliscloud',
      code: '1015',
      message: 'NO-Grid',
      severity: 'warning',
      vendorLevel: 2,
      advice: 'No Action Required',
      beginTs: 1784359680,
      endTs: 1784360280,
      state: 'recovered',
    });
  });

  it('keeps nothing personal from the record', () => {
    const json = JSON.stringify(solisAlarm('1', solisRecord()));
    for (const leak of ['Fake Street', 'owner@example', 'demo-owner', 'Nowhere', 'DEMOSN', '00000000000']) {
      expect(json).not.toContain(leak);
    }
  });

  it('maps the portal\'s levels as its own table labels them', () => {
    expect(solisAlarm('1', solisRecord({ alarmLevel: '1' }))!.severity).toBe('info');
    expect(solisAlarm('1', solisRecord({ alarmLevel: '2' }))!.severity).toBe('warning');
    expect(solisAlarm('1', solisRecord({ alarmLevel: '3' }))!.severity).toBe('fault');
    expect(solisAlarm('1', solisRecord({ alarmLevel: '9' }))!.severity).toBeNull();
  });

  it('an active alarm has no end, and says so', () => {
    const a = solisAlarm('1', solisRecord({ state: '0', alarmEndTime: null }))!;
    expect(a.state).toBe('active');
    expect(a.endTs).toBeNull();
  });

  it('the same alarm read twice has the same id, so it updates rather than duplicates', () => {
    const first = solisAlarm('1', solisRecord({ state: '0', alarmEndTime: null }))!;
    const later = solisAlarm('1', solisRecord())!;
    expect(later.id).toBe(first.id);
  });

  it('refuses a record with no code or no start', () => {
    expect(solisAlarm('1', solisRecord({ alarmCode: null }))).toBeNull();
    expect(solisAlarm('1', solisRecord({ alarmBeginTime: null }))).toBeNull();
  });

  it('empty advice is no advice, not an empty string', () => {
    expect(solisAlarm('1', solisRecord({ advice: '  ' }))!.advice).toBeNull();
  });
});

describe('solarmanAlert', () => {
  const rec = (over: Record<string, unknown> = {}) => ({
    stationName: 'Demo Hybrid', deviceType: 'INVERTER', deviceSn: 'DEMOSN000002',
    timezone: 'Etc/GMT-9', deviceName: 'Inverter', addr: 'fake', type: 0, level: 2,
    alertTime: 1785881092, influence: 1, code: '7', productId: '0_5407_1',
    deviceId: 300000002, ruleId: 26603, plantId: 60000000, showName: 'F56DC_VoltLow_Fault',
    ...over,
  });

  it('reads the fault, and names it in words', () => {
    expect(solarmanAlert('60000000', rec())).toEqual({
      id: 'solarman:60000000:7:1785881092',
      inverterId: 'solarman:station:60000000',
      provider: 'solarman',
      code: '7',
      message: 'DC volt low fault',
      severity: 'fault',
      vendorLevel: 2,
      advice: null,
      beginTs: 1785881092,
      endTs: null,
      state: 'unknown',
    });
  });

  it('does not claim to know when a SolarMan fault cleared', () => {
    const a = solarmanAlert('1', rec())!;
    expect(a.endTs).toBeNull();
    expect(a.state).toBe('unknown');
  });

  it('keeps no serial number', () => {
    expect(JSON.stringify(solarmanAlert('1', rec()))).not.toContain('DEMOSN');
  });
});

describe('readableFaultName', () => {
  it.each([
    ['F56DC_VoltLow_Fault', 'DC volt low fault'],
    ['GridOverVoltage', 'Grid over voltage'],
    ['NO_Grid', 'NO grid'],
  ])('%s reads as "%s"', (raw, want) => {
    expect(readableFaultName(raw)).toBe(want);
  });
});

describe('solisPeriods', () => {
  const point = (over: Record<string, unknown> = {}) => ({
    energy: 34.1, energyStr: 'kWh', fullHour: 2.84, dateStr: '2026-09-01', timeZone: 8,
    batteryDischargeEnergy: 0, batteryChargeEnergy: 0, gridPurchasedEnergy: 0, gridSellEnergy: 0,
    homeLoadEnergy: 34.1, consumeEnergy: 34.1, produceEnergy: 34.1, isEnergyStorage: false,
    ...over,
  });

  it('a month payload is one row per day', () => {
    const rows = solisPeriods('1', 'month', [point(), point({ dateStr: '2026-09-02', energy: 40 })]);
    expect(rows.map((r) => [r.period, r.key, r.yieldKwh])).toEqual([['day', '2026-09-01', 34.1], ['day', '2026-09-02', 40]]);
    expect(rows[0].inverterId).toBe('soliscloud:station:1');
    expect(rows[0].fullHours).toBe(2.84);
  });

  it('year is one row per month, and lifetime one per year', () => {
    expect(solisPeriods('1', 'year', [point({ dateStr: '2026-01' })])[0]).toMatchObject({ period: 'month', key: '2026-01' });
    expect(solisPeriods('1', 'all', [point({ dateStr: '2024', year: 2024 })])[0]).toMatchObject({ period: 'year', key: '2024' });
    expect(solisPeriods('1', 'all', [point({ dateStr: null, year: 2025 })])[0].key).toBe('2025');
  });

  it('an unmetered plant reports generation copied into load; neither is kept as load', () => {
    const [r] = solisPeriods('1', 'month', [point()]);
    expect(r.yieldKwh).toBe(34.1);
    expect(r.loadKwh).toBeNull();
    expect(r.importKwh).toBeNull();
    expect(r.exportKwh).toBeNull();
    expect(r.chargeKwh).toBeNull();
  });

  it('a metered plant keeps load and grid, including its zero days', () => {
    const rows = solisPeriods('1', 'month', [
      point({ gridPurchasedEnergy: 3.2, gridSellEnergy: 12, consumeEnergy: 20 }),
      point({ dateStr: '2026-09-02', gridPurchasedEnergy: 0, gridSellEnergy: 0, consumeEnergy: 18 }),
    ]);
    expect(rows[0]).toMatchObject({ loadKwh: 20, importKwh: 3.2, exportKwh: 12 });
    // A metered day with no import really is zero.
    expect(rows[1]).toMatchObject({ importKwh: 0, exportKwh: 0 });
  });

  it('scales generation by its unit', () => {
    expect(solisPeriods('1', 'all', [point({ dateStr: '2024', energy: 16.744, energyStr: 'MWh' })])[0].yieldKwh).toBeCloseTo(16744);
  });
});

describe('solarmanPeriods', () => {
  const rec = (over: Record<string, unknown> = {}) => ({
    systemId: 60000000, year: 2026, month: 9, day: 1, generationValue: 9.3, useValue: 8.3,
    gridValue: 5.6, buyValue: 5.2, chargeValue: 0.6, dischargeValue: 0, fullPowerHoursDay: 2.66,
    ...over,
  });

  it('stats/month is one row per day, keyed in the plant calendar', () => {
    const [r] = solarmanPeriods('60000000', 'month', 2026, [rec()]);
    expect(r).toEqual({
      inverterId: 'solarman:station:60000000', period: 'day', key: '2026-09-01',
      yieldKwh: 9.3, loadKwh: 8.3, importKwh: 5.2, exportKwh: 5.6,
      chargeKwh: 0.6, dischargeKwh: 0, fullHours: 2.66, source: 'solarman-web',
    });
  });

  it('gridValue is what went out and buyValue what came in, not the other way round', () => {
    const [r] = solarmanPeriods('1', 'month', 2026, [rec({ gridValue: 11, buyValue: 2 })]);
    expect(r.exportKwh).toBe(11);
    expect(r.importKwh).toBe(2);
  });

  it('stats/year is one row per month', () => {
    const [r] = solarmanPeriods('1', 'year', 2026, [rec({ month: 1, day: 0, generationValue: 292.6 })]);
    expect(r).toMatchObject({ period: 'month', key: '2026-01', yieldKwh: 292.6 });
  });

  it('skips a record that does not say which period it is', () => {
    expect(solarmanPeriods('1', 'month', 2026, [rec({ day: 0 })])).toEqual([]);
    expect(solarmanPeriods('1', 'year', 2026, [rec({ month: 0 })])).toEqual([]);
  });
});
