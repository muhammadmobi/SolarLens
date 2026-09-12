/**
 * SolisCloud returns a bare number plus a separate unit string (`pac` + `pacStr`),
 * and the unit genuinely varies by inverter size — a 3.5 kW reading and a 3500 W
 * reading are the same power. Everything below normalises to W and kWh so the
 * rest of the app never has to think about it again.
 */

// SolisCloud reports plant capacity as `capacity: 12.000, capacityStr: "kWp"`.
const POWER_FACTORS: Record<string, number> = {
  w: 1,
  wp: 1,
  kw: 1_000,
  kwp: 1_000,
  mw: 1_000_000,
  mwp: 1_000_000,
  gw: 1_000_000_000,
};

const ENERGY_FACTORS: Record<string, number> = {
  wh: 0.001,
  kwh: 1,
  mwh: 1_000,
  gwh: 1_000_000,
};

function clean(unit: unknown): string {
  return String(unit ?? '').trim().toLowerCase();
}

export function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Scale a vendor power value to watts using its companion unit string. */
export function toWatts(value: unknown, unit?: unknown): number | null {
  const n = num(value);
  if (n === null) return null;
  const factor = POWER_FACTORS[clean(unit)];
  // No unit given: assume the vendor already used watts rather than silently
  // inventing a 1000x error.
  return factor === undefined ? n : n * factor;
}

/** Scale a vendor energy value to kWh using its companion unit string. */
export function toKwh(value: unknown, unit?: unknown): number | null {
  const n = num(value);
  if (n === null) return null;
  const factor = ENERGY_FACTORS[clean(unit)];
  return factor === undefined ? n : n * factor;
}

/** Vendor timestamps arrive as epoch ms (sometimes stringified). */
export function toEpochSeconds(value: unknown, fallback = Date.now()): number {
  const n = num(value);
  if (n === null || n <= 0) return Math.floor(fallback / 1000);
  // Anything past ~2001 in ms range is milliseconds; smaller is already seconds.
  return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
}

/** First non-null lookup across candidate keys — vendors rename fields between versions. */
export function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return null;
}

/**
 * The plant's own UTC offset in seconds, from whatever shape the vendor used.
 *
 * A solar day ends at the array's midnight, not the viewer's, and the two are
 * the same only while you are sitting in the same country as the panels. Three
 * shapes turn up across the two portals and their web APIs:
 *
 *   timeZone: 5                 whole hours, SolisCloud's inverter list
 *   timeZoneOffset: 18000       seconds, SolarMan's station detail
 *   timezone: "Asia/Karachi"    IANA name, SolarMan's station search
 *
 * The named zone is resolved for *now* rather than for the sample's own
 * instant, which is the right call here: these offsets are read when a plant is
 * discovered and stored as a constant, and a zone with daylight saving would be
 * wrong for half the year either way. Plants in DST zones are the known limit
 * of this, and the offset is refreshed on every poll, so the error lasts until
 * the next poll rather than until the next re-import.
 */
export function tzOffsetSec(rec: Record<string, unknown>): number | null {
  const secs = num(pick(rec, 'timeZoneOffset'));
  if (secs !== null && Math.abs(secs) <= 15 * 3600) return Math.round(secs);

  const hours = num(pick(rec, 'timeZone'));
  if (hours !== null && Math.abs(hours) <= 15) return Math.round(hours * 3600);

  const name = pick(rec, 'timezone', 'regionTimezone', 'timeZoneStandardId');
  if (typeof name === 'string' && name.includes('/')) return offsetOfZone(name);

  return null;
}

/** UTC offset of an IANA zone right now, or null when the runtime rejects it. */
function offsetOfZone(zone: string): number | null {
  try {
    // longOffset gives "GMT+05:00" / "GMT-03:30" / bare "GMT" at zero.
    const label = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')?.value;
    if (!label) return null;
    const m = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/.exec(label);
    if (!m) return null;
    if (!m[1]) return 0;
    const secs = Number(m[2]) * 3600 + Number(m[3] ?? 0) * 60;
    return m[1] === '-' ? -secs : secs;
  } catch {
    return null;
  }
}
