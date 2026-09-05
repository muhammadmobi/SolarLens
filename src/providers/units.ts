/**
 * SolisCloud returns a bare number plus a separate unit string (`pac` + `pacStr`),
 * and the unit genuinely varies by inverter size — a 3.5 kW reading and a 3500 W
 * reading are the same power. Everything below normalises to W and kWh so the
 * rest of the app never has to think about it again.
 */

const POWER_FACTORS: Record<string, number> = {
  w: 1,
  kw: 1_000,
  mw: 1_000_000,
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
