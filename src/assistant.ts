/**
 * The assistant: a conversation about SolarLens and its figures - questions in
 * plain words and their follow-ups, statistics, reports, and how to use the app.
 *
 * It grows out of Ask SolarLens and keeps its one rule: the model chooses and
 * words; the Worker computes. A turn goes:
 *
 * 1. **Understanding.** The model is shown the conversation so far, the tools
 *    (./tools), the systems and today, and answers with up to three tool calls
 *    - "compare this month with last" is two - or with a short reply of its own
 *    for a greeting, or a question it must ask back. Without a model - none set
 *    up, none left today, or a caller who may not spend one - SolarLens reads
 *    the question itself (guessCalls): the kind of question, the period and the
 *    system from its words, and a follow-up from the turn before.
 * 2. **Computing.** Each call runs, its arguments checked like any input.
 * 3. **Wording.** The model puts the figures in words - a sentence or two, or a
 *    short report - and is held to them (numbersAgree). The figures' own
 *    sentences stand in when it strays, or when there is no model.
 *
 * Every answer comes with the figures it used, the period each covers and how
 * fresh the data was. The conversation lives in the browser: the Worker keeps
 * none of it, and is sent the last few turns with each message.
 */
import { aiModel, callsUsed, chat, dailyCalls, hasAi, providerOf, takeCall, type ChatMessage, type Provider } from './ai';
import { nowSec, type Env } from './db';
import { findHelp } from './help';
import {
  DEFAULT_RANGE, RANGES, TOOLS, dayNo, dayWords, isoDay, jsonSchemaOf, loadSystems, resolvePeriod, runTool, zoneOf,
  type Args, type Period, type Range, type Sys, type ToolResult,
} from './tools';

/** The longest message taken, and how many earlier turns are read with it. */
export const MESSAGE_MAX = 500;
export const HISTORY_TURNS = 8;
/** At most this many tools a turn: enough to compare two periods and look up one more thing. */
export const MAX_CALLS = 3;
/** Rows of each result a model is shown; the facts and the summary carry the rest. */
const ROWS_SHOWN = 24;

export interface Call { tool: string; args: Args }
export interface Turn { role: 'user' | 'assistant'; content: string; calls?: Call[] }

export interface Reply {
  answer: string;
  /** Who put the answer in words: the model, or SolarLens from the figures alone. */
  worded: 'model' | 'solarlens';
  /** Who worked out what the question asked: the model, or SolarLens reading it itself. */
  understood: 'model' | 'solarlens';
  kind: 'figures' | 'report' | 'help' | 'chat';
  calls: Call[];
  results: ToolResult[];
  /** Calls that could not run, and why - a system nobody has, a period not begun. */
  errors: string[];
  used: number;
  limit: number;
  model: string | null;
  provider: Provider | null;
}

// ---------------------------------------------------------------- holding words to the figures

/** Every number written in a piece of text: "1,234.5" is 1234.5, "21 Sep" has a 21. */
export function numbersIn(text: string): number[] {
  return (text.match(/-?\d+(?:[.,]\d+)*/g) ?? [])
    .map((t) => Math.abs(Number(t.replace(/,(?=\d{3}(\D|$))/g, '').replace(',', '.'))))
    .filter((n) => Number.isFinite(n));
}

/**
 * Whether every number in `answer` is one the figures gave - as written,
 * rounded as a person would say it, or as MWh - or one the conversation itself
 * holds. Counts up to ten pass as they are: "two of the three systems".
 */
export function numbersAgree(answer: string, results: ToolResult | ToolResult[], alsoKnown = ''): boolean {
  const list = Array.isArray(results) ? results : [results];
  const known = numbersIn(JSON.stringify(list.map((r) => ({ ...r, rows: r.rows.slice(0, ROWS_SHOWN) }))) + alsoKnown);
  return numbersIn(answer).every((n) => {
    if (Number.isInteger(n) && n <= 10) return true;
    return known.some((k) => Math.abs(k - n) <= Math.max(0.51, Math.abs(k) * 0.006)
      || (k >= 1000 && Math.abs(k / 1000 - n) <= Math.max(0.051, (k / 1000) * 0.006)));
  });
}

// ---------------------------------------------------------------- reading a question without a model

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const pad = (n: number) => String(n).padStart(2, '0');
const lastOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/**
 * The words the reader routes on, so that a near miss - "genration",
 * "fluctarion", "septmber", "yesterady" - is read as the word meant. Chosen
 * because nothing common in English sits near them: a general spell-mender
 * would read "expected" as "exported", or "warning" as "morning". A word of
 * five or six letters may be one letter out, a longer one two.
 */
const MENDABLE = [
  'generation', 'generated', 'generating', 'production', 'produced', 'producing', 'fluctuation', 'fluctuations', 'fluctuating',
  'yesterday', 'statistics', 'comparison', 'consumption', 'inverter', 'afternoon', 'between', 'battery',
  'january', 'february', 'august', 'september', 'october', 'november', 'december',
];

/** Short forms written for speed, as whole words: "wk", "yday", "avg", "batt". */
const SHORT: Record<string, string> = {
  wk: 'week', wks: 'weeks', mth: 'month', mnth: 'month', mths: 'months', yr: 'year', yrs: 'years', tdy: 'today', tody: 'today', '2day': 'today',
  yday: 'yesterday', yest: 'yesterday', tmrw: 'tomorrow', tmr: 'tomorrow', avg: 'average', prod: 'production', gen: 'generation', cons: 'consumption',
  consump: 'consumption', elec: 'electricity', batt: 'battery', bat: 'battery', hrs: 'hours', hr: 'hour', ur: 'your', u: 'you', pls: 'please', plz: 'please',
  exp: 'export', imp: 'import', temp: 'temperature', stats: 'statistics', info: 'information', b4: 'before',
};

/** How many letters apart two words are - added, dropped, changed, or two side by side swapped - or more than most when further. */
function distance(a: string, b: string, most: number): number {
  if (Math.abs(a.length - b.length) > most) return most + 1;
  let before: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      // "expotr" is "export" with two letters swapped: one slip, not two.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], before[j - 2] + 1);
      best = Math.min(best, cur[j]);
    }
    if (best > most) return most + 1;
    before = prev;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * A question as the reader takes it: lower case, "p.m." as "pm", short forms written out, and near misses
 * of the words it routes on mended.
 */
export function mend(text: string): string {
  return text.toLowerCase().replace(/\b([ap])\.\s?m\b\.?/g, '$1m')
    .replace(/\b[a-z0-9]+\b/g, (w) => SHORT[w] ?? w)
    .replace(/[a-z]{5,}/g, (w) => {
    if (MENDABLE.includes(w)) return w;
    const most = w.length >= 7 ? 2 : 1;
    let best = w;
    let near = most + 1;
    for (const v of MENDABLE) {
      const d = distance(w, v, most);
      if (d < near) { best = v; near = d; }
    }
    return best;
  });
}

const hm = (m: number) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

/**
 * The part of a day a question names, on the 24-hour clock: "between 2pm and
 * 4pm", "2-4pm", "from 14:00 to 16:30", "after 3pm", "before 11am", "at 2pm"
 * (the hour from then), "this afternoon". Null when it names none.
 */
