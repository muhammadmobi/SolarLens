/**
 * Ask SolarLens: a question in, an answer with its evidence out.
 *
 * The model does two small jobs and no arithmetic:
 *
 * 1. **Choosing.** It is shown the read-only tools (./tools), the systems by
 *    name and today's date, and answers with JSON: which tool, and its
 *    arguments. The arguments are checked like any other input before the tool
 *    runs; a question that is not about this dashboard gets a short reply and
 *    no tool.
 * 2. **Wording.** The tool's result - every figure computed and rounded by the
 *    Worker, with the period and how fresh the data was - goes back with the
 *    question, and the model says it in a sentence or two.
 *
 * The reply is then held to the figures (numbersAgree): a number in it that is
 * not one of them - a sum, a percentage or a date the model worked out for
 * itself - means the reply is set aside for the tool's own summary. Either way
 * the answer is shown with the table it came from, the period and the data's
 * freshness, so it can be checked by eye.
 *
 * A caller may also name a tool and its arguments directly - "why was this day
 * low?" from Historical Data does - which skips the choosing. With no model, or
 * none left today, a direct call still answers, in the tool's own words.
 */
import { aiModel, callsUsed, chat, dailyCalls, hasAi, takeCall, type ChatMessage } from './ai';
import { nowSec, type Env } from './db';
import { RANGES, TOOLS, dayNo, dayWords, isoDay, jsonSchemaOf, loadSystems, runTool, zoneOf, type Args, type ToolResult } from './tools';

/** The longest question taken. */
export const QUESTION_MAX = 300;
/** Rows of a result a model is shown; the facts and the summary carry the rest. */
const ROWS_SHOWN = 24;

export interface AskReply {
  question: string | null;
  tool: string | null;
  args: Args;
  answer: string;
  /** Who put the answer in words: the model, or SolarLens from the figures alone. */
  worded: 'model' | 'solarlens';
  result: ToolResult | null;
  /** Today's model calls, used and allowed. */
  used: number;
  limit: number;
  model: string | null;
}

// ---------------------------------------------------------------- holding a reply to the figures

/** Every number written in a piece of text: "1,234.5" is 1234.5, "21 Sep" has a 21. */
export function numbersIn(text: string): number[] {
  return (text.match(/-?\d+(?:[.,]\d+)*/g) ?? [])
    .map((t) => {
      // "1,234" is a thousands separator; "0,5" would be a decimal, but a model writes English.
      const n = Number(t.replace(/,(?=\d{3}(\D|$))/g, '').replace(',', '.'));
      return Math.abs(n);
    })
    .filter((n) => Number.isFinite(n));
}

/**
 * Whether every number in `answer` is one the result gave - as written, or
 * rounded the way a person would say it (412.3 kWh as "412"), or as MWh.
 * Counts up to ten pass as they are: "two of the three systems".
 */
export function numbersAgree(answer: string, result: ToolResult): boolean {
  const known = numbersIn(JSON.stringify({ ...result, rows: result.rows.slice(0, ROWS_SHOWN) }));
  return numbersIn(answer).every((n) => {
    if (Number.isInteger(n) && n <= 10) return true;
    return known.some((k) => Math.abs(k - n) <= Math.max(0.51, Math.abs(k) * 0.006)
      || (k >= 1000 && Math.abs(k / 1000 - n) <= Math.max(0.051, (k / 1000) * 0.006)));
  });
}

// ---------------------------------------------------------------- the prompts

/** What the model is shown to choose a tool: the tools, the systems, and today. */
async function choosingPrompt(db: D1Database, now: number): Promise<string> {
  const systems = await loadSystems(db);
  const today = isoDay(dayNo(now, zoneOf(systems)));
  const tools = TOOLS.map((t) => `- ${t.name}: ${t.description}\n  arguments: ${JSON.stringify(jsonSchemaOf(t).properties)}`).join('\n');
  return [
    'You route questions about one owner\'s solar dashboard, SolarLens, to the one read-only tool that answers them.',
    `Today is ${dayWords(today, true)} (${today}) where the panels are. Weeks run Monday to Sunday.`,
    `The systems: ${systems.map((s) => `"${s.name}"${s.kwp ? ` (${s.kwp} kWp)` : ''}`).join(', ') || 'none yet'}.`,
    'The tools:',
    tools,
    `For a period, use "range" when one of ${RANGES.join(', ')} fits; otherwise "from" and "to" as YYYY-MM-DD (a month is its first and last day, a year 1 January to 31 December).`,
    'Name a system exactly as listed, or leave "system" out for all of them.',
    'Answer with JSON only: {"tool": "<name>", "args": {...}}.',
    'If the question is not about this solar data, answer {"tool": "none", "reply": "<one short sentence saying what you can answer>"}.',
  ].join('\n');
}

const WORDING_PROMPT = [
  'You are Ask SolarLens, answering the owner of a solar installation.',
  'Answer the question in one to three short sentences, using only the figures given.',
  'Quote numbers exactly as they appear, with their units. Do not add, subtract, average, convert or otherwise work out any number that is not given.',
  'Mention the period the figures cover. If the figures do not answer the question, say what they do show.',
  'Plain text only: no markdown, no lists, no greeting.',
].join('\n');

