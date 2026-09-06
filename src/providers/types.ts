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
  listPlants(): Promise<Plant[]>;
  listInverters(plantId: string): Promise<Inverter[]>;
  getReading(inv: Inverter): Promise<Reading | null>;
}
