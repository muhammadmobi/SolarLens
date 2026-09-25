/**
 * What the dashboard's API answers, as the end-to-end tests serve it.
 *
 * The end-to-end suite stubs /api/* rather than running the Worker, so these
 * rows are the page's whole picture of the server. They once drifted from it:
 * the rows carried the vendor's raw payload, which the Worker has never sent,
 * so the tests passed while the Raw telemetry table and three kinds of alert
 * never appeared on the live site. `tests/unit/fixture-contract.test.ts` now
 * runs the real Worker and fails if a row here has a field the Worker does not
 * send, or lacks one it does. Values are illustrative; the fields are not.
 *
 * Kept free of Playwright so the unit suite can import it.
 */

export const NOW = Math.floor(Date.now() / 1000);
// The Worker publishes systems under positional aliases (src/public-view.ts),
// and a device's plant_id is the same alias, so these are what the page sees.
export const SOLIS = 's1';
export const HYBRID = 's2';

// The API sends metrics as a JSON string, so the fixtures do too.
export const metrics = (o: Record<string, unknown>) => JSON.stringify(o);

/**
 * The two systems, as /api/latest returns them: an on-grid SolisCloud plant with
 * no battery, and a SolarMan hybrid with one. A test changes one of them by
 * passing overrides for 'solis' or 'solarman'.
 */
export function inverters(overrides: Partial<Record<'solis' | 'solarman', Record<string, unknown>>> = {}) {
  return [
    {
      id: SOLIS, provider: 'soliscloud', serial: '••••MO01', name: 'Demo Solis Plant',
      plant_name: 'Demo Solis Plant', capacity_w: 12000, display_order: 0, tz_offset_sec: null,
      ts: NOW - 120, source: 'soliscloud-relay', ac_power_w: 5080, dc_power_w: null, today_kwh: 49, total_kwh: 48852,
      // An on-grid plant has no battery at all - not a battery sitting at 0%.
      battery_soc: null, battery_power_w: null, grid_power_w: -5080, load_power_w: null, temp_c: null, status: 'online',
      metrics: metrics({ genMonthKwh: 185, genYearKwh: 13677, genTotalKwh: 48852, loadTodayKwh: 49, loadTotalKwh: 48852,
        gridImportTodayKwh: 0, gridExportTodayKwh: 0, gridImportTotalKwh: 0, gridExportTotalKwh: 0,
        battChargeTodayKwh: null, battDischargeTodayKwh: null, battChargeTotalKwh: null, battDischargeTotalKwh: null,
        selfUseTodayKwh: null, fullLoadHours: 4.94, batteryStatus: null, gridStatus: null,
        weatherText: 'Clear', tempMinC: 24, tempMaxC: 31, sunrise: '05:45', sunset: '18:25' }),
      // SolisCloud's alarm fields; the flags are SolarMan's, so null here.
      alarm_count: 0, alarm_level: 0,
      warning_status: null, business_warning_status: null, consumer_warning_status: null, network_status: null,
      telemetry: JSON.stringify({ power: 5.08, powerStr: 'kW', state: 1, fullHour: 4.94 }),
      ...(overrides.solis ?? {}),
    },
    {
      id: HYBRID, provider: 'solarman', serial: null, name: 'Demo Hybrid',
      plant_name: 'Demo Hybrid', capacity_w: 3500, display_order: 0, tz_offset_sec: null,
      ts: NOW - 200, source: 'solarman-web', ac_power_w: 278, dc_power_w: null, today_kwh: 13.7, total_kwh: 7450.8,
      battery_soc: 100, battery_power_w: -24, grid_power_w: 91, load_power_w: 307, temp_c: null, status: 'online',
      metrics: metrics({ genMonthKwh: 70.9, genYearKwh: 4002.1, genTotalKwh: 7450.8, loadTodayKwh: 4.8, loadTotalKwh: 6691.7,
        gridImportTodayKwh: 2.4, gridExportTodayKwh: 10.7, gridImportTotalKwh: 4699.2, gridExportTotalKwh: 4686.7,
        battChargeTodayKwh: 0.6, battDischargeTodayKwh: 0, battChargeTotalKwh: 1100.1, battDischargeTotalKwh: 354.3,
        selfUseTodayKwh: 3, fullLoadHours: 4.94, batteryStatus: 'STATIC', gridStatus: 'PURCHASE' }),
      alarm_count: null, alarm_level: null,
      warning_status: 'NORMAL', business_warning_status: null, consumer_warning_status: null, network_status: 'NORMAL',
      telemetry: JSON.stringify({ generationPower: 278, usePower: 307, batterySoc: 100, networkStatus: 'NORMAL' }),
      ...(overrides.solarman ?? {}),
    },
  ];
}