/** A result cut down to what a model needs to word it. */
function forWording(r: ToolResult) {
  return {
    title: r.title, period: r.period?.label ?? null, columns: r.columns,
    rows: r.rows.slice(0, ROWS_SHOWN), more_rows: Math.max(0, r.rows.length - ROWS_SHOWN),
    facts: r.facts, notes: r.notes, summary: r.summary,
  };
}

const ROUTE_SCHEMA = {
  type: 'object',
  properties: {
    tool: { type: 'string', enum: [...TOOLS.map((t) => t.name), 'none'] },
    args: { type: 'object' },
    reply: { type: 'string' },
  },
  required: ['tool'],
};

// ---------------------------------------------------------------- asking

type Outcome = { status: number; body: AskReply | { error: string } };

/**
 * Answer `body`: `{question}` in words, or `{tool, args}` directly. The day's
 * model calls are taken one at a time, as each is made; a question whose
 * wording finds none left is answered in the tool's own words.
 */
export async function ask(env: Env, body: unknown, now = nowSec()): Promise<Outcome> {
  const b = (body && typeof body === 'object' ? body : {}) as { question?: unknown; tool?: unknown; args?: unknown };
  const limit = dailyCalls(env);
  const reply = async (r: Omit<AskReply, 'used' | 'limit' | 'model'>, worded = r.worded): Promise<Outcome> => ({
    status: 200,
    body: { ...r, worded, used: await callsUsed(env.DB, now), limit, model: hasAi(env) ? aiModel(env) : null },
  });

  let question: string | null = null;
  let tool: string;
  let raw: unknown;
  if (typeof b.tool === 'string') {
    tool = b.tool;
    raw = b.args;
  } else {
    if (typeof b.question !== 'string' || b.question.trim().length < 3) return { status: 400, body: { error: 'Ask a question of a few words at least.' } };
    question = b.question.replace(/\s+/g, ' ').trim();
    if (question.length > QUESTION_MAX) return { status: 400, body: { error: `A question is at most ${QUESTION_MAX} characters.` } };
    if (!hasAi(env)) return { status: 503, body: { error: 'Ask SolarLens needs Workers AI, and this Worker has no AI binding. The README says how to add one.' } };
    if (!(await takeCall(env.DB, limit, now))) {
      return { status: 429, body: { error: `Today's ${limit} model calls are used up; asking starts again at midnight UTC. The tabs still show every figure.` } };
    }
    let chosen: { tool?: unknown; args?: unknown; reply?: unknown } | null;
    try {
      const messages: ChatMessage[] = [{ role: 'system', content: await choosingPrompt(env.DB, now) }, { role: 'user', content: question }];
      chosen = (await chat(env, messages, { schema: ROUTE_SCHEMA, maxTokens: 200 })).json as typeof chosen;
    } catch (e) {
      console.warn(JSON.stringify({ ask: 'choosing failed', error: String(e).slice(0, 200) }));
      return { status: 502, body: { error: 'The model did not answer. Try again in a moment.' } };
    }
    if (!chosen || typeof chosen.tool !== 'string') {
      return reply({ question, tool: null, args: {}, answer: 'I could not tell which figures that needs. Try asking about a period, a system, or a day.', worded: 'solarlens', result: null });
    }
    if (chosen.tool === 'none') {
      const said = typeof chosen.reply === 'string' && chosen.reply.trim() ? chosen.reply.trim().slice(0, 300) : '';
      return reply({ question, tool: null, args: {}, answer: said || 'I can answer questions about this dashboard\'s figures: energy, systems, faults and days.', worded: said ? 'model' : 'solarlens', result: null });
    }
    tool = chosen.tool;
    raw = chosen.args;
  }

  const ran = await runTool(env.DB, tool, raw, now);
  if ('error' in ran) {
    if (question === null) return { status: 400, body: { error: ran.error } };
    return reply({ question, tool, args: {}, answer: `I could not answer that from the figures: ${ran.error}`, worded: 'solarlens', result: null });
  }
  const base = { question, tool, args: ran.args, result: ran.result };
  const plain = () => reply({ ...base, answer: ran.result.summary, worded: 'solarlens' });

  // Wording, when there is a model and a call left today; the figures alone otherwise.
  if (!hasAi(env) || !(await takeCall(env.DB, limit, now))) return plain();
  try {
    const content = `Question: ${question ?? `(from the dashboard) ${ran.result.title}`}\nFigures: ${JSON.stringify(forWording(ran.result))}`;
    const { text } = await chat(env, [{ role: 'system', content: WORDING_PROMPT }, { role: 'user', content }], { maxTokens: 220 });
    const answer = text.replace(/\s+/g, ' ').trim().slice(0, 600);
    if (!answer || !numbersAgree(answer, ran.result)) return plain();
    return reply({ ...base, answer, worded: 'model' });
  } catch (e) {
    console.warn(JSON.stringify({ ask: 'wording failed', error: String(e).slice(0, 200) }));
    return plain();
  }
}
