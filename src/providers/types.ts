export type ProviderId = 'soliscloud' | 'solarman';

export interface Plant {
  id: string;
  name: string;
  capacityW?: number | null;
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
  batteryStatus: string | null;
  gridStatus: string | null;
}

export function emptyMetrics(): Metrics {
  return {
    genMonthKwh: null, genYearKwh: null, genTotalKwh: null,
    loadTodayKwh: null, loadTotalKwh: null,
    gridImportTodayKwh: null, gridExportTodayKwh: null,
    gridImportTotalKwh: null, gridExportTotalKwh: null,
    battChargeTodayKwh: null, battDischargeTodayKwh: null,
    battChargeTotalKwh: null, battDischargeTotalKwh: null,
    selfUseTodayKwh: null, batteryStatus: null, gridStatus: null,
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
}
