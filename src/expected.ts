/**
 * What each system should be making, given the sunlight it has had.
 *
 * A system's output is its size, times the sunlight on it, times how well it
 * turns one into the other - its performance ratio, which the panels' tilt and
 * facing, their shading, their age and the inverter's losses all fold into. The
 * vendors report none of that, so it is learned: over the last fourteen full
 * days, the energy each day made against the sunlight that fell that day
 * (weather_hourly, from Open-Meteo), per kWp of panels. The median of those
 * days is the ratio - the median, so one day of snow on the panels or one
 * cloudburst the weather service placed a few kilometres off does not move it.
 *
 * Only days worth learning from count: a full day of readings (a morning the
 * relay missed would read as poor output), and at least one kWh of sunlight per
 * square metre (an overcast day's ratio is mostly noise). Until three such days
 * exist, a typical ratio stands in, and the answer says so.
 *
 * Today's expected curve is then the sunlight hour by hour times the size times
 * the ratio, and the page draws it behind the real one.
 */
import { daily, dayStartSec, nowSec } from './db';
import { weatherSince } from './weather';

/** What a well-sited system turns sunlight into, before anything is learned. */
export const TYPICAL_RATIO = 0.8;
/** How many full days the ratio is learned from, and how few will do. */
export const LEARN_DAYS = 14;
export const MIN_DAYS = 3;
/** A day darker than this, in kWh of sunlight per m2, teaches nothing reliable. */
export const MIN_SUN_KWH_M2 = 1;
/** A day with fewer readings than this is not a full day. */
export const MIN_SAMPLES = 60;

export interface ExpectedToday {
  inverter_id: string;
  /** kWh per (kWh/m2 of sunlight x kWp): what this system makes of the sun. */
  ratio: number;
  /** Whether that ratio was learned, and from how many days; false is the typical one. */
  learned: boolean;
  days: number;
  /** Today so far: the sunlight's kWh/m2, and what the system should have made from it. */
  sun_kwh_m2: number;
  expected_kwh: number;
  /** Hour by hour: the end of each hour, and the average power expected over it. */
  hours: { ts: number; expected_w: number }[];
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Each system with a size and some weather: its ratio, and today's expected
 * output. `systems` gives each one's size and its plant's UTC offset, which is
 * where its days begin.
 */
export async function expectedToday(
  db: D1Database,
  systems: { id: string; capacity_w: number | null; tz_offset_sec: number | null }[],
  now = nowSec(),
): Promise<ExpectedToday[]> {
  const from = now - (LEARN_DAYS + 1) * 86400;
  const [weather, days] = await Promise.all([weatherSince(db, from), daily(db, from, now, 0)]);
  const out: ExpectedToday[] = [];
  for (const sys of systems) {
    const kwp = (sys.capacity_w ?? 0) / 1000;
    const hours = weather.filter((w) => w.inverter_id === sys.id && w.ghi_wm2 != null);
    if (!kwp || !hours.length) continue;
    const tz = sys.tz_offset_sec ?? 0;
    const today = dayStartSec(now, tz);
    // Each hour belongs to the plant's day its middle falls in.
    const dayOf = (ts: number) => new Date((ts - 1800 + tz) * 1000).toISOString().slice(0, 10);
    const sun = new Map<string, number>();
    for (const h of hours) sun.set(dayOf(h.ts), (sun.get(dayOf(h.ts)) ?? 0) + (h.ghi_wm2 as number) / 1000);

    const ratios = days
      .filter((d) => d.inverter_id === sys.id && d.day !== dayOf(now + 1800) && d.yield_kwh != null && d.samples >= MIN_SAMPLES)
      .map((d) => ({ y: d.yield_kwh as number, h: sun.get(d.day) ?? 0 }))
      .filter((d) => d.h >= MIN_SUN_KWH_M2 && d.y > 0)
      .map((d) => d.y / (d.h * kwp))
      // A ratio past 1.2 is a misplaced cloud, not a system beating physics.
      .filter((r) => r <= 1.2);
    const learned = ratios.length >= MIN_DAYS;
    const ratio = learned ? median(ratios) : TYPICAL_RATIO;

    const todays = hours.filter((h) => h.ts > today && h.ts <= now);
    const sunToday = todays.reduce((a, h) => a + (h.ghi_wm2 as number) / 1000, 0);
    out.push({
      inverter_id: sys.id,
      ratio: Math.round(ratio * 1000) / 1000,
      learned,
      days: ratios.length,
      sun_kwh_m2: Math.round(sunToday * 100) / 100,
      expected_kwh: Math.round(sunToday * kwp * ratio * 10) / 10,
      hours: todays.map((h) => ({ ts: h.ts, expected_w: Math.round((h.ghi_wm2 as number) * kwp * ratio) })),
    });
  }
  return out;
}