export function timesIn(text: string): { start: string; end: string } | null {
  const t = mend(text);
  const found: { m: number; at: number }[] = [];
  for (const x of t.matchAll(/\b(\d{1,2})(?::([0-5]\d))?\s*(am|pm)\b|\b([01]?\d|2[0-3]):([0-5]\d)\b|\b(noon|midday|midnight)\b/g)) {
    if (x[1]) {
      const h = Number(x[1]);
      if (h < 1 || h > 12) continue;
      found.push({ m: ((h % 12) + (x[3] === 'pm' ? 12 : 0)) * 60 + Number(x[2] ?? 0), at: x.index ?? 0 });
    } else if (x[4]) found.push({ m: Number(x[4]) * 60 + Number(x[5]), at: x.index ?? 0 });
    else found.push({ m: x[6] === 'midnight' ? 0 : 12 * 60, at: x.index ?? 0 });
  }
  // "between 2 and 4pm", "2-4pm": the bare hour takes the other's half of the day, unless that puts it after it.
  const pair = /\b(\d{1,2})\s*(?:and|to|till|until|-|–)\s*(\d{1,2})\s*(am|pm)\b/.exec(t);
  if (pair && found.length === 1 && Number(pair[1]) >= 1 && Number(pair[1]) <= 12) {
    let s = ((Number(pair[1]) % 12) + (pair[3] === 'pm' ? 12 : 0)) * 60;
    if (s >= found[0].m) s -= 12 * 60;
    if (s >= 0) found.unshift({ m: s, at: pair.index });
  }
  if (found.length >= 2) {
    // Midnight second is the day's end: "from 10pm to midnight". Given the wrong way round, the earlier is the start.
    let [x, y] = [found[0].m, found[1].m || 24 * 60];
    if (x > y) [x, y] = [y, x];
    return x < y ? { start: hm(x), end: hm(y) } : null;
  }
  if (found.length === 1) {
    const x = found[0];
    const before = t.slice(0, x.at);
    if (/\b(after|since|from)\s*$/.test(before)) return { start: hm(x.m), end: '24:00' };
    if (/\b(before|until|till|by|up to)\s*$/.test(before)) return x.m > 0 ? { start: '00:00', end: hm(x.m) } : null;
    return { start: hm(x.m), end: x.m + 60 >= 24 * 60 ? '24:00' : hm(x.m + 60) };
  }
  if (/\bmorning\b/.test(t)) return { start: '06:00', end: '12:00' };
  if (/\bafternoon\b/.test(t)) return { start: '12:00', end: '17:00' };
  if (/\bevening\b/.test(t)) return { start: '17:00', end: '21:00' };
  return null;
}

/** One day a period names, for the tools that take a day: today, yesterday or its date - else the fallback. */
const dateOf = (period: Args | null, fallback: string): string => {
  if (!period) return fallback;
  if (period.range === 'today' || period.range === 'yesterday') return String(period.range);
  return period.from && period.from === period.to ? String(period.from) : fallback;
};

/** The tools that look at one day, and the day each looks at when none is named. */
const DATE_TOOLS: Record<string, string> = { day_report: 'yesterday', power_day: 'today' };

/** Words that name no one system, even when a system's name has them. */
const NOT_A_NAME = new Set(['system', 'systems', 'solar', 'plant', 'plants', 'panel', 'panels', 'inverter', 'inverters', 'power', 'energy', 'array', 'station', 'site', 'total', 'the']);

/** The period a question names - a named one, a month by name, a date, a year - or null. */
export function periodIn(text: string, today: string): Args | null {
  return periodMatch(text, today)?.args ?? null;
}

/**
 * Two periods set against each other - "this week than last week", "August compared with July" - the
 * second as it is named; null when the question names only one, or compares nothing.
 */
export function secondPeriodIn(text: string, today: string): Args | null {
  const t = text.toLowerCase();
  if (!/\b(than|compared? (to|with)|vs\.?|versus|against|or)\b/.test(t)) return null;
  const first = periodMatch(t, today);
  const second = first ? periodMatch(t.replace(first.words, ' '), today) : null;
  return second && JSON.stringify(second.args) !== JSON.stringify(first!.args) ? second.args : null;
}

