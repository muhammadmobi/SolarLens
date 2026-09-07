import { readFileSync, writeFileSync } from 'node:fs';

const edit = (file, pairs) => {
  let s = readFileSync(file, 'utf8');
  for (const [a, b] of pairs) {
    if (!s.includes(a)) { console.error(`MISS in ${file}: ${a.slice(0, 70)}`); process.exit(1); }
    s = s.replace(a, b);
  }
  writeFileSync(file, s);
};

// ---- types --------------------------------------------------------------
edit('src/providers/types.ts', [[
  '  dcBusV: number | null;',
  `  dcBusV: number | null;
  /** Battery and BMS detail; hybrids only, and the field set differs by vendor. */
  battery: BatteryDetail | null;`,
], [
  'export type DeviceKind =',
  `/** Pack-level battery figures the inverter reports alongside SOC. */
export interface BatteryDetail {
  tempC: number | null;
  voltageV: number | null;
  currentA: number | null;
  bmsTempC: number | null;
  bmsVoltageV: number | null;
  bmsCurrentA: number | null;
  chargeLimitA: number | null;
  dischargeLimitA: number | null;
}

export type DeviceKind =`,
]]);

// ---- solarman: fill it from the v3 registers ----------------------------
edit('src/providers/solarman.ts', [[
  "import type { Device, Inverter, Metrics, Plant, Provider, Reading } from './types';",
  "import type { BatteryDetail, Device, Inverter, Metrics, Plant, Provider, Reading } from './types';",
], [
  `    // AC_T is the inverter's own heatsink; B_T1 is the battery pack's.
    tempC: val('AC_T') ?? val('T_DC'),
    dcBusV: null,`,
  `    // AC_T is the inverter's own heatsink; B_T1 is the battery pack's.
    tempC: val('AC_T') ?? val('T_DC'),
    dcBusV: null,
    battery,`,
], [
  '  const sn = (pick(d, \'deviceSn\') as string | null) ?? str(\'SN1\');',
  `  const sn = (pick(d, 'deviceSn') as string | null) ?? str('SN1');

  // Only build a battery record when the pack actually reports something, so a
  // string inverter does not gain an all-null battery block.
  const bat: BatteryDetail = {
    tempC: val('B_T1'),
    voltageV: val('B_V1'),
    currentA: val('B_C1'),
    bmsTempC: val('BMST'),
    bmsVoltageV: val('BMS_B_V1'),
    bmsCurrentA: val('BMS_B_C1'),
    chargeLimitA: val('C_C_L'),
    dischargeLimitA: val('D_C_L'),
  };
  const battery = Object.values(bat).some((v) => v !== null) ? bat : null;`,
], [
  "    strings: null,\n    acPhases: null, frequencyHz: null, powerFactor: null, tempC: null, dcBusV: null,\n    raw: { ...d, featureData: feature },",
  "    strings: null,\n    acPhases: null, frequencyHz: null, powerFactor: null, tempC: null, dcBusV: null,\n    battery: null,\n    raw: { ...d, featureData: feature },",
]]);

// ---- soliscloud: no battery detail on these endpoints -------------------
let sc = readFileSync('src/providers/soliscloud.ts', 'utf8');
sc = sc.split('    acPhases: null, frequencyHz: null, powerFactor: null, tempC: null, dcBusV: null,')
  .join('    acPhases: null, frequencyHz: null, powerFactor: null, tempC: null, dcBusV: null,\n    battery: null,');
sc = sc.replace(`    tempC: num(pick(d, 'inverterTemperature')),
    dcBusV: num(pick(d, 'dcBus')),`, `    tempC: num(pick(d, 'inverterTemperature')),
    dcBusV: num(pick(d, 'dcBus')),
    battery: null,`);
writeFileSync('src/providers/soliscloud.ts', sc);

// ---- db -----------------------------------------------------------------
edit('src/db.ts', [
  ['  dc_bus_v: number | null;', '  dc_bus_v: number | null;\n  battery: string | null;'],
  ['power_factor, temp_c, dc_bus_v, updated_at, raw)', 'power_factor, temp_c, dc_bus_v, battery, updated_at, raw)'],
  ['VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24)',
   'VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25)'],
  ['         dc_bus_v        = COALESCE(excluded.dc_bus_v, devices.dc_bus_v),',
   '         dc_bus_v        = COALESCE(excluded.dc_bus_v, devices.dc_bus_v),\n         battery         = COALESCE(excluded.battery, devices.battery),'],
  ['      d.frequencyHz, d.powerFactor, d.tempC, d.dcBusV,',
   '      d.frequencyHz, d.powerFactor, d.tempC, d.dcBusV,\n      d.battery ? JSON.stringify(d.battery) : null,'],
]);

console.log('battery wired through types, providers and db');
