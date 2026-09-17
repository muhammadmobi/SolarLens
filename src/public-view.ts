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
 * `raw` never leaves the server at all. It is the vendor payload kept for
 * debugging, stripPii has already been over it, and "already stripped" is a
 * poor reason to publish something nobody is going to read.
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

export function publicInverters<T extends { id: string; serial?: string | null }>(
  rows: T[],
  alias: Alias,
) {
  return rows.map((r) => ({
    ...omit(r, ['vendor_id', 'plant_id', 'serial', 'raw']),
    id: alias(r.id),
    serial: maskSerial(r.serial),
  }));
}

export function publicDevices<T extends { id: string; sn?: string | null; plant_id?: string | null }>(
  rows: T[],
  alias: Alias,
) {
  return rows.map((r) => ({
    ...omit(r, ['raw', 'sn', 'plant_id']),
    id: alias(r.id),
    plant_id: alias(r.plant_id),
    sn: maskSerial(r.sn),
  }));
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
