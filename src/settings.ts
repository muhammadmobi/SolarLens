/**
 * The owner's settings, starting with the tariff.
 *
 * Money saved and carbon avoided are the two questions a solar owner asks
 * most, and neither vendor answers them for this dashboard: they depend on
 * what the owner pays for a kWh, what the grid pays for one exported, and how
 * the local grid makes its electricity. The owner fills those in under
 * Settings; until then the page shows no money at all rather than a guess.
 *
 * The page does the sums (public/index.html, valueOf) from the figures it
 * already has, so this file only keeps the numbers and holds them to sense:
 * a price is a number from 0 to 1000 in the owner's own currency, the currency
 * a three-letter code, the carbon figure 0 to 2 kg per kWh.
 *
 * Second, the groups the owner sorts the systems into ("Home", "Farm"), which
 * the Overview shows each under its own heading. They are kept against each
 * system's real id and served under its alias: an alias is a position in a
 * sorted list, so a system added later could move it, and a group kept by
 * alias would then follow the wrong system.
 */
import { nowSec } from './db';

export interface Tariff {
  /** ISO 4217 code, as the page formats money with it: "PKR", "EUR", "GBP". */
  currency: string;
  /** What a kWh from the grid costs. */
  importPrice: number;
  /** What a kWh sent to the grid earns - the feed-in rate. */
  exportPrice: number;
  /** Net metering: each kWh exported offsets one bought, so it is worth the import price. */
  netMetering: boolean;
  /** kg of CO2 a kWh from the grid stands for, which each kWh made here avoids. */
  co2KgPerKwh: number;
}

/** A price, a number within reason, or null. */
const within = (v: unknown, max: number): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= max ? n : null;
};

/** A tariff from what the Settings form sent, or the reason it is not one. */
export function parseTariff(body: unknown): { tariff: Tariff } | { error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const currency = typeof b.currency === 'string' ? b.currency.trim().toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(currency)) return { error: 'The currency is a three-letter code, such as PKR, EUR or GBP.' };
  const importPrice = within(b.importPrice, 1000);
  if (importPrice === null) return { error: 'The price of a kWh bought is a number from 0 to 1000.' };
  const exportPrice = within(b.exportPrice, 1000);
  if (exportPrice === null) return { error: 'The price of a kWh sold is a number from 0 to 1000.' };
  const co2KgPerKwh = within(b.co2KgPerKwh, 2);
  if (co2KgPerKwh === null) return { error: 'The CO₂ for a kWh from the grid is a number of kg from 0 to 2.' };
  return { tariff: { currency, importPrice, exportPrice, netMetering: b.netMetering === true, co2KgPerKwh } };
}

/** The most groups there may be, and the longest a group's name may be. */
export const MAX_GROUPS = 20;
export const GROUP_NAME_MAX = 40;

/**
 * Groups from what the Settings form sent - `{ s1: 'Home', s2: '' }`, by alias -
 * as a map from each system's real id to its group, or the reason it is not
 * one. A blank name takes a system out of every group. `idOf` turns an alias
 * back into the id it stands for, or null for an alias no system has.
 */
export function parseGroups(body: unknown, idOf: (alias: string) => string | null): { groups: Record<string, string> } | { error: string } {
  const raw = body && typeof body === 'object' ? (body as { groups?: unknown }).groups : undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Send the groups as { "groups": { "s1": "Home" } }.' };
  const groups: Record<string, string> = {};
  for (const [alias, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = idOf(alias);
    if (!id) return { error: `There is no system ${alias.slice(0, 12)}.` };
    if (value !== null && typeof value !== 'string') return { error: 'A group name is text.' };
    // Control characters and runs of spaces would only make two names that
    // look the same different groups.
    const name = (value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
    if (name.length > GROUP_NAME_MAX) return { error: `A group name is at most ${GROUP_NAME_MAX} characters.` };
    if (name) groups[id] = name;
  }
  if (new Set(Object.values(groups)).size > MAX_GROUPS) return { error: `There can be at most ${MAX_GROUPS} groups.` };
  return { groups };
}

/** Each system's group, by real id; a system in none is not in the map. */
export async function getGroups(db: D1Database): Promise<Record<string, string>> {
  const row = await db.prepare("SELECT v FROM app_settings WHERE k = 'groups'").first<{ v: string }>();
  if (!row) return {};
  try {
    const v = JSON.parse(row.v) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch { return {}; }
}

export async function setGroups(db: D1Database, groups: Record<string, string>, at = nowSec()): Promise<void> {
  await db
    .prepare(
      `INSERT INTO app_settings (k, v, updated_at) VALUES ('groups', ?1, ?2)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
    )
    .bind(JSON.stringify(groups), at)
    .run();
}

export async function getTariff(db: D1Database): Promise<Tariff | null> {
  const row = await db.prepare("SELECT v FROM app_settings WHERE k = 'tariff'").first<{ v: string }>();
  if (!row) return null;
  try { return JSON.parse(row.v) as Tariff; } catch { return null; }
}

export async function setTariff(db: D1Database, tariff: Tariff | null, at = nowSec()): Promise<void> {
  if (!tariff) {
    await db.prepare("DELETE FROM app_settings WHERE k = 'tariff'").run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO app_settings (k, v, updated_at) VALUES ('tariff', ?1, ?2)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
    )
    .bind(JSON.stringify(tariff), at)
    .run();
}
