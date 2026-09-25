/**
 * What an unauthenticated visitor is allowed to see.
 *
 * The dashboard is public: anyone with the URL gets the readings, which is the
 * point. The vendor identifiers behind them are a different matter. A station
 * id, a plant id and an inverter serial are all account-level handles - they
 * are what a support agent asks for, what a warranty registration is keyed on,
 * and what ties this data to a named person. None of them is needed to draw a
 * chart, so none of them is published.
 *
 * Ids are replaced rather than removed, because the dashboard joins three
 * endpoints on them. The replacement is a positional alias - s1, s2 - derived
 * from the inverter table, so it is stable between calls and carries no
 * information. Hashing was the obvious alternative and is the wrong tool: a
 * SolarMan station id is eight digits, so a hash of one can be reversed by
 * trying all hundred million of them.
 *
 * `raw` never leaves the server as it is. It is the vendor payload kept for
 * debugging, and it carries ids, serials and - for SolarMan, whose payload is
 * stored unstripped - whatever else the vendor chose to put in it. Two things
 * are taken from it instead, both built here so the rule lives in one place:
 *
 * - the handful of fields the dashboard's alerts read (SolisCloud's alarm
 *   count and level, SolarMan's warning flags and datalogger link), as named
 *   columns - see vendorSignals;
 * - its reviewed measurement fields as `telemetry`, for the Raw telemetry
 *   table - see safeTelemetry.
 *
 * Until 3.0 the page read `raw` directly, and since `raw` was never sent, none
 * of those three things ever showed on the live site (feature-gaps gap 5).
 */

export type Alias = (id: string | null | undefined) => string | null;

/**
 * Builds the id -> alias mapping from the full list of known inverter ids.
 *
 * Both the whole id and its trailing segment map to the same alias: the
 * inverters table holds "solarman:station:123", the devices table holds the
 * bare "123" in plant_id, and the dashboard matches one against the other.
 */
export function aliasFor(inverterIds: string[]): Alias {
  const map = new Map<string, string>();
  const sorted = [...new Set(inverterIds)].sort();
  sorted.forEach((id, i) => {
    const alias = `s${i + 1}`;
    map.set(id, alias);
    const tail = id.split(':').pop();
    if (tail) map.set(tail, alias);
  });
  // An id we have never seen still must not be echoed back verbatim.
  return (id) => (id == null ? null : (map.get(id) ?? 'unknown'));
}

/** Last four characters, enough to tell two units apart, not enough to quote. */
export function maskSerial(sn: string | null | undefined): string | null {
  if (!sn) return null;
  const s = String(sn);
  return s.length <= 4 ? '••••' : `••••${s.slice(-4)}`;
}

/** Drop keys by name. Written out because the row types are interfaces, which
 *  carry no index signature, so a plain destructure will not type-check. */
function omit<T extends object>(row: T, keys: readonly string[]): Record<string, unknown> {
  const out = { ...row } as Record<string, unknown>;
  for (const k of keys) delete out[k];
  return out;
}

type Rec = Record<string, unknown>;

/** A stored payload as an object: D1 hands back JSON text, tests hand objects. */
function asRecord(raw: unknown): Rec | null {
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Rec) : null;
}

