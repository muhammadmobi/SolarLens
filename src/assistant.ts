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
  'yesterday', 'statistics', 'comparison', 'consumption', 'inverter', 'afternoon', 'between',
  'january', 'february', 'august', 'september', 'october', 'november', 'december',
];

/** How many letters apart two words are - added, dropped or changed - or more than most when further. */
function distance(a: string, b: string, most: number): number {
  if (Math.abs(a.length - b.length) > most) return most + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > most) return most + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** A question as the reader takes it: lower case, "p.m." as "pm", and near misses of the words it routes on mended. */
export function mend(text: string): string {
  return text.toLowerCase().replace(/\b([ap])\.\s?m\b\.?/g, '$1m').replace(/[a-z]{5,}/g, (w) => {
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
  const t = text.toLowerCase();
  const named: [RegExp, Range][] = [
    [/\btoday\b/, 'today'], [/\byesterday\b/, 'yesterday'], [/\bthis week\b/, 'this_week'],
    [/\b(last|previous|past) week\b/, 'last_week'], [/\bthis month\b/, 'this_month'], [/\b(last|previous) month\b/, 'last_month'],
    [/\bthis year\b|\bso far\b/, 'this_year'], [/\b(last|previous) year\b/, 'last_year'],
    [/\b(last|past) (7|seven) days\b/, 'last_7_days'], [/\b(last|past) (30|thirty) days\b/, 'last_30_days'],
    [/\b(last|past) (12|twelve) months\b|\bpast year\b/, 'last_12_months'],
  ];
  for (const [re, range] of named) if (re.test(t)) return { range };
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(t);
  if (iso) return { from: iso[1], to: iso[1] };
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
    if (d >= 1 && d <= lastOfMonth(y, m)) return { from: `${y}-${pad(m + 1)}-${pad(d)}`, to: `${y}-${pad(m + 1)}-${pad(d)}` };
    return { from: `${y}-${pad(m + 1)}-01`, to: `${y}-${pad(m + 1)}-${pad(lastOfMonth(y, m))}` };
  }
  const y = /\b(20\d{2})\b/.exec(t);
  if (y) return { from: `${y[1]}-01-01`, to: `${y[1]}-12-31` };
  return null;
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

/** What a question is about, from its words. */
function kindOf(t: string): string | null {
  if (/\b(how (do|can|to|should)|where (is|do|can|are|should)|set ?up|turn (on|off)|enable|disable|install|connect)\b/.test(t)) return 'help';
  if (/\b(report|summar(y|ise|ize))\b/.test(t)) return 'report';
  // Offline, not working, since when, when it last made power - before "why", since "why is it offline?" is this.
  if (/\b(of+\s?-?line|not (working|reporting|running|generating|producing|online)|stop(ped|s)?|stop working|outages?|downtime|no (data|readings)|since when|from when|went (off|down|quiet|dark)|c[ao]me back|last (reading|report\w*|seen|gen[a-z]*r[a-z]*t\w*|produc\w*|made|power|worked))\b/.test(t)) return 'outage';
  if (/\bwhy\b/.test(t)) return 'why';
  if (/\b(degrad\w*|declin\w*|dirty|trend|health|getting worse|losing|slowly)\b/.test(t)) return 'trend';
  if (/\b(faults?|alarms?|errors?|warnings?)\b/.test(t)) return 'faults';
  if (/\b(compare|comparison|per kwp|which system|best system|worst system)\b/.test(t)) return 'compare';
  // How the power went through a day: its swings, dips and peak. Over many days, that is the statistics.
  if (/\b(fluc\w*|swing\w*|spikes?|dips?|dipped|choppy|stable|steady|unstable|stability|curve|profile|variab\w*|variation|vary|varies|varied|peak(ed|s)?|highest power|max(imum)? power|min(imum)? power)\b/.test(t)) return 'power';
  if (/\b(stats?|statistic\w*|average|mean|median|capacity factor|specific yield|consistent)\b/.test(t)) return 'stats';
  if (/\b(export\w*|sold|sell\w*|feed[- ]?in)\b/.test(t)) return 'exported';
  if (/\b(import\w*|bought|buy|from the grid)\b/.test(t)) return 'imported';
  // "How do I use..." is help, caught above; any other "use" is the house's.
  if (/\b(use|used|usage|consum\w*|load)\b/.test(t)) return 'used';
  if (/\b(right now|currently|at the moment|now|live|producing)\b/.test(t)) return 'now';
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
    case 'report': return [{ tool: 'report', args: named() }];
    case 'why': return [{ tool: 'day_report', args: { date: period?.from && period.from === period.to ? period.from : period?.range === 'today' ? 'today' : 'yesterday', ...(system ? { system: system.name } : {}) } }];
    case 'trend': return [{ tool: 'performance_trend', args: system ? { system: system.name } : {} }];
    case 'faults': return [{ tool: 'faults', args: named() }];
    case 'compare': return [{ tool: 'compare_systems', args: period ?? {} }];
    case 'stats': return [{ tool: 'stats', args: named() }];
    case 'now': return [{ tool: 'status_now', args: system ? { system: system.name } : {} }];
    case 'exported': case 'imported': case 'used': return [{ tool: 'energy', args: named({ measure: kind }) }];
    case 'energy': {
      const by = /\b(which|best|worst|most|least|highest|lowest)\s+month\b/.test(t) ? 'month' : /\b(which|best|worst|most|least|highest|lowest)\s+day\b/.test(t) ? 'day' : null;
      return [{ tool: 'energy', args: named(by ? { group_by: by } : {}) }];
    }
    default: return null;
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
    'For whether a system is working or offline, since when, and when it last made power, use outages.',
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

function wordingPrompt(kind: Reply['kind']): string {
  return [
    "You are SolarLens's assistant, answering the owner of a solar installation.",
    'Answer the latest message from the figures given, and only from them.',
    'Quote numbers exactly as they appear, with their units. Do not add, subtract, average, convert or otherwise work out any number that is not given.',
    'Say which period the figures cover. If they do not answer the message, say what they do show.',
    kind === 'report'
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
      answer: safe ? reply : 'I can answer questions about the energy your systems made, used, bought and sold; how they compare; their faults; why a day was low; '
        + 'whether one is slowly making less; statistics and reports for any period; and how to use SolarLens. Try "a report on last month" or "how do I get alerts on Telegram?".',
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
  const kind: Reply['kind'] = ran.some((c) => c.tool === 'report') ? 'report' : ran.length && ran.every((c) => c.tool === 'app_help') ? 'help' : 'figures';
  if (!results.length) {
    return done({ answer: `I could not answer that from the figures: ${errors.join(' ')}`, worded: 'solarlens', understood, kind, calls: ran, results, errors });
  }
  const plain = results.map((r) => r.summary).join(' ');

  // 3. Wording.
  if (!modelOk || !(await takeCall(env.DB, limit, now))) return done({ answer: plain, worded: 'solarlens', understood, kind, calls: ran, results, errors });
  try {
    const recent = history.slice(-4).map((t) => `${t.role === 'user' ? 'Owner' : 'Assistant'}: ${t.content}`).join('\n');
    const content = `${recent ? `Conversation so far:\n${recent}\n\n` : ''}Latest message: ${question}\nFigures: ${JSON.stringify(results.map(forWording))}`;
    const { text } = await chat(env, [{ role: 'system', content: wordingPrompt(kind) }, { role: 'user', content }], { maxTokens: kind === 'report' ? 700 : 400 });
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
