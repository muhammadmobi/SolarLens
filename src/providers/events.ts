/**
 * Fault history and the vendors' own period totals, normalised.
 *
 * Both are read from the portals' web APIs, not the documented monitoring APIs:
 * neither of those exposes an owner's alarm history or a plant's month-by-month
 * yield. The shapes below are the ones recorded from live owner accounts in
 * September 2026, and every field that is not listed here is dropped on the way
 * in - an alarm record from SolisCloud carries the owner's address, phone,
 * email and region alongside the fault, and none of that is wanted.
 */
import type { ProviderId } from './types';
import { num, toEpochSeconds, toKwh } from './units';

export type Severity = 'info' | 'warning' | 'fault';

export interface Alarm {
  /** provider:plant:code:begin - stable, so re-reading the same alarm updates it. */
  id: string;
  inverterId: string;
  provider: ProviderId;
  code: string;
  message: string | null;
  severity: Severity | null;
  /** The vendor's own level, kept because the mapping to severity is partly inferred. */
  vendorLevel: number | null;
  /** What the vendor says to do about it, where it says anything. */
  advice: string | null;
  beginTs: number;
  endTs: number | null;
  /** 'unknown' where the vendor records when a fault began but never when it ended. */
  state: 'active' | 'recovered' | 'unknown';
}

export type PeriodKind = 'day' | 'month' | 'year';

export interface Period {
  inverterId: string;
  period: PeriodKind;
  /** 2026-09-01, 2026-09 or 2026: the period in the plant's own calendar. */
  key: string;
  yieldKwh: number | null;
  loadKwh: number | null;
  importKwh: number | null;
  exportKwh: number | null;
  chargeKwh: number | null;
  dischargeKwh: number | null;
  fullHours: number | null;
  source: string;
}

type Rec = Record<string, unknown>;

// The inverter id a plant-level unit is stored under, and a vendor string
// trimmed to null when it is empty.
const stationId = (provider: ProviderId, plantId: string) => `${provider}:station:${plantId}`;
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * SolisCloud severity. The portal's own alarm table prints level 1 as "Info"
 * and level 2 as "Warning"; that much was read off the page. Level 3 is not in
 * this owner's two years of history and is taken to be the step above.
 */
const SOLIS_SEVERITY: Record<number, Severity> = { 1: 'info', 2: 'warning', 3: 'fault' };

/** SolisCloud alarm state, as the status filter offers it: Active, Acknowledged, Recovered. */
const SOLIS_STATE: Record<string, Alarm['state']> = { '0': 'active', '1': 'active', '2': 'recovered' };

/** One record from POST /api/alarm/list. */
export function solisAlarm(plantId: string, rec: Rec): Alarm | null {
  const code = text(rec.alarmCode) ?? (rec.alarmCode != null ? String(rec.alarmCode) : null);
  const begin = num(rec.alarmBeginTime);
  if (!code || !begin) return null;
  const beginTs = toEpochSeconds(begin);
  const end = num(rec.alarmEndTime);
  const level = num(rec.alarmLevel);
  return {
    id: `soliscloud:${plantId}:${code}:${beginTs}`,
    inverterId: stationId('soliscloud', plantId),
    provider: 'soliscloud',
    code,
    message: text(rec.alarmMsg),
    severity: level === null ? null : SOLIS_SEVERITY[level] ?? null,
    vendorLevel: level,
    advice: text(rec.advice),
    beginTs,
    endTs: end ? toEpochSeconds(end) : null,
    state: SOLIS_STATE[String(rec.state)] ?? (end ? 'recovered' : 'unknown'),
  };
}

/**
 * SolarMan severity. Only level 2 has been seen, on a fault named
 * "F56DC_VoltLow_Fault", so 2 is a fault; 0 and 1 are assumed to be the two
 * steps below it. The vendor's number is stored beside this for that reason.
 */
const SOLARMAN_SEVERITY: Record<number, Severity> = { 0: 'info', 1: 'warning', 2: 'fault' };

