import { describe, expect, it } from 'vitest';
import solisFixture from '../fixtures/solis-station.json';
import solarmanFixture from '../fixtures/solarman-station.json';
import { stationReading as solisStation } from '../../src/providers/soliscloud';
import { stationReading as solarmanStation, stationInverter } from '../../src/providers/solarman';
import { plantFilter } from '../../src/poll';
import type { Inverter } from '../../src/providers/types';

const solisInv: Inverter = {
  id: 'soliscloud:station:1000000000000000001', provider: 'soliscloud', vendorId: '1000000000000000001',
  serial: null, name: 'Demo Solis Plant', plantId: '1000000000000000001', plantName: 'Demo Solis Plant', capacityW: 12_000,
};

describe('SolisCloud station normaliser', () => {
  const r = solisStation(solisInv, solisFixture as Record<string, unknown>);

  it('scales power by its unit string and keeps the ms timestamp as seconds', () => {
    expect(r.acPowerW).toBe(1010);
    expect(r.ts).toBe(1788611283);
    expect(r.source).toBe('soliscloud');
  });
  it('uses + import / - export for grid: Solis psum is positive when exporting', () => {
    expect(r.gridPowerW).toBe(-1010);
  });
  it('normalises today / lifetime energy to kWh across kWh and MWh units', () => {
    expect(r.todayKwh).toBe(49);
    expect(r.totalKwh).toBeCloseTo(48852, 6);
  });
  it('maps state 1 to online', () => {
    expect(r.status).toBe('online');
  });
  it('fills the extended metrics from the paired value/unit fields', () => {
    expect(r.metrics?.genMonthKwh).toBe(185);
    expect(r.metrics?.genYearKwh).toBeCloseTo(13677, 6);
    expect(r.metrics?.genTotalKwh).toBeCloseTo(48852, 6);
    expect(r.metrics?.loadTodayKwh).toBe(49);
    expect(r.metrics?.loadTotalKwh).toBeCloseTo(48852, 6);
    expect(r.metrics?.gridImportTodayKwh).toBe(0);
    // The fixture is an on-grid plant, so battery counters stay null rather
    // than reporting a permanently-empty battery that does not exist.
    expect(r.metrics?.battChargeTotalKwh).toBeNull();
  });
  it('keeps the untouched vendor payload in raw for later backfill', () => {
    expect(r.raw).toBe(solisFixture);
  });
  it('maps other states without guessing', () => {
    expect(solisStation(solisInv, { ...solisFixture, state: 2 } as Record<string, unknown>).status).toBe('offline');
    expect(solisStation(solisInv, { ...solisFixture, state: 3 } as Record<string, unknown>).status).toBe('alarm');
    expect(solisStation(solisInv, { ...solisFixture, state: 9 } as Record<string, unknown>).status).toBe('state:9');
  });
});