/** The period a question names, and the words that named it. */
function periodMatch(text: string, today: string): { args: Args; words: string } | null {
  const t = text.toLowerCase();
  // Every period the question names, and where: the first named is the one meant - "august this year" is August -
  // and at one place the longer reading, "3rd september" over "september", a date over its year.
  const found: { at: number; args: Args; words: string }[] = [];
  const add = (m: RegExpExecArray | null, args: Args) => { if (m) found.push({ at: m.index, args, words: m[0] }); };
  const named: [RegExp, Range][] = [
    [/\btoday('?s)?\b/, 'today'], [/\byesterday('?s)?\b|\blast night\b/, 'yesterday'], [/\bthis week('?s)?\b/, 'this_week'],
    [/\b(last|previous|past) week('?s)?\b/, 'last_week'], [/\bthis month('?s)?\b/, 'this_month'], [/\b(last|previous) month('?s)?\b/, 'last_month'],
    [/\bthis year('?s)?\b|\bso far\b/, 'this_year'], [/\b(last|previous) year('?s)?\b/, 'last_year'],
    [/\b(last|past) (7|seven) days\b/, 'last_7_days'], [/\b(last|past) (30|thirty) days\b/, 'last_30_days'],
    [/\b(last|past) (12|twelve) months\b|\bpast year\b/, 'last_12_months'],
  ];
  for (const [re, range] of named) add(re.exec(t), { range });
  // "the last 3 days", "past 2 weeks": that many days, up to today.
  const back = /\b(last|past) (\d{1,3}) (days?|weeks?)\b/.exec(t);
  if (back) {
    const n = Number(back[2]) * (back[3].startsWith('week') ? 7 : 1);
    const end = Date.parse(`${today}T00:00:00Z`) / (86400 * 1000);
    if (n >= 1 && n <= 3 * 366) add(back, { from: isoDay(end - n + 1), to: today });
  }
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(t);
  if (iso) add(iso, { from: iso[1], to: iso[1] });
  const year = Number(today.slice(0, 4));
  for (let m = 0; m < 12; m++) {
    const name = `(?:${MONTHS[m]}|${MONTHS[m].slice(0, 3)})`;
    const hit = new RegExp(`\\b${name}\\b(?:\\s+(\\d{4}))?`).exec(t);
    // "may" is a verb as often as a month: only with a year, or as "in may".
    if (!hit || (m === 4 && !hit[1] && !/\bin may\b/.test(t))) continue;
    let y = hit[1] ? Number(hit[1]) : year;
    if (!hit[1] && `${y}-${pad(m + 1)}-01` > today) y -= 1;       // a month still to come means last year's
    const day = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${name}\\b|\\b${name}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(t);
    const d = day ? Number(day[1] ?? day[2]) : 0;
    if (d >= 1 && d <= lastOfMonth(y, m)) add(day, { from: `${y}-${pad(m + 1)}-${pad(d)}`, to: `${y}-${pad(m + 1)}-${pad(d)}` });
    else add(hit, { from: `${y}-${pad(m + 1)}-01`, to: `${y}-${pad(m + 1)}-${pad(lastOfMonth(y, m))}` });
  }
  const y = /\b(20\d{2})\b/.exec(t);
  if (y) add(y, { from: `${y[1]}-01-01`, to: `${y[1]}-12-31` });
  if (!found.length) return null;
  const first = found.sort((a, b) => a.at - b.at || b.words.length - a.words.length)[0];
  return { args: first.args, words: first.words };
}

/**
 * The system a question names: the longest name it contains, its alias, or a
 * word of just one system's name - "orchard" for Orchard Hybrid, "riverside"
 * for Riverside Ongrid. Null when it names none, or only a word systems share.
 */
function systemIn(text: string, systems: Sys[]): Sys | null {
  const t = text.toLowerCase();
  const full = [...systems].sort((a, b) => b.name.length - a.name.length).find((s) => t.includes(s.name.toLowerCase()));
  if (full) return full;
  const alias = systems.find((s) => new RegExp('\\b' + s.alias + '\\b').test(t));
  if (alias) return alias;
  const words = new Set(t.split(/[^\p{L}\p{N}]+/u));
  const own = (s: Sys) => s.name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !NOT_A_NAME.has(w));
  const hits = systems.filter((s) => own(s).some((w) => words.has(w) && systems.filter((x) => own(x).includes(w)).length === 1));
  return hits.length === 1 ? hits[0] : null;
}

/**
 * The measures a question names, in the order it names them - "PV against load" is power, then load -
 * as the chart tool calls them; power when it names none.
 */
function metricsIn(t: string): string[] {
  const words: [string, RegExp][] = [
    ['soc', /\b(soc|state of charge|battery (charge|level|percent\w*)|charge level)\b/],
    ['battery', /\b(batter(y|ies)|charging|discharging)\b/],
    ['grid', /\b(grid|import\w*|export\w*|buy\w*|bought|sell\w*|sold|feed[- ]?in)\b/],
    ['load', /\b(load|consum\w*|usage|use[ds]?|using|house|home use|demand)\b/],
    ['power', /\b(power|pv|solar|generat\w*|produc\w*|output|made|yield)\b/],
  ];
  const found = words.map(([m, re]) => ({ m, at: t.search(re) })).filter((x) => x.at >= 0);
  // A battery's charge is also "battery": the more exact one wins where both match at the same place.
  const picked = found.filter((x) => !(x.m === 'battery' && found.some((y) => y.m === 'soc' && y.at === x.at)))
    .sort((x, y) => x.at - y.at).map((x) => x.m);
  const out = [...new Set(picked)].slice(0, 2);
  return out.length ? out : ['power'];
}

/** A question about what is still to come, which no figure here can answer. */
const FUTURE = /\b(tomorrow|next (week|month|year)|forecast\w*|predict\w*|will (i|it|we|my|the|they|\w+) (make|produce|generate|get|earn|save))\b/;

/** What each inverter has made since it was installed - not "the most ever made in a day", which is a record. */
const LIFETIME = /^(?!.*\b(most|best|record|highest|max\w*|biggest|lowest|least|worst|min\w*)\b).*\b(lifetime|all[- ]time|since (it was |they were |we )?install\w*|ever (made|produced|generated)|in (its|their) (whole )?life)\b/;
/** A figure asked for as such: how many days, the first or last time, on each weekday, the record. */
const FIGURE_ASKED = /\bhow (many (days|times|hours)|often)\b|\bnumber of (days|times)\b|\b(first|last) time\b|\bwhen (did|was|were)\b.*\b(first|last|go|went|exceed\w*|drop\w*|fell|fall|reach\w*|hit|pass\w*|cross\w*|above|below|over|under|more than|less than)\b|\b(weekdays?|day of (the )?week|weekends?|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays)\b|\b(ever|all[- ]time|record)\b/;
/** Words that say a question is about the systems at all: one no other reading fits still gets an answer. */
const ABOUT_SOLAR = /\b(solar|panels?|inverters?|systems?|plants?|energy|power|kwh|kw|units?|batter(y|ies)|grid|load|consum\w*|produc\w*|generat\w*|output|sun|sunlight|weather|bill|money|sav\w*|export\w*|import\w*|strings?|pv|faults?|alarms?|errors?|relay|data ?logger|wi-?fi|efficien\w*|performance|electricity|house|home)\b/;

/**
 * A question for one figure, read as the figures tool takes it: the measure its words name - energy or
 * power, the house, the grid, the battery - how (total, average, highest, lowest, how many days, the
 * first or last time), by what, and any amount it names. "Units" are kWh, as on a bill. Null when it
 * names no measure.
 */
export function figuresIn(t: string): Args | null {
  const has = (re: RegExp) => re.test(t);
  const energy = has(/\b(kwh|mwh|energy|units?)\b/);
  const moment = !energy && has(/\d\s*(kw|w|watts?)\b|\b(kw|watts?|power|at once|at a time|moment)\b/);
  const selling = has(/\b(sold|sell\w*|export\w*|feed[- ]?in|to the grid)\b/);
  // A day's peak is a measure of its own when days are set against each other: each day's, the lowest, the average.
  const dailyPeak = has(/\bpeaks?\b/) && has(/\b(days?|daily|each day|lowest|min\w*|least|smallest|worst|average|avg|mean|typical|usual)\b/);
  let measure: string | null = null;
  if (LIFETIME.test(t)) measure = 'lifetime_made';
  else if (has(/\b(batter(y|ies)|soc|state of charge|charging|discharg\w*)\b/)) {
    const daily = has(/\b(days?|daily|each day|per day|every day)\b/);
    if (energy && has(/\b(took in|charged|stored|into)\b/)) measure = 'battery_in';
    else if (energy && has(/\b(gave out|discharged|delivered|supplied|drained)\b/)) measure = 'battery_out';
    else if (has(/\b(power|kw|watts?|charging|discharging|rate)\b/) && !has(/%|\b(percent\w*|level|full|empty|soc|state of charge)\b/)) measure = 'battery_power';
    else if (daily && has(/\b(full|highest|max\w*|top)\b/)) measure = 'battery_high';
    else if (daily && has(/\b(empty|flat|lowest|min\w*|low)\b/)) measure = 'battery_low';
    else measure = 'battery_charge';
  } else if (has(/\b(bought|buy\w*|import\w*|purchas\w*|from the grid)\b/)) measure = moment ? 'grid' : 'bought';
  else if (selling) measure = moment ? 'grid' : 'sold';
  else if (has(/\bgrid\b/)) measure = energy ? 'bought' : 'grid';
  else if (has(/\b(use[ds]?|usage|consum\w*|load|demand|house|home)\b/)) measure = moment || has(/\b(load|demand)\b/) && !energy ? 'load' : 'used';
  else if (dailyPeak) measure = 'peak_power';
  else if (has(/\b(made|make|generat\w*|produc\w*|yield|output|solar|pv|power)\b/)) measure = moment ? 'power' : 'made';
  if (!measure) return null;
  // Selling is grid power below zero, and discharging is battery power below zero.
  const outward = measure === 'grid' ? selling : measure === 'battery_power' && has(/\b(discharg\w*|gave out|giv\w* out|drain\w*)\b/);
  // Of a day's peak, "peak" names the measure, not the highest.
  const TOP = measure === 'peak_power' ? /\b(highest|max\w*|most|record|biggest|largest|greatest|best|top)\b/ : /\b(highest|max\w*|peak|most|record|biggest|largest|greatest|best|top)\b/;

  let stat = has(/\bhow (many|often)\b|\bnumber of (days|times)\b/) ? 'count'
    : has(/\b(first|earliest)\b/) ? 'first'
      // "When was it last below 50%" - but not "last week" or "last night".
      : has(/\b(last time|most recent\w*|latest)\b|\bwhen\b.*\blast\b(?!\s+(week|month|year|night|\d+|seven|thirty|twelve)\b)/) ? 'last'
        : has(TOP) ? 'highest'
          : has(/\b(lowest|min\w*|least|smallest|worst)\b/) ? 'lowest'
            : has(/\b(average|avg|mean|typical|usual|normal|per day|a day)\b/) ? 'average'
              : has(/\b(total|sum|altogether|in all|overall|how much)\b/) ? 'total' : null;
  // "Daily" names a day's peak or a battery's day, not a split by day; a split by week, month or year wins over it.
  const DAILY = /^(peak_power|battery_high|battery_low)$/.test(measure) ? /\b(each day|every day|day by day|by day)\b/ : /\b(each day|every day|day by day|by day|daily)\b/;
  const by = has(/\b(by hour|each hour|per hour|hourly|which hour|what hour|time of (the )?day|hour of (the )?day|what time)\b/) ? 'hour_of_day'
    : has(/\b(weekdays?|day of (the )?week|weekends?|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays)\b/) ? 'weekday'
      : has(/\b(each week|every week|week by week|by week|weekly|per week)\b/) ? 'week'
        : has(/\b(each month|every month|month by month|by month|monthly|per month)\b/) ? 'month'
          : has(/\b(each year|every year|year by year|by year|yearly|per year|annual\w*)\b/) ? 'year'
            : has(DAILY) && stat !== 'average' && stat !== 'count' ? 'day' : null;

  // Any amount it names, in the measure's unit: watts are kilowatts over a thousand; selling is grid power below zero.
  const amount = (re: RegExp): number | null => {
    const m = re.exec(t);
    if (!m) return null;
    const n = Number(m[1]);
    return /^w|watt/.test(m[2] ?? '') ? n / 1000 : n;
  };
  const UNIT = '\\s*(kwh|mwh|kw|w|watts?|%|percent|units?)?';
  let above = amount(new RegExp(`\\b(?:above|over|more than|greater than|higher than|exceed\\w*|at least|beyond)\\s+(-?\\d+(?:\\.\\d+)?)${UNIT}`));
  let below = amount(new RegExp(`\\b(?:below|under|less than|lower than|at most|fewer than)\\s+(-?\\d+(?:\\.\\d+)?)${UNIT}`));
  if (measure === 'battery_high' && above == null && has(/\bfull\b/)) above = 97;
  if (measure === 'battery_low' && below == null && has(/\b(empty|flat)\b/)) below = 21;
  // Selling or discharging "more than 3 kW" is below -3, and only such moments count: the most of it is the lowest figure.
  if (outward) {
    if (above != null) { below = -above; above = null; } else if (below == null) below = 0;
    if (stat === 'highest') stat = 'lowest'; else if (stat === 'lowest') stat = 'highest';
  }
  return {
    measure,
    ...(stat && !(by && stat !== 'count' && has(/\b(which|what) (hour|time|day|weekday|week|month|year)\b/)) ? { stat } : {}),
    ...(by ? { by } : {}),
    ...(above != null ? { above } : {}),
    ...(below != null ? { below } : {}),
  };
}

/**
 * A question asking what a word means - "what is kWp?", "what is a string?", "what does SOC mean?" -
 * not asking for a value: "what is the PV1 voltage?", "what is my SOC?".
 */
function defining(t: string): boolean {
  const asks = /\b(what does .* mean|meaning of|define|definition|stands? for|explain (what|the term)|what is meant by|difference between)\b/.test(t)
    || /^(what(\s+is|\s+are|'s|s)|explain)\s+(?!the\b|my\b|our\b|your\b|its\b|their\b)/.test(t.trim());
  return asks && !/\b(my|our|your|now|today|yesterday|this|last|current\w*|total|how much|many)\b/.test(t)
    && findHelp(t).some((e) => e.term);
}

/**
 * Two or three questions in one message - "how much did I make yesterday, and what is the battery at?" -
 * as separate questions. A time of day ("between 2pm and 4pm") and a follow-up ("and the week before?")
 * stay whole: an "and" splits only before a new question.
 */
function splitQuestions(q: string): string[] {
  const parts = q.split(/\?\s+|\s*;\s*|,?\s+\b(?:and also|also|as well as|plus)\b\s+|,?\s+and\s+(?=(?:what|how|when|which|who|is|are|was|were|did|does|do|show|give|tell|plot|graph|chart|draw|list|compare|analy\w*)\b)/i)
    .map((s) => s.trim()).filter((s) => s.length > 3);
  return parts.length > 1 ? parts.slice(0, MAX_CALLS) : [q];
}

/** What a question is about, from its words. */
function kindOf(t: string): string | null {
  // A word explained, from the guide's own entries.
  if (defining(t)) return 'define';
  // An analysis - what stands out, why, what to do - first: "how can I improve" is not how to use the app.
  if (/\b(analy\w*|insights?|how can (i|we) (improve|save|do better|use more)|improve|optimi[sz]\w*|recommend\w*|suggest\w*|advice|advise|tips?|what should (i|we) do|anything (unusual|wrong|odd|strange)|everything (ok|okay|fine|good|alright|all right))\b/.test(t)) return 'analysis';
  // "Is my output normal?", "are the panels ok?": how things stand - but a datalogger or a connection is the outages'.
  if (/\b(is|are) (my|our|the)\b.*\b(normal|ok|okay|fine|good|healthy|alright|right)\b/.test(t) && !/\b(now|currently)\b/.test(t)
    && !/\b(wi-?fi|data ?logger|logger|online|offline|relay|log ?in|connect\w*)\b/.test(t)) return 'analysis';
  // "How is my system doing?" asks for the analysis; "...doing now?" for the moment.
  if (/\bhow (is|are) (my|the|our) (solar|system|systems|panels|plant|installation|setup)s? (doing|performing)\b/.test(t) && !/\b(now|currently|today)\b/.test(t)) return 'analysis';
  // Since it was installed - before "install", which is how to set something up.
  if (LIFETIME.test(t)) return 'figures';
  if (/\b(how (do|can|to|should)|where (is|do|can|are|should)|set ?up|turn (on|off)|enable|disable|install|connect)\b/.test(t)) return 'help';
  if (FUTURE.test(t)) return 'future';
  if (/\b(report|summar(y|ise|ize))\b/.test(t)) return 'report';
  // Offline, not working, since when, when it last made power, the relay and its login - before "why", since "why is it offline?" is this.
  if (/\b(of+\s?-?line|online|not (working|reporting|running|generating|producing|online)|is \w+ (working|running|reporting)|stop(ped|s)?|stop working|outages?|downtime|no (data|readings)|since when|from when|went (off|down|quiet|dark)|c[ao]me back|last (reading|report\w*|seen|gen[a-z]*r[a-z]*t\w*|produc\w*|made|power|worked)|relays?|log ?in|expir\w*|data ?logger|connected|connection|wi-?fi)\b/.test(t)) return 'outage';
  // A figure asked for as such - how many days, the first or last time, each weekday - but a count of production's days is the statistics'.
  if (FIGURE_ASKED.test(t)) {
    const f = figuresIn(t);
    if (f && !(f.measure === 'made' && f.stat === 'count')) return 'figures';
  }
  if (/\bwhy\b/.test(t)) return 'why';
  if (/\b(degrad\w*|declin\w*|dirty|trend|health|getting worse|losing|slowly)\b/.test(t)) return 'trend';
  if (/\b(faults?|alarms?|errors?|warnings?)\b/.test(t)) return 'faults';
  if (/\b(compare|comparison|per kwp|which system|best system|worst system)\b/.test(t)) return 'compare';
  // What the inverter itself shows: its strings, voltages, currents, the grid's frequency, the battery's own readings.
  if (/\b(pv ?\d|strings?|mppt|volts?|voltage\w*|amps?|amperes?|frequency|hz|power factor|dc bus|phases?|bms|inverter (shows?|readings?|data|details?|display\w*))\b/.test(t)) return 'inverter';
  if (/\b(temp\w*|heat\w*|hot|hottest|overheat\w*|degrees?)\b/.test(t)) return 'inverter';
  // A graph over a time, or the usual day hour by hour.
  if (/\b(graph\w*|chart\w*|plot\w*|visuali[sz]\w*|draw)\b/.test(t)) return 'chart';
  if (/\b(which hours?|what hours?|what time|time of (the )?day|hour of (the )?day|by hour|each hour|daily pattern|typical day|at night|overnight|night ?time|during the night|in the (morning|evening))\b|\bwhen do(es)?\b.*\bpeak/.test(t)) return 'profile';
  // The most sold or bought at once, the battery's fastest discharge, the lowest daily peak: a statistic no other tool keeps - unless it is now.
  const f = figuresIn(t);
  if (f && /^(grid|battery_power|peak_power)$/.test(String(f.measure)) && !/\b(now|currently|at the moment|at present)\b/.test(t)
    && ((f.stat && f.stat !== 'total') || (/\d/.test(t) && (f.above != null || f.below != null)))) return 'figures';
  // The battery; its average charge, exactly, is a figure.
  if (/\b(batter(y|ies)|soc|state of charge|discharg\w*)\b/.test(t)) return /\b(average|avg|mean|typical)\b/.test(t) && figuresIn(t) ? 'figures' : 'battery';
  // What is happening now - the load, the power, the grid - is the moment, not a period's energy.
  if (/\b(right now|now|currently|at the moment|at present|live)\b/.test(t)) return 'now';
  // Bought against sold, or the net of them: both totals, side by side.
  if (/\b(import\w*|bought|buy\w*|from the grid)\b/.test(t) && /\b(export\w*|sold|sell\w*|feed[- ]?in|to the grid)\b/.test(t)) return 'trade';
  if (/\bnet (grid|import\w*|export\w*|usage|use|consumption|metering)\b/.test(t)) return 'trade';
  // How the power went through a day: its swings, dips and peak. Over many days, that is the statistics.
  if (/\b(fluc\w*|swing\w*|spikes?|dips?|dipped|choppy|stable|steady|unstable|stability|curve|profile|variab\w*|variation|vary|varies|varied|peak(ed|s)?|highest power|max(imum)? power|min(imum)? power)\b/.test(t)) return 'power';
  // How much of the sun's energy was used at home, and how much of the house's use the sun covered.
  if (/\bself[- ]?(consum\w*|us\w*|suffic\w*)|\b(use[ds]?|consumed) (it )?(myself|ourselves)\b|\bhow much of (my|our|the) (solar|power|energy|generation|production)\b|\bpercent\w*\b.*\b(myself|at home|ourselves)\b/.test(t)) return 'self';
  if (/\b(sav\w*|money|earn\w*|bill|cost|worth|rupees?|dollars?|pounds?|euros?|pkr|inr|usd|currency|co2|carbon|tariff)\b/.test(t)) return 'saved';
  // The statistics are production's: an average of anything else is a figure.
  if (/\b(stats?|statistic\w*|average|mean|median|capacity factor|specific yield|consistent|how many days)\b/.test(t)) {
    const f = figuresIn(t);
    return f && f.measure !== 'made' && f.measure !== 'power' ? 'figures' : 'stats';
  }
  if (/\b(export\w*|sold|sell\w*|feed[- ]?in)\b/.test(t)) return 'exported';
  if (/\b(import\w*|bought|buy|from the grid)\b/.test(t)) return 'imported';
  // "How do I use..." is help, caught above; any other "use" is the house's.
  if (/\b(use|used|usage|consum\w*|load)\b/.test(t)) return 'used';
  if (/\b(right now|currently|at the moment|now|live|producing|status)\b/.test(t)) return 'now';
  if (/\b(kwh|mwh|energy|made|make|produc\w*|generat\w*|yield|how much|best|worst|most|least|month|day|week|year|sav\w*|money|co2|carbon)\b/.test(t)) return 'energy';
  return null;
}

const DAY_MS = 86400 * 1000;

/**
 * The whole period before `p`: the year before a year, the month before a
 * month, the week before a week - whole, even when `p` runs only to today -
 * else as many days again. `range` is the named range `p` came from, if any:
 * this month so far and the first days of a month both begin on the 1st, and
 * only the name tells them apart.
 */
export function periodBefore(p: Period, range?: unknown): Args {
  const [y, m, d] = p.from.split('-').map(Number);
  const [ty, tm, td] = p.to.split('-').map(Number);
  if (range === 'this_year' || range === 'last_year' || (m === 1 && d === 1 && ty === y && tm === 12 && td === 31)) {
    return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
  }
  if (range === 'this_month' || range === 'last_month' || (d === 1 && ty === y && tm === m && td === lastOfMonth(y, m - 1))) {
    const py = m === 1 ? y - 1 : y;
    const pm = m === 1 ? 12 : m - 1;
    return { from: `${py}-${pad(pm)}-01`, to: `${py}-${pad(pm)}-${pad(lastOfMonth(py, pm - 1))}` };
  }
  const from = Date.parse(`${p.from}T00:00:00Z`) / DAY_MS;
  // This week so far, Monday to today, is followed back by the whole week before it.
  const span = range === 'this_week' ? 7 : Date.parse(`${p.to}T00:00:00Z`) / DAY_MS - from + 1;
  return { from: isoDay(from - span), to: isoDay(from - 1) };
}

/**
 * Read a question without a model: its kind from its words, and the period and
 * the system it names. A follow-up with no kind of its own - "and last
 * month?", "the one before?", "for the garage?" - moves the previous turn's
 * first call to what it names. Null when nothing in it says what is wanted.
 */
export function guessCalls(question: string, systems: Sys[], now: number, off: number, previous: Call[] = []): Call[] | null {
  const t = mend(question);
  const today = isoDay(dayNo(now, off));
  const period = periodIn(t, today);
  const system = systemIn(question, systems);
  // Tools that look at a period, and so can look at another.
  const periodic = (c: Call) => !DATE_TOOLS[c.tool] && !['inverter', 'app_help', 'status_now', 'performance_trend'].includes(c.tool);
  // Two or three questions in one are each answered: a part that names no period or system takes the message's,
  // unless it asks about now.
  const parts = splitQuestions(question);
  if (parts.length > 1) {
    const calls = parts.flatMap((part) => {
      const ofNow = /\b(right now|now|currently|at the moment|at present|live)\b/.test(mend(part));
      return (guessCalls(part, systems, now, off) ?? []).map((c) => {
        const own = c.args.range !== undefined || c.args.from !== undefined || c.args.date !== undefined;
        const args: Args = { ...c.args };
        if (!own && !ofNow && period && periodic(c)) Object.assign(args, period);
        if (!own && !ofNow && period && DATE_TOOLS[c.tool]) args.date = dateOf(period, String(args.date ?? DATE_TOOLS[c.tool]));
        if (system && args.system === undefined && c.tool !== 'app_help' && c.tool !== 'compare_systems') args.system = system.name;
        return { tool: c.tool, args };
      });
    });
    const seen = new Set<string>();
    const unique = calls.filter((c) => !seen.has(JSON.stringify(c)) && !!seen.add(JSON.stringify(c)));
    if (unique.length) return unique.slice(0, MAX_CALLS);
  }
  const calls = readQuestion(t, question, systems, now, off, previous, today, period, system);
  // Two periods set against each other - "this week than last week" - are each looked at the same way.
  const second = calls?.length ? secondPeriodIn(t, today) : null;
  if (!calls || !second) return calls;
  const again = calls.flatMap((c) => {
    const { range: _r, from: _f, to: _t, date: _d, ...rest } = c.args;
    if (periodic(c)) return [{ tool: c.tool, args: { ...rest, ...second } }];
    if (DATE_TOOLS[c.tool] && dateOf(second, '')) return [{ tool: c.tool, args: { ...rest, date: dateOf(second, '') } }];
    return [];
  });
  return [...calls, ...again].slice(0, MAX_CALLS);
}

/** One question read: its kind, the period and the system it names, or a follow-up of the turn before. */
function readQuestion(t: string, question: string, systems: Sys[], now: number, off: number, previous: Call[], today: string, period: Args | null, system: Sys | null): Call[] | null {
  const named = (a: Args = {}): Args => ({ ...a, ...(period ?? {}), ...(system ? { system: system.name } : {}) });
  const kind = kindOf(t);
  const last = previous[0];
  // Part of a day - "between 2pm and 4pm", "this afternoon" - is the day's power, whatever the words say of energy.
  const times = timesIn(t);
  if (times && (!kind || ['energy', 'power', 'now', 'stats', 'exported', 'imported', 'used'].includes(kind))) {
    const keep = !kind && last?.tool === 'power_day' ? last.args : {};
    return [{ tool: 'power_day', args: { ...keep, date: dateOf(period, String(keep.date ?? 'today')), ...times, ...(system ? { system: system.name } : {}) } }];
  }
  if (last && (!kind || (kind === 'energy' && /^\s*(and|what about|how about|or)\b/.test(t)))) {
    const { range: _r, from: _f, to: _t, date: _d, ...rest } = last.args;
    const dayOfTool = DATE_TOOLS[last.tool];
    if (/\b(before|previous|prior|earlier)\b/.test(t) && !period) {
      if (dayOfTool) {
        const at = typeof last.args.date === 'string' ? last.args.date : dayOfTool;
        const n = at === 'today' ? dayNo(now, off) : at === 'yesterday' ? dayNo(now, off) - 1 : Date.parse(`${at}T00:00:00Z`) / DAY_MS;
        return [{ tool: last.tool, args: { ...rest, date: isoDay(n - 1), ...(system ? { system: system.name } : {}) } }];
      }
      // The period the last call covered - named, given as dates, or the tool's own default - and the one before it.
      const fallback = DEFAULT_RANGE[last.tool] ?? 'this_month';
      const p = resolvePeriod(last.args, now, off, fallback);
      const range = last.args.from !== undefined || last.args.to !== undefined ? undefined : (last.args.range ?? fallback);
      return [{ tool: last.tool, args: { ...rest, ...periodBefore(p, range), ...(system ? { system: system.name } : {}) } }];
    }
    if (period || system) {
      // A day tool keeps its day, and its hours, unless the follow-up names another.
      if (dayOfTool) return [{ tool: last.tool, args: { ...rest, date: dateOf(period, String(last.args.date ?? dayOfTool)), ...(system ? { system: system.name } : {}) } }];
      return [{ tool: last.tool, args: { ...rest, ...(period ?? { range: last.args.range, from: last.args.from, to: last.args.to }), ...(system ? { system: system.name } : {}) } }]
        .map((c) => ({ ...c, args: Object.fromEntries(Object.entries(c.args).filter(([, v]) => v !== undefined)) as Args }));
    }
  }
  switch (kind) {
    case 'help': return [{ tool: 'app_help', args: { question } }];
    case 'outage': return [{ tool: 'outages', args: named() }];
    case 'power': {
      // A day's power for a day; across many days, how the days varied.
      const days = !!period && dateOf(period, '') === '';
      if (days || /\b(weeks?|months?|years?)\b/.test(t)) return [{ tool: 'stats', args: named() }];
      return [{ tool: 'power_day', args: { date: dateOf(period, 'today'), ...(system ? { system: system.name } : {}) } }];
    }
    case 'analysis': return [{ tool: 'analysis', args: named() }];
    case 'report': return [{ tool: 'report', args: named() }];
    case 'why': return [{ tool: 'day_report', args: { date: period?.from && period.from === period.to ? period.from : period?.range === 'today' ? 'today' : 'yesterday', ...(system ? { system: system.name } : {}) } }];
    case 'trend': return [{ tool: 'performance_trend', args: system ? { system: system.name } : {} }];
    case 'faults': return [{ tool: 'faults', args: named() }];
    case 'compare': return [{ tool: 'compare_systems', args: period ?? {} }];
    // What is still to come has no figures: no call, and the answer says so.
    case 'future': return [];
    case 'battery': return [{ tool: 'battery', args: named() }];
    case 'inverter': {
      // What part of the inverter the question is about, so the answer leads with it.
      const part = /\b(batter(y|ies)|bms)\b/.test(t) ? 'battery'
        : /\b(pv ?\d|strings?|mppt)\b/.test(t) ? 'strings'
          : /\b(frequency|hz|phases?|power factor|grid)\b/.test(t) ? 'grid'
            : /\b(temp\w*|heat\w*|hot|hottest|overheat\w*|degrees?)\b/.test(t) ? 'temperature' : null;
      return [{ tool: 'inverter', args: { ...(part ? { part } : {}), ...(system ? { system: system.name } : {}) } }];
    }
    case 'chart': {
      // A graph of energy per day or month is the energy tool's bars; of anything a reading records, the chart tool's.
      if (/\b(kwh|energy|per (day|month)|daily|monthly|each (day|month)|every day)\b/.test(t) && !/\b(load|grid|batter\w*|soc|power)\b/.test(t)) {
        return [{ tool: 'energy', args: named({ group_by: /\b(month|monthly)\b/.test(t) && !/\bthis month\b|\blast month\b/.test(t) ? 'month' : 'day' }) }];
      }
      const [metric, versus] = metricsIn(t);
      const every = /\b15[- ]?min\w*|\bquarter[- ]hour\w*/.test(t) ? '15min'
        : /\b(hourly|by hour|each hour|every hour)\b/.test(t) ? 'hour'
          : /\b(daily|by day|each day|per day)\b/.test(t) ? 'day'
            : /\b(weekly|by week|each week)\b/.test(t) ? 'week' : null;
      // Each point as its highest or lowest reading when asked - "the peak power each day" - else its average.
      const stat = /\b(highest|max|maximum|peaks?)\b/.test(t) ? 'highest' : /\b(lowest|minimum)\b/.test(t) ? 'lowest' : null;
      return [{ tool: 'chart', args: named({ metric, ...(versus ? { versus } : {}), ...(every ? { every } : {}), ...(stat ? { stat } : {}) }) }];
    }
    case 'profile': {
      const [metric, versus] = metricsIn(t);
      return [{ tool: 'chart', args: { metric, ...(versus ? { versus } : {}), profile: 'hour_of_day', ...(period ?? { range: 'last_7_days' }), ...(system ? { system: system.name } : {}) } }];
    }
    case 'self': return [{ tool: 'energy', args: named({ measure: 'self' }) }];
    case 'saved': return [{ tool: 'energy', args: named({ measure: 'saved' }) }];
    case 'stats': {
      // "How many days above 50 kWh": the days over, or under, an amount.
      const above = /\b(?:more than|over|above|at least|greater than|exceed\w*)\s+(\d{1,6})(?:\.\d+)?\s*kwh\b/.exec(t);
      const below = /\b(?:less than|under|below|fewer than)\s+(\d{1,6})(?:\.\d+)?\s*kwh\b/.exec(t);
      return [{ tool: 'stats', args: named({ ...(above ? { above: Number(above[1]) } : {}), ...(below ? { below: Number(below[1]) } : {}) }) }];
    }
    case 'now': return [{ tool: 'status_now', args: system ? { system: system.name } : {} }];
    case 'exported': case 'imported': case 'used': return [{ tool: 'energy', args: named({ measure: kind }) }];
    case 'energy': {
      const by = /\b(which|best|worst|most|least|highest|lowest)\s+month\b/.test(t) ? 'month' : /\b(which|best|worst|most|least|highest|lowest)\s+day\b/.test(t) ? 'day' : null;
      return [{ tool: 'energy', args: named(by ? { group_by: by } : {}) }];
    }
    case 'define': return [{ tool: 'app_help', args: { question } }];
    case 'trade': return [{ tool: 'figures', args: named({ measure: 'bought', stat: 'total' }) }, { tool: 'figures', args: named({ measure: 'sold', stat: 'total' }) }];
    case 'figures': {
      // "The most ever made in a day": ever is as far back as a day's figure reaches, a year.
      const f = figuresIn(t)!;
      const ever = !period && /\b(ever|all[- ]time|of all time)\b/.test(t) && f.measure !== 'lifetime_made';
      return [{ tool: 'figures', args: { ...named(f), ...(ever ? { range: 'last_12_months' } : {}) } }];
    }
    default: {
      // Nothing above fits. A figure its words name; else, for anything about the systems, how they are doing -
      // now, when it asks of now, or the analysis. Only a question about nothing here gets no call.
      const f = figuresIn(t);
      if (f) return [{ tool: 'figures', args: named(f) }];
      if (!system && !ABOUT_SOLAR.test(t)) return null;
      if (/\b(now|right now|currently|at the moment|today)\b/.test(t)) return [{ tool: 'status_now', args: system ? { system: system.name } : {} }];
      return [{ tool: 'analysis', args: named() }];
    }
  }
}

// ---------------------------------------------------------------- the prompts

/** What the model is shown to understand a message: the tools, the systems, today, and how to answer. */
async function understandingPrompt(systems: Sys[], today: string): Promise<string> {
  const tools = TOOLS.map((t) => `- ${t.name}: ${t.description}\n  arguments: ${JSON.stringify(jsonSchemaOf(t).properties)}`).join('\n');
  return [
    "You are the assistant inside SolarLens, one owner's solar dashboard. For the owner's latest message, decide which read-only tools answer it.",
    `Today is ${dayWords(today, true)} (${today}) where the panels are. Weeks run Monday to Sunday.`,
    `The systems: ${systems.map((s) => `"${s.name}"${s.kwp ? ` (${s.kwp} kWp)` : ''}`).join(', ') || 'none yet'}.`,
    'The tools:',
    tools,
    `Use one to ${MAX_CALLS} calls for a message about the figures or about using SolarLens (app_help). Use two when it compares two periods or two systems.`,
    'For a follow-up ("and the month before?", "what about the garage?"), take the previous tools and change only what the follow-up changes.',
    `For a period, use "range" when one of ${RANGES.join(', ')} fits; otherwise "from" and "to" as YYYY-MM-DD.`,
    'Name a system exactly as listed, or leave "system" out for all of them.',
    'For part of a day - "between 2pm and 4pm", "this afternoon" - or how the power moved through a day - fluctuation, dips, the peak - use power_day, with start and end as HH:MM on the 24-hour clock.',
    'For whether a system is working or offline, since when, when it last made power, and the relay and its login, use outages.',
    'For money saved use energy with measure "saved"; for how much was used at home, measure "self"; for the battery, battery; for "how many days above 50 kWh", stats with above.',
    'For a graph or chart of power, load, grid, battery power or battery charge over a time, use chart (with versus for a second measure); for the usual day hour by hour - when the load peaks, which hours buy from the grid - chart with profile "hour_of_day". A graph of energy per day or month is energy.',
    "For anything the inverter itself shows - PV strings, voltages, currents, the grid's frequency, the power factor, its temperature, the DC bus, the battery's own readings - use inverter.",
    'For an analysis - how the systems are doing, what stands out and why, what to do, insights, how to improve, anything unusual - use analysis; for the figures of a period set out in full, report.',
    'For any other figure the records hold - a total, an average, the highest or lowest, how many days it was above or below an amount, the first or last time, '
      + 'by hour, weekday, day, week, month or year, or what was made since the system was installed - use figures, whatever words the question uses.',
    'For what a word means - kWp, SOC, net metering, a string - use app_help with the question. If the records do not hold what is asked - the past of a '
      + "string's voltage or of a temperature, anything to come - make no call, and say so plainly in reply.",
    'SolarLens has no forecast: for tomorrow or the future, make no call and reply that it reports what has been made.',
    'Answer with JSON only: {"calls": [{"tool": "<name>", "args": {...}}], "reply": "<text>"}.',
    'Leave "calls" empty only for a greeting or when you must ask back; then "reply" is one or two sentences, and never states a figure.',
  ].join('\n');
}

const UNDERSTAND_SCHEMA = {
  type: 'object',
  properties: {
    calls: { type: 'array', items: { type: 'object', properties: { tool: { type: 'string', enum: TOOLS.map((t) => t.name) }, args: { type: 'object' } }, required: ['tool'] } },
    reply: { type: 'string' },
  },
};

function wordingPrompt(kind: Reply['kind'], analysis = false): string {
  return [
    "You are SolarLens's assistant, answering the owner of a solar installation.",
    'Answer the latest message from the figures given, and only from them.',
    'Quote numbers exactly as they appear, with their units. Do not add, subtract, average, convert or otherwise work out any number that is not given.',
    'Say which period the figures cover. If they do not answer the message, say what they do show.',
    analysis
      ? 'This is an analysis: a first line on how things stand, then what stands out - what needs a look first, then what is worth knowing - each with its figures and why, '
        + 'then what to do, as lines starting "- ". Keep what is fine to a line. 150 to 280 words.'
      : kind === 'report'
        ? 'This is a report: a first line that sums it up, then short paragraphs, each on its own line, on the energy, the systems, the best and worst days, faults and health, and the money if given. 120 to 220 words.'
        : kind === 'help' ? "This is about using the app: answer from the guide's words, and say which tab or setting it is on." : 'One to four short sentences.',
    'Plain text: no markdown headers or tables. A line may start with "- " for a list.',
  ].join('\n');
}

/** A result cut down to what a model needs to word it. */
const forWording = (r: ToolResult): Record<string, unknown> => ({
  tool: r.tool, title: r.title, period: r.period?.label ?? null, columns: r.columns,
  rows: r.rows.slice(0, ROWS_SHOWN), more_rows: Math.max(0, r.rows.length - ROWS_SHOWN),
  facts: r.facts, notes: r.notes, summary: r.summary,
  ...(r.sections ? { sections: r.sections.map(forWording) } : {}),
});

/** An earlier turn, as the model is shown it: what was said, and which figures an answer used. */
const asMessage = (t: Turn): ChatMessage => ({
  role: t.role,
  content: t.role === 'assistant' && t.calls?.length ? `${t.content}\n[figures from: ${t.calls.map((c) => `${c.tool} ${JSON.stringify(c.args)}`).join('; ')}]` : t.content,
});

// ---------------------------------------------------------------- a turn

/** The conversation as sent, checked: turns of either role, the last the owner's, each cut to length. */
export function checkTurns(raw: unknown): Turn[] | string {
  if (!Array.isArray(raw) || !raw.length) return 'Send the conversation as a list of messages.';
  const turns: Turn[] = [];
  for (const m of raw.slice(-(HISTORY_TURNS + 1))) {
    if (!m || typeof m !== 'object') return 'Each message is an object with a role and its content.';
    const { role, content, calls } = m as { role?: unknown; content?: unknown; calls?: unknown };
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') return 'Each message has a role, user or assistant, and its content as text.';
    const tidy = content.replace(/\s+/g, ' ').trim().slice(0, role === 'user' ? MESSAGE_MAX : 1200);
    const ok = Array.isArray(calls) ? calls.filter((c): c is Call => !!c && typeof c === 'object' && typeof (c as Call).tool === 'string' && !!(c as Call).args && typeof (c as Call).args === 'object').slice(0, MAX_CALLS) : [];
    turns.push({ role, content: tidy, ...(ok.length ? { calls: ok } : {}) });
  }
  const last = turns[turns.length - 1];
  if (last.role !== 'user') return 'The last message is the one to answer, from the owner.';
  if (last.content.length < 2) return 'Ask something of a few words at least.';
  if (typeof (raw[raw.length - 1] as { content?: unknown }).content === 'string' && ((raw[raw.length - 1] as { content: string }).content.trim().length > MESSAGE_MAX)) {
    return `A message is at most ${MESSAGE_MAX} characters.`;
  }
  return turns;
}

type Outcome = { status: number; body: Reply | { error: string } };

/** What SolarLens can answer, said when a message asks nothing it can look up. */
const CAN_DO = 'I can analyse how your systems are doing - what stands out, why, and what to do - and answer questions about the energy they made, used, bought and sold; '
  + 'any figure the records hold - totals, averages, highs and lows, how many days, the first or last time, by hour, weekday, day, week, month or year; '
  + 'how they compare; their faults; why a day was low; whether one is slowly making less; statistics and reports for any period; graphs of any measure; '
  + 'any part of a day and how steady the power was; the battery; what the inverter shows; whether a system is offline and since when; the money saved; '
  + 'what a word means; and how to use SolarLens. Try "analyse the last 30 days", "a report on last month" or "which hours do I buy from the grid?".';

/** A greeting, thanks, or who SolarLens is, answered as such: a message asks nothing it can look up. */
function smallTalk(question: string): string | null {
  const t = question.toLowerCase();
  if (/\b(thanks|thank you|thx|shukri\w*|cheers|appreciated)\b/.test(t)) return "You're welcome. Ask anything else about your systems whenever you like.";
  if (/^\s*(hi|hello|hey|hiya|salam|assalam\w*|aoa|good (morning|afternoon|evening))\b/.test(t)) return `Hello! ${CAN_DO}`;
  if (/\b(who|what) are you\b|\bwhat can you do\b|\bwhat do you know\b/.test(t)) return `I am SolarLens's assistant, and every figure I give is worked out from your own systems' records. ${CAN_DO}`;
  return null;
}

/**
 * Answer the conversation's last message. `calls`, when given, are what to
 * look up, decided already (a "Why?" button); otherwise the model decides -
 * when `useModel` allows it, there is one, and a call is left today - or
 * SolarLens reads the message itself.
 */
export async function converse(env: Env, input: { messages: unknown; calls?: Call[] }, useModel: boolean, now = nowSec()): Promise<Outcome> {
  const turns = checkTurns(input.messages);
  if (typeof turns === 'string') return { status: 400, body: { error: turns } };
  const question = turns[turns.length - 1].content;
  const history = turns.slice(0, -1);
  const previous = [...history].reverse().find((t) => t.role === 'assistant' && t.calls?.length)?.calls ?? [];
  const systems = await loadSystems(env.DB);
  const off = zoneOf(systems);
  const today = isoDay(dayNo(now, off));
  const limit = dailyCalls(env);
  const modelOk = useModel && hasAi(env);
  const done = async (r: Omit<Reply, 'used' | 'limit' | 'model' | 'provider'>): Promise<Outcome> => ({
    status: 200,
    body: { ...r, used: await callsUsed(env.DB, now), limit, model: hasAi(env) ? aiModel(env) : null, provider: providerOf(env) },
  });

  // 1. Understanding.
  let calls: Call[] | null = input.calls ?? null;
  let understood: Reply['understood'] = 'solarlens';
  let reply = '';
  if (!calls && modelOk && (await takeCall(env.DB, limit, now))) {
    try {
      const messages: ChatMessage[] = [
        { role: 'system', content: await understandingPrompt(systems, today) },
        ...history.map(asMessage),
        { role: 'user', content: question },
      ];
      const out = (await chat(env, messages, { schema: UNDERSTAND_SCHEMA, maxTokens: 300 })).json as { calls?: unknown; reply?: unknown } | null;
      const chosen = Array.isArray(out?.calls)
        ? out!.calls.filter((c): c is Call => !!c && typeof c === 'object' && typeof (c as Call).tool === 'string').slice(0, MAX_CALLS)
          .map((c) => ({ tool: c.tool, args: (c.args && typeof c.args === 'object' ? c.args : {}) as Args }))
        : [];
      if (chosen.length) { calls = chosen; understood = 'model'; }
      else if (typeof out?.reply === 'string' && out.reply.trim()) { reply = out.reply.trim().slice(0, 400); understood = 'model'; }
    } catch (e) {
      console.warn(JSON.stringify({ assistant: 'understanding failed', error: String(e).slice(0, 200) }));
    }
  }
  if (!calls && !reply) calls = guessCalls(question, systems, now, off, previous);

  if (!calls || !calls.length) {
    // A reply of the model's own states no figure: one that does is set aside.
    const safe = reply && !numbersIn(reply).some((n) => n > 31 || !Number.isInteger(n));
    return done({
      answer: safe ? reply : FUTURE.test(mend(question))
        // What is still to come: no forecast is made here, and saying so beats a figure about something else.
        ? "SolarLens has no forecast: it reports what your systems have made, and - on each system's page - what today's sunlight so far allowed. "
          + 'Ask what they made yesterday or last week, or how a day compared with a usual one.'
        : smallTalk(question) ?? CAN_DO,
      worded: safe ? 'model' : 'solarlens', understood, kind: 'chat', calls: [], results: [], errors: [],
    });
  }

  // 2. Computing.
  const results: ToolResult[] = [];
  const errors: string[] = [];
  const ran: Call[] = [];
  for (const c of calls.slice(0, MAX_CALLS)) {
    const out = await runTool(env.DB, c.tool, c.args, now);
    if ('error' in out) errors.push(`${c.tool}: ${out.error}`);
    else { results.push(out.result); ran.push({ tool: c.tool, args: out.args }); }
  }
  // An analysis is written up, and downloaded, as a report is.
  const analysis = ran.some((c) => c.tool === 'analysis');
  const kind: Reply['kind'] = analysis || ran.some((c) => c.tool === 'report') ? 'report' : ran.length && ran.every((c) => c.tool === 'app_help') ? 'help' : 'figures';
  if (!results.length) {
    return done({ answer: `I could not answer that from the figures: ${errors.join(' ')}`, worded: 'solarlens', understood, kind, calls: ran, results, errors });
  }
  const plain = results.map((r) => r.summary).join(' ');

  // 3. Wording.
  if (!modelOk || !(await takeCall(env.DB, limit, now))) return done({ answer: plain, worded: 'solarlens', understood, kind, calls: ran, results, errors });
  try {
    const recent = history.slice(-4).map((t) => `${t.role === 'user' ? 'Owner' : 'Assistant'}: ${t.content}`).join('\n');
    const content = `${recent ? `Conversation so far:\n${recent}\n\n` : ''}Latest message: ${question}\nFigures: ${JSON.stringify(results.map(forWording))}`;
    const { text } = await chat(env, [{ role: 'system', content: wordingPrompt(kind, analysis) }, { role: 'user', content }], { maxTokens: kind === 'report' ? 700 : 400 });
    const answer = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, kind === 'report' ? 2400 : 900);
    if (!answer || !numbersAgree(answer, results, `${question} ${history.map((t) => t.content).join(' ')}`)) {
      return done({ answer: plain, worded: 'solarlens', understood, kind, calls: ran, results, errors });
    }
    return done({ answer, worded: 'model', understood, kind, calls: ran, results, errors });
  } catch (e) {
    console.warn(JSON.stringify({ assistant: 'wording failed', error: String(e).slice(0, 200) }));
    return done({ answer: plain, worded: 'solarlens', understood, kind, calls: ran, results, errors });
  }
}