/** The hardware behind them, as /api/devices returns it: inverters and dataloggers. */
export function devices() {
  return [
    {
      id: 's1-inverter-1', provider: 'soliscloud', plant_id: SOLIS, kind: 'inverter',
      sn: '••••MO01', name: 'Demo Solis Inverter', model: 'S5-GR3P10K', firmware: '87003E',
      rated_power_w: 10000, status: 'online', signal_dbm: null, signal_pct: null, upload_cycle_s: null,
      commissioned_at: 1709121876, warranty_until: 1866816000, last_seen: NOW - 120,
      strings: JSON.stringify([
        { index: 1, powerW: 33.58, voltageV: 167.9, currentA: 0.2 },
        { index: 2, powerW: 30.94, voltageV: 154.7, currentA: 0.2 },
      ]),
      ac_phases: JSON.stringify([
        { index: 1, voltageV: 228.4, currentA: 0.1 },
        { index: 2, voltageV: 228.3, currentA: 0.1 },
        { index: 3, voltageV: 232, currentA: 0.1 },
      ]),
      frequency_hz: 49.64, power_factor: 0.99, temp_c: 40.6, dc_bus_v: 589.9,
      battery: null, updated_at: NOW, alert_status: null,
    },
    {
      id: 's1-datalogger-1', provider: 'soliscloud', plant_id: SOLIS, kind: 'datalogger',
      sn: '••••OG01', name: 'S3-WIFI-ST', model: 'S3-WIFI-ST', firmware: '10186',
      rated_power_w: null, status: 'online', signal_dbm: -58, signal_pct: null, upload_cycle_s: 300,
      commissioned_at: null, warranty_until: null, last_seen: NOW - 120,
      strings: null, ac_phases: null, frequency_hz: null, power_factor: null,
      temp_c: null, dc_bus_v: null, battery: null,
      updated_at: NOW, alert_status: null,
    },
    {
      id: 's2-inverter-1', provider: 'solarman', plant_id: HYBRID, kind: 'inverter',
      sn: '••••YB01', name: 'Demo Hybrid Inverter', model: 'Single phase LV Hybrid', firmware: 'V1.0 / V2.0',
      rated_power_w: 3500, status: 'online', signal_dbm: null, signal_pct: 84, upload_cycle_s: null,
      commissioned_at: null, warranty_until: null, last_seen: NOW - 200,
      strings: JSON.stringify([{ index: 1, powerW: 120, voltageV: 24.2, currentA: 5 }]),
      ac_phases: JSON.stringify([{ index: 1, voltageV: 233.3, currentA: 0.2 }]),
      frequency_hz: 50.01, power_factor: null,
      temp_c: 49.4, dc_bus_v: null,
      battery: JSON.stringify({
        tempC: 32.5, voltageV: 27.29, currentA: -0.93,
        bmsTempC: 32.5, bmsVoltageV: 26.98, bmsCurrentA: 0,
        chargeLimitA: 0, dischargeLimitA: 130,
        ratedCapacityAh: 100, nominalVoltageV: 24, chemistry: 'lithium', status: 'Static',
        bmsSocPct: 100, bmsChargeVoltageV: 28.5, bmsDischargeVoltageV: 0,
      }),
      updated_at: NOW, alert_status: null,
    },
    {
      id: 's2-datalogger-1', provider: 'solarman', plant_id: HYBRID, kind: 'datalogger',
      sn: '••••OG02', name: 'Datalogger', model: 'LSW-3', firmware: 'MW3_15U_5406_1.20',
      rated_power_w: null, status: 'online', signal_dbm: null, signal_pct: 84, upload_cycle_s: 300,
      commissioned_at: null, warranty_until: null, last_seen: NOW - 200,
      strings: null, ac_phases: null, frequency_hz: null, power_factor: null,
      temp_c: null, dc_bus_v: null, battery: null,
      updated_at: NOW, alert_status: null,
    },
  ];
}

/** Today's samples for both systems, from local midnight, as /api/series returns them. */
export function series() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const t0 = Math.floor(start.getTime() / 1000);
  const points: unknown[] = [];
  for (let h = 6; h <= 18; h++) {
    const ts = t0 + h * 3600;
    const bell = Math.max(0, Math.sin(((h - 6) / 12) * Math.PI));
    points.push({ inverter_id: SOLIS, ts, ac_power_w: Math.round(10_000 * bell), today_kwh: null, battery_soc: null, grid_power_w: null });
    points.push({ inverter_id: HYBRID, ts, ac_power_w: Math.round(3_000 * bell), today_kwh: null, battery_soc: null, grid_power_w: null });
  }
  return points;
}

/** Four days of daily rows: the on-grid plant has no meter, the hybrid has. */
export function historyRows() {
  const day = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
  const rows: unknown[] = [];
  for (let n = 0; n < 4; n++) {
    rows.push({
      inverter_id: SOLIS, day: day(n), yield_kwh: 44.7 - n, peak_w: 9470,
      load_kwh: null, import_kwh: null, export_kwh: null,
      batt_charge_kwh: null, batt_discharge_kwh: null,
      samples: 111, first_ts: NOW - 86400, last_ts: NOW,
    });
    rows.push({
      inverter_id: HYBRID, day: day(n), yield_kwh: 13.2 - n, peak_w: 2850,
      load_kwh: 5.3, import_kwh: 2.2, export_kwh: 9.4,
      batt_charge_kwh: 0.9, batt_discharge_kwh: 0.2,
      samples: 140, first_ts: NOW - 86400, last_ts: NOW,
    });
  }
  return rows;
}