/**
 * SolarMan names a fault like "F56DC_VoltLow_Fault". Printed as-is it reads as
 * a register dump, so the prefix code and the underscores go, and the words the
 * vendor ran together are split: "DC volt low fault".
 */
export function readableFaultName(name: string): string {
  return name
    .replace(/^F\d+(?=[A-Z])/, '')
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/(?<=\s)([A-Z][a-z]+)/g, (w) => w.toLowerCase());
}

/** One record from POST /maintain-s/operating/alert/search. */
export function solarmanAlert(plantId: string, rec: Rec): Alarm | null {
  const code = rec.code != null ? String(rec.code) : null;
  const at = num(rec.alertTime);
  if (!code || !at) return null;
  const beginTs = toEpochSeconds(at);
  const level = num(rec.level);
  const name = text(rec.showName);
  return {
    id: `solarman:${plantId}:${code}:${beginTs}`,
    inverterId: stationId('solarman', plantId),
    provider: 'solarman',
    code,
    message: name ? readableFaultName(name) : null,
    severity: level === null ? null : SOLARMAN_SEVERITY[level] ?? null,
    vendorLevel: level,
    // SolarMan has no remediation text at all; saying nothing beats inventing some.
    advice: null,
    beginTs,
    // The alert list records when a fault was raised, never when it cleared.
    endTs: null,
    state: 'unknown',
  };
}

/**
 * SolarMan's advice for an alert, from its detail call: one line per
 * `solution`, which is all the portal itself shows. Most faults carry none,
 * and then this says nothing rather than something invented.
 */
export function solarmanAdvice(detail: Rec | null | undefined): string | null {
  if (!detail) return null;
  const reasons = Array.isArray(detail.customAlertConfigDisplayReason) ? (detail.customAlertConfigDisplayReason as Rec[]) : [];
  const lines = reasons
    .flatMap((r) => (typeof r.solution === 'string' ? r.solution.split(/\r?\n/) : []))
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length) return lines.join('\n');
  const display = detail.customAlertConfigDisplay as Rec | null | undefined;
  return text(display?.description) ?? null;
}

/** SolarMan samples every five minutes, so a gap longer than that ends a run. */
const SAMPLE_GAP_S = 300;

/**
 * Every occurrence of one SolarMan alert on one day, from its timeline.
 *
 * The alert list keeps a single entry per fault per day, and never says when
 * it cleared. The timeline says more: the moments that day when the fault was
 * active, sampled every five minutes. A run of samples no more than five
 * minutes apart is one occurrence; it began at the first and had cleared by the
 * next sample after the last - which is exactly how SolarMan's own chart draws
 * it. So the history gains the earlier occurrences the list leaves out, and
 * each gains an end.
 *
 * Two cases are left unclaimed rather than guessed. A run whose last sample is
 * recent may still be going on, so it is `active` with no end. A run that
 * reaches the end of the day may carry on into the next, which this timeline
 * cannot see, so its end is left unknown.
 *
 * The run containing the listed alert keeps the id the list alone would have
 * given it, so an alert already stored is completed rather than duplicated.
 */
export function solarmanOccurrences(
  plantId: string,
  rec: Rec,
  points: unknown,
  advice: string | null,
  dayEndTs: number,
  nowTs: number,
): Alarm[] {
  const listed = solarmanAlert(plantId, rec);
  if (!listed) return [];
  const ts = [...new Set((Array.isArray(points) ? points : []).map((p) => num(p)).filter((p): p is number => p !== null).map(toEpochSeconds))]
    .sort((a, b) => a - b);
  if (!ts.length) return [{ ...listed, advice }];

  // Group the sorted samples into runs: a gap longer than one sample
  // interval starts a new occurrence.
  const runs: Array<[number, number]> = [];
  for (const t of ts) {
    const last = runs[runs.length - 1];
    if (last && t - last[1] <= SAMPLE_GAP_S) last[1] = t;
    else runs.push([t, t]);
  }

  // Each run becomes one alarm, with an end only when it can be told honestly.
  const out = runs.map(([first, last]): Alarm => {
    const holdsListed = listed.beginTs >= first && listed.beginTs <= last;
    const stillGoing = nowTs - last <= 2 * SAMPLE_GAP_S;
    const intoTomorrow = dayEndTs - last <= SAMPLE_GAP_S;
    return {
      ...listed,
      id: holdsListed ? listed.id : `solarman:${plantId}:${listed.code}:${first}`,
      advice,
      beginTs: first,
      endTs: stillGoing || intoTomorrow ? null : last + SAMPLE_GAP_S,
      state: stillGoing ? 'active' : intoTomorrow ? 'unknown' : 'recovered',
    };
  });
  // The timeline and the list should agree; where they do not, the list's own
  // entry is still an alert that happened, so it is kept as it was.
  if (!out.some((a) => a.id === listed.id)) out.push({ ...listed, advice });
  return out;
}

