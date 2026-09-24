/**
 * The shapes every vendor is normalised into.
 *
 * SolisCloud and SolarMan describe the same things in different words, units
 * and nesting. Each provider (soliscloud.ts, solarman.ts, solarman-web.ts)
 * turns its vendor's answers into these types, and nothing past the provider
 * ever sees a vendor's own field names. Power is watts, energy kWh, times epoch
 * seconds, and a figure the vendor did not report is null - never zero, because
 * zero is a measurement.
 */
import type { Alarm, Period } from './events';

export type ProviderId = 'soliscloud' | 'solarman';

export interface Plant {
  id: string;
  name: string;
  capacityW?: number | null;
  /** The plant's own UTC offset in seconds, where the vendor reports one. */
  tzOffsetSec?: number | null;
  /** The plant's IANA zone name, where the vendor states one. */
  tzName?: string | null;
}

export interface Inverter {
  /** "{provider}:{vendorId}" — stable primary key across restarts. */
  id: string;
  provider: ProviderId;
  vendorId: string;
  serial: string | null;
  name: string;
  plantId: string;
  plantName: string;
  capacityW: number | null;
  /**
   * The array's own UTC offset in seconds, used to decide where its day ends.
   * Null when the vendor does not say, and the caller's offset is used instead.
   */
  tzOffsetSec?: number | null;
  /**
   * The plant's IANA zone name, where the vendor states one. An offset is a
   * fact about a moment; only the name stays true through a daylight-saving
   * switch, so it is kept and used to date each reading.
   */
  tzName?: string | null;
}

/** Pack-level battery figures the inverter reports alongside SOC. */
export interface BatteryDetail {
  tempC: number | null;
  voltageV: number | null;
  currentA: number | null;
  bmsTempC: number | null;
  bmsVoltageV: number | null;
  bmsCurrentA: number | null;
  chargeLimitA: number | null;
  dischargeLimitA: number | null;
  /** Nameplate, which is what turns cumulative charge into equivalent cycles. */
  ratedCapacityAh: number | null;
  nominalVoltageV: number | null;
  chemistry: string | null;
  /** The pack's own word for what it is doing ("Charging", "Static", ...). */
  status: string | null;
  /** The BMS's SOC, which can drift a little from the inverter's. */
  bmsSocPct: number | null;
  bmsChargeVoltageV: number | null;
  bmsDischargeVoltageV: number | null;
}

export type DeviceKind = 'inverter' | 'datalogger' | 'battery' | 'meter';

/** One physical box behind a reading, as the vendors' Device pages describe it. */
export interface Device {
  id: string;
  provider: string;
  plantId: string | null;
  kind: DeviceKind;
  sn: string | null;
  name: string | null;
  model: string | null;
  firmware: string | null;
  ratedPowerW: number | null;
  status: string | null;
  /** Datalogger signal, dBm (negative; closer to 0 is stronger) - SolisCloud. */
  signalDbm: number | null;
  /** Datalogger signal as a 0-100 percentage - SolarMan. */
  signalPct: number | null;
  uploadCycleS: number | null;
  commissionedAt: number | null;
  warrantyUntil: number | null;
  lastSeen: number | null;
  /** Per-MPPT-string DC power, only the strings actually producing. */
  strings: { index: number; powerW: number; voltageV?: number | null; currentA?: number | null }[] | null;
  /** Per-phase AC output, from the inverter's own detail page. */
  acPhases: { index: number; voltageV: number | null; currentA: number | null }[] | null;
  frequencyHz: number | null;
  powerFactor: number | null;
  /** Heatsink temperature in °C. */
  tempC: number | null;
  dcBusV: number | null;
  /** Battery and BMS detail; hybrids only, and the field set differs by vendor. */
  battery: BatteryDetail | null;
  raw: unknown;
}

/**
 * Extended, mostly-cumulative figures the vendor apps show on their detail
 * pages. All nullable: a provider/inverter exposes whatever subset it has, and
 * a missing field is not an error. Energy is kWh, ratios are percent.
 */
export interface Metrics {
  genMonthKwh: number | null;
  genYearKwh: number | null;
  genTotalKwh: number | null;
  loadTodayKwh: number | null;
  loadTotalKwh: number | null;
  gridImportTodayKwh: number | null;
  gridExportTodayKwh: number | null;
  gridImportTotalKwh: number | null;
  gridExportTotalKwh: number | null;
  battChargeTodayKwh: number | null;
  battDischargeTodayKwh: number | null;
  battChargeTotalKwh: number | null;
  battDischargeTotalKwh: number | null;
  selfUseTodayKwh: number | null;
  /** Hours the array would need at full rating to make today's energy. */
  fullLoadHours: number | null;
  /** Today's weather, where the vendor ships it with the plant snapshot. */
  weatherText: string | null;
  tempMinC: number | null;
  tempMaxC: number | null;
  sunrise: string | null;
  sunset: string | null;
  batteryStatus: string | null;
  gridStatus: string | null;
}

/** A Metrics with every figure null: the starting point a provider fills in. */
export function emptyMetrics(): Metrics {
  return {
    genMonthKwh: null, genYearKwh: null, genTotalKwh: null,
    loadTodayKwh: null, loadTotalKwh: null,
    gridImportTodayKwh: null, gridExportTodayKwh: null,
    gridImportTotalKwh: null, gridExportTotalKwh: null,
    battChargeTodayKwh: null, battDischargeTodayKwh: null,
    battChargeTotalKwh: null, battDischargeTotalKwh: null,
    selfUseTodayKwh: null, fullLoadHours: null,
    weatherText: null, tempMinC: null, tempMaxC: null, sunrise: null, sunset: null,
    batteryStatus: null, gridStatus: null,
  };
}

/**
 * The one shape the UI understands. Every field is nullable on purpose: the two
 * clouds expose different subsets depending on whether the inverter is hybrid,
 * and a missing battery is not an error.
 */
export interface Reading {
  inverterId: string;
  ts: number; // epoch seconds
  source: string;
  acPowerW: number | null;
  dcPowerW: number | null;
  todayKwh: number | null;
  totalKwh: number | null;
  batterySoc: number | null;
  batteryPowerW: number | null;
  gridPowerW: number | null;
  loadPowerW: number | null;
  tempC: number | null;
  status: string | null;
  /** Extended figures for the detail view; may be null for terse sources. */
  metrics?: Metrics | null;
  raw: unknown;
}

export interface Provider {
  readonly id: ProviderId;
  /** Optional: hardware behind the readings, when the vendor exposes it. */
  listDevices?(plantId: string): Promise<Device[]>;
  listPlants(): Promise<Plant[]>;
  listInverters(plantId: string): Promise<Inverter[]>;
  getReading(inv: Inverter): Promise<Reading | null>;
  /** Optional: the plant's fault history, newest first. */
  listAlarms?(plantId: string): Promise<Alarm[]>;
  /** Optional: the vendor's own totals - per month for a year, or per day for a month. */
  listPeriods?(plantId: string, year: number, month?: number): Promise<Period[]>;
}