/** A number, or null for anything that is not one - "", null, "n/a". */
function numOrNull(v: unknown): number | null {
  // Number('  ') is 0, so a blank must be caught before it is converted: a
  // blank alarm counter is "not reported", not SolisCloud saying zero.
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** A short status word, or null. Anything long is not a status word. */
function wordOrNull(v: unknown): string | null {
  if (v === null || v === undefined || typeof v === 'object') return null;
  const s = String(v).trim();
  return s && s.length <= 32 ? s : null;
}

/**
 * The payload fields the dashboard's alerts are built from, as named columns.
 *
 * Each is null when the vendor did not send it, so "SolisCloud says no alarms"
 * (0) and "this is not SolisCloud" (null) stay different. SolarMan's flags read
 * NORMAL until something is wrong; the page decides what is worth a row.
 */
export function vendorSignals(raw: unknown) {
  const r = asRecord(raw) ?? {};
  return {
    alarm_count: numOrNull(r.alarmCount),
    alarm_level: numOrNull(r.alarmLevel),
    warning_status: wordOrNull(r.warningStatus),
    business_warning_status: wordOrNull(r.businessWarningStatus),
    consumer_warning_status: wordOrNull(r.consumerWarningStatus),
    network_status: wordOrNull(r.networkStatus),
  };
}

/**
 * The payload fields the Raw telemetry table may show, reviewed one by one.
 *
 * An allow-list, because the payloads carry far more than measurements. The
 * SolisCloud plant record alone has over four hundred fields, and among the
 * ids and serials sit things no name-based rule would catch: the owner's own
 * notes (remark1-3), free-text extras, third-party platform codes, a logo URL,
 * the plant's time-zone name - which names its city. A field reaches the page
 * only if it is named here; a vendor adding one tomorrow adds nothing to the
 * page until someone reads it and adds it to this list.
 *
 * Each name also allows its unit companion - "power" allows "powerStr" and
 * "powerUnit" - since a figure without its unit reads wrong.
 */
const TELEMETRY_KEYS = new Set([
  // SolisCloud plant record: power, energy by period, and the plant's own counts.
  'power', 'psum', 'state', 'fullHour', 'capacity', 'capacityPercent', 'dip', 'azimuth',
  'dayEnergy', 'monthEnergy', 'yearEnergy', 'allEnergy',
  'alarmCount', 'alarmLevel', 'inverterCount', 'inverterOnlineCount', 'generateDays', 'dataTimestamp',
  'monthCarbonDioxide', 'powerStationAvoidedCo2', 'powerStationAvoidedTce', 'powerStationNumTree',
  'batteryPower', 'batteryPercent', 'batteryCapacitySoc2', 'storageBatteryVoltage', 'batteryCapacityEnergy',
  'batteryChargeEnergy', 'batteryDischargeEnergy', 'batteryTodayChargeEnergy', 'batteryTodayDischargeEnergy',
  'batteryChargeMonthEnergy', 'batteryDischargeMonthEnergy', 'batteryChargeYearEnergy', 'batteryDischargeYearEnergy',
  'batteryChargeTotalEnergy', 'batteryDischargeTotalEnergy', 'batteryTotalChargeEnergy', 'batteryTotalDischargeEnergy',
  'familyLoadPower', 'familyLoadPercent', 'totalLoadPower', 'bypassLoadPower',
  'homeLoadEnergy', 'homeLoadTodayEnergy', 'homeLoadMonthEnergy', 'homeLoadYearEnergy', 'homeLoadTotalEnergy',
  'gridPurchasedEnergy', 'gridPurchasedDayEnergy', 'gridPurchasedMonthEnergy', 'gridPurchasedYearEnergy', 'gridPurchasedTotalEnergy',
  'gridSellEnergy', 'gridSellDayEnergy', 'gridSellMonthEnergy', 'gridSellYearEnergy', 'gridSellTotalEnergy',
  'homeGridTodayEnergy', 'homeGridMonthEnergy', 'homeGridYearEnergy', 'homeGridTotalEnergy',
  'backupTodayEnergy', 'backupMonthEnergy', 'backupYearEnergy', 'backupTotalEnergy',
  // SolisCloud's weather for the plant: conditions, not a place.
  'weather', 'condTxtD', 'condTxtN', 'sr', 'ss', 'tmpMax', 'tmpMin', 'hum', 'pcpn', 'pres',
  'windSpd', 'windDir', 'windSpeed', 'windDirection', 'humidity', 'temp', 'rainfall', 'airPressure',
  // SolarMan station snapshot: power, energy by period, ratios and flags.
  'generationPower', 'usePower', 'wirePower', 'buyPower', 'gridPower', 'chargePower', 'dischargePower',
  'batterySoc', 'batteryStatus', 'wireStatus', 'temperature', 'lastUpdateTime', 'generationCapacity',
  'generationValue', 'useValue', 'gridValue', 'buyValue', 'chargeValue', 'dischargeValue',
  'generationMonth', 'useMonth', 'gridMonth', 'buyMonth', 'chargeMonth', 'dischargeMonth',
  'generationYear', 'useYear', 'gridYear', 'buyYear', 'chargeYear', 'dischargeYear',
  'generationTotal', 'generationUploadTotal', 'useTotal', 'gridTotal', 'buyTotal', 'chargeTotal', 'dischargeTotal',
  'useUploadTotal', 'gridUploadTotal', 'buyUploadTotal', 'chargeUploadTotal', 'dischargeUploadTotal',
  'selfGenAndUseValue', 'selfSufficiencyValue', 'absorbedUseValue', 'genForGrid', 'useFromBuy',
  'generationRatio', 'useRatio', 'gridRatio', 'buyRatio', 'chargeRatio', 'useDischargeRatio',
  'generationRatioMonth', 'useRatioMonth', 'gridRatioMonth', 'buyRatioMonth',
  'generationRatioYear', 'useRatioYear', 'gridRatioYear', 'buyRatioYear',
  'fullPowerHoursDay', 'fullPowerHoursTotal', 'fullPowerYesterdayHours',
  'networkStatus', 'warningStatus', 'businessWarningStatus', 'consumerWarningStatus',
]);

/** "powerStr" and "powerUnit" belong to "power"; anything else is its own field. */
function telemetryKeyAllowed(k: string): boolean {
  if (TELEMETRY_KEYS.has(k)) return true;
  const base = k.replace(/(?:Str|Unit)$/, '');
  return base !== k && TELEMETRY_KEYS.has(base);
}

/**
 * The payload as a table of measurements, for the Raw telemetry table.
 *
 * A field is kept only if it is on the reviewed list above, and then only if
 * its value is a plain number, a boolean or a short string - no nested
 * objects, no text long enough to be a note, nothing that looks like an
 * address or a link. The value checks are a second line: a reviewed field
 * that one day carries something odd is still dropped.
 *
 * Returned as JSON text, like `metrics`, or null when nothing survives.
 */
export function safeTelemetry(raw: unknown): string | null {
  const r = asRecord(raw);
  if (!r) return null;
  const out: Rec = {};
  for (const [k, v] of Object.entries(r)) {
    if (!telemetryKeyAllowed(k)) continue;
    if (v === null || typeof v === 'boolean') { out[k] = v; continue; }
    if (typeof v === 'number') {
      if (Number.isFinite(v)) out[k] = v;
      continue;
    }
    if (typeof v === 'string') {
      if (v.length > 40 || /@|https?:|www\./i.test(v)) continue;
      out[k] = v;
    }
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

/**
 * Inverter rows for a public response: the vendor and plant ids and the raw
 * payload dropped, the id replaced by its alias, the serial masked to four,
 * and the payload's alert fields and measurements added in its place.
 */
export function publicInverters<T extends { id: string; serial?: string | null; raw?: unknown }>(
  rows: T[],
  alias: Alias,
) {
  return rows.map((r) => ({
    ...omit(r, ['vendor_id', 'plant_id', 'serial', 'raw']),
    id: alias(r.id),
    serial: maskSerial(r.serial),
    ...vendorSignals(r.raw),
    telemetry: safeTelemetry(r.raw),
  }));
}

/**
 * A public id for each device: its system's alias, its kind and its place
 * among that system's devices of that kind - "s1-datalogger-1".
 *
 * A device's own id carries its serial ("soliscloud:datalogger:<sn>"), so it
 * cannot go out, and until 3.0 every device went out as "unknown": harmless
 * while nothing joined on it, but a public answer that does not say which
 * device is which is one the page cannot build on. So each device gets a
 * positional alias the same way systems do. The rows must come in a
 * stable order - listDevices sorts them - for the alias to stay put between
 * calls.
 */
export function deviceAliasFor<T extends { id: string; kind?: string | null; plant_id?: string | null }>(
  rows: T[],
  alias: Alias,
): Alias {
  const map = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const r of rows) {
    const group = `${alias(r.plant_id) ?? 'unknown'}-${r.kind ?? 'device'}`;
    const n = (seen.get(group) ?? 0) + 1;
    seen.set(group, n);
    map.set(r.id, `${group}-${n}`);
  }
  return (id) => (id == null ? null : (map.get(id) ?? 'unknown'));
}

/**
 * Device rows for a public response, stripped and aliased the same way. The one
 * payload field the page reads - SolarMan's own alert count on a device record,
 * where -1 means "nothing to report" - comes across as `alert_status`. The
 * `network` column (a logger's operator and cell, or its MAC address) is left
 * out: it can place a logger on a map.
 */
export function publicDevices<T extends { id: string; kind?: string | null; sn?: string | null; plant_id?: string | null; raw?: unknown }>(
  rows: T[],
  alias: Alias,
) {
  const deviceAlias = deviceAliasFor(rows, alias);
  return rows.map((r) => ({
    ...omit(r, ['raw', 'sn', 'plant_id', 'network']),
    id: deviceAlias(r.id),
    plant_id: alias(r.plant_id),
    sn: maskSerial(r.sn),
    alert_status: numOrNull(asRecord(r.raw)?.alertStatus),
  }));
}

/** Link history rows, under the same device aliases publicDevices gives. */
export function publicDeviceSamples<T extends { device_id: string }>(rows: T[], deviceAlias: Alias) {
  return rows.map((r) => ({ ...r, device_id: deviceAlias(r.device_id) }));
}


/** Series and daily rows carry only an inverter_id worth hiding. */
export function publicRows<T extends { inverter_id: string }>(rows: T[], alias: Alias) {
  return rows.map((r) => ({ ...r, inverter_id: alias(r.inverter_id) }));
}

/**
 * Alarms for a public response.
 *
 * An alarm's own id is provider:plant:code:start, which makes re-reading the
 * same alarm update it rather than duplicate it - and which also spells out the
 * vendor's plant id. So the id stays in the database and never leaves: the page
 * keys an alarm by its system, code and start time, which it has anyway.
 */
export function publicAlarms<T extends { id: string; inverter_id: string }>(rows: T[], alias: Alias) {
  return rows.map((r) => ({ ...omit(r, ['id']), inverter_id: alias(r.inverter_id) }));
}

/**
 * Relays for a public response.
 *
 * The relay's own id stays in the database. Each relay is named by the
 * nickname its owner gave it, or by its order - "Relay 1", "Relay 2" - counted
 * over every relay listed, so a relay keeps its number while it keeps reporting.
 */
export function publicRelays<T extends { id: string; name: string | null }>(rows: T[]) {
  return rows.map((r, i) => ({ ...omit(r, ['id']), name: r.name || `Relay ${i + 1}` }));
}