const kind = (k: 'month' | 'year' | 'all'): PeriodKind => (k === 'month' ? 'day' : k === 'year' ? 'month' : 'year');

/**
 * Points from POST /api/chart/station/month (one per day), /year (one per
 * month) or /all (one per year).
 *
 * An on-grid plant with no meter reports its generation copied into household
 * load and every grid figure as zero, exactly as its live snapshot does. None of
 * that is a measurement, so load and grid are kept only when the payload shows
 * a grid figure that is not zero somewhere - which a metered plant always will
 * over a month - and battery figures only for a plant that has a battery.
 */
export function solisPeriods(plantId: string, which: 'month' | 'year' | 'all', points: Rec[]): Period[] {
  const metered = points.some((p) => (num(p.gridPurchasedEnergy) ?? 0) > 0 || (num(p.gridSellEnergy) ?? 0) > 0);
  const battery = points.some((p) => p.isEnergyStorage === true
    || (num(p.batteryChargeEnergy) ?? 0) > 0 || (num(p.batteryDischargeEnergy) ?? 0) > 0);
  const out: Period[] = [];
  for (const p of points) {
    const key = text(p.dateStr) ?? (which === 'all' && p.year != null ? String(p.year) : null);
    if (!key) continue;
    out.push({
      inverterId: stationId('soliscloud', plantId),
      period: kind(which),
      key,
      // energyStr is the only unit the payload names; the rest are kWh.
      yieldKwh: toKwh(p.energy, p.energyStr),
      loadKwh: metered ? num(p.consumeEnergy) : null,
      importKwh: metered ? num(p.gridPurchasedEnergy) : null,
      exportKwh: metered ? num(p.gridSellEnergy) : null,
      chargeKwh: battery ? num(p.batteryChargeEnergy) : null,
      dischargeKwh: battery ? num(p.batteryDischargeEnergy) : null,
      fullHours: num(p.fullHour),
      source: 'soliscloud-portal',
    });
  }
  return out;
}

/** A month or day as two digits, for period keys like 2026-09. */
const pad = (n: unknown) => String(n).padStart(2, '0');

/**
 * Records from GET /maintain-s/history/batteryPower/{plant}/stats/month (one per
 * day) or /stats/year (one per month). SolarMan names these after the battery,
 * but they carry the whole system: generation, consumption, grid both ways and
 * the battery's own in and out.
 */
export function solarmanPeriods(
  plantId: string,
  which: 'month' | 'year',
  year: number,
  records: Rec[],
): Period[] {
  const out: Period[] = [];
  for (const r of records) {
    const month = num(r.month);
    const day = num(r.day);
    const key = which === 'month'
      ? (month && day ? `${year}-${pad(month)}-${pad(day)}` : null)
      : (month ? `${year}-${pad(month)}` : null);
    if (!key) continue;
    out.push({
      inverterId: stationId('solarman', plantId),
      period: which === 'month' ? 'day' : 'month',
      key,
      yieldKwh: num(r.generationValue),
      loadKwh: num(r.useValue),
      importKwh: num(r.buyValue),
      exportKwh: num(r.gridValue),
      chargeKwh: num(r.chargeValue),
      dischargeKwh: num(r.dischargeValue),
      fullHours: num(r.fullPowerHoursDay),
      source: 'solarman-web',
    });
  }
  return out;
}