describe('SolarMan station normaliser', () => {
  const inv = stationInverter({ id: '62000000', name: 'Demo Hybrid', capacityW: 3500 });
  const base = solarmanFixture as Record<string, unknown>;
  const r = solarmanStation(inv, base);

  it('builds a plant-level inverter id and carries the plant name/capacity', () => {
    expect(inv.id).toBe('solarman:station:62000000');
    expect(inv.capacityW).toBe(3500);
  });
  it('reads live power in plain watts and the s timestamp as-is', () => {
    expect(r.acPowerW).toBe(278);
    expect(r.loadPowerW).toBe(307);
    expect(r.batterySoc).toBe(100);
    expect(r.ts).toBe(1788610914);
  });
  it('grid = purchase - feed-in, so buying 91 W with 0 W export is +91 W import', () => {
    expect(r.gridPowerW).toBe(91);
  });
  it('treats a STATIC battery reading as idle drift and keeps its raw sign', () => {
    expect(r.batteryPowerW).toBe(-24);
  });
  it('uses batteryStatus to fix the sign when only batteryPower is reported', () => {
    const charging = solarmanStation(inv, { ...base, batteryPower: 300, batteryStatus: 'CHARGING' });
    const discharging = solarmanStation(inv, { ...base, batteryPower: 300, batteryStatus: 'DISCHARGING' });
    expect(charging.batteryPowerW).toBe(300);
    expect(discharging.batteryPowerW).toBe(-300);
  });
  it('prefers explicit charge/discharge power when either is non-zero', () => {
    expect(solarmanStation(inv, { ...base, chargePower: 500, dischargePower: 0 }).batteryPowerW).toBe(500);
    expect(solarmanStation(inv, { ...base, chargePower: 0, dischargePower: 420 }).batteryPowerW).toBe(-420);
  });
  it('maps today / lifetime energy and the extended breakdown', () => {
    expect(r.todayKwh).toBe(13.7);
    expect(r.totalKwh).toBe(7450.8);
    expect(r.metrics).toMatchObject({
      genMonthKwh: 70.9, genYearKwh: 4002.1, genTotalKwh: 7450.8,
      loadTodayKwh: 4.8, loadTotalKwh: 6691.7,
      gridImportTodayKwh: 2.4, gridExportTodayKwh: 10.7,
      gridImportTotalKwh: 4699.2, gridExportTotalKwh: 4686.7,
      battChargeTodayKwh: 0.6, battDischargeTodayKwh: 0,
      battChargeTotalKwh: 1100.1, battDischargeTotalKwh: 354.3,
      selfUseTodayKwh: 3.0003, batteryStatus: 'STATIC', gridStatus: 'PURCHASE',
    });
  });
  it('derives status from network and warning flags', () => {
    expect(r.status).toBe('online');
    expect(solarmanStation(inv, { ...base, warningStatus: 'WARNING' }).status).toBe('alarm');
    expect(solarmanStation(inv, { ...base, networkStatus: 'OFFLINE' }).status).toBe('offline');
  });
  it('leaves month/year null when a terse endpoint omits them', () => {
    const { generationMonth: _m, generationYear: _y, ...terse } = base;
    const t = solarmanStation(inv, terse);
    expect(t.metrics?.genMonthKwh).toBeNull();
    expect(t.metrics?.genYearKwh).toBeNull();
    expect(t.todayKwh).toBe(13.7);
  });
});

describe('plantFilter', () => {
  const env = (v?: string) => ({ INCLUDE_PLANTS: v }) as Parameters<typeof plantFilter>[0];
  it('accepts every plant when INCLUDE_PLANTS is unset or blank', () => {
    expect(plantFilter(env(undefined))('any')).toBe(true);
    expect(plantFilter(env(' , '))('any')).toBe(true);
  });
  it('limits polling to the listed ids, tolerating spaces', () => {
    const f = plantFilter(env(' 111 , 222 '));
    expect(f('111')).toBe(true);
    expect(f('222')).toBe(true);
    expect(f('333')).toBe(false);
  });
});

describe('battery presence is taken from the plant inventory, not zeroed fields', () => {
  it('reports no battery for an on-grid plant that lists none', () => {
    const r = solisStation(solisInv, {
      ...(solisFixture as Record<string, unknown>),
      batteryCount: 0,
      batteries: [],
      batteryCapacitySoc2: 0,
      batteryPower: 0,
      batteryPowerStr: 'kW',
    });
    expect(r.batterySoc).toBeNull();
    expect(r.batteryPowerW).toBeNull();
    expect(r.metrics?.battChargeTotalKwh).toBeNull();
  });

  it('keeps battery fields when the plant actually has one', () => {
    const r = solisStation(solisInv, {
      ...(solisFixture as Record<string, unknown>),
      batteryCount: 1,
      batteryCapacitySoc2: 64,
      batteryPower: 1.2,
      batteryPowerStr: 'kW',
    });
    expect(r.batterySoc).toBe(64);
    expect(r.batteryPowerW).toBe(1200);
  });
});
