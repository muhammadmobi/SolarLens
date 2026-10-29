/**
 * Workers AI, on a short lead: one model, a daily cap, and nothing it says
 * trusted as a number.
 *
 * Ask SolarLens and the agents (./ask, ./agents) use a language model for two
 * things only - choosing which read-only tool answers a question, and putting
 * figures the Worker has already computed into a sentence or two. This file is
 * the one place that talks to the model, so the rules are kept here:
 *
 * - **A daily cap.** Workers AI's free allowance is 10,000 "neurons" a day, and
 *   on the free plan a request past it fails. Each call here is counted, for
 *   every feature together, and refused past AI_DAILY_CALLS (100 unless set) -
 *   about fifty questions, well inside the allowance with the model below. The
 *   count is per UTC day, as Cloudflare's allowance is.
 * - **One model**, AI_MODEL or Llama 3.3 70B: good at choosing a tool, able to
 *   answer in JSON when asked, and cheap enough for the cap to mean something.
 * - **Or a server of the owner's choosing.** With AI_BASE_URL (and AI_MODEL)
 *   set, the same calls go to any server that speaks OpenAI's chat completions
 *   - OpenAI itself, Groq, OpenRouter, or a model on the owner's own computer
 *   behind a tunnel - with AI_API_KEY as its key. https only, but for a model
 *   on the same computer: a key never crosses a network in the clear. The cap
 *   applies all the same, since such a server may charge by the call.
 * - **Failure is ordinary.** No binding, no allowance left, a model that did
 *   not answer: every caller has an answer that needs no model, and uses it.
 */
import { nowSec, type Env } from './db';

export const DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
/** Model calls a day, every feature together. */
export const DEFAULT_DAILY_CALLS = 100;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type Provider = 'workers-ai' | 'openai-compatible';
type AiSettings = Pick<Env, 'AI' | 'AI_BASE_URL' | 'AI_MODEL'>;

/** Addresses that never leave the computer the Worker runs on. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * An AI_BASE_URL the Worker will send a key to, with a model named: https -
 * or plain http to this very computer, for trying a model that runs beside
 * `wrangler dev`, where nothing crosses a network.
 */
function externalReady(env: AiSettings): boolean {
  try {
    const u = new URL(env.AI_BASE_URL!);
    return (u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname))) && !!env.AI_MODEL?.trim();
  } catch {
    return false;
  }
}

/**
 * Which model service answers: the owner's own server when AI_BASE_URL is set
 * (and usable), else Workers AI when the `ai` binding is there, else none. A
 * base URL that is set but unusable means none, rather than quietly falling
 * back: the owner asked for their data to go there and nowhere else.
 */
export function providerOf(env: AiSettings): Provider | null {
  if (env.AI_BASE_URL) return externalReady(env) ? 'openai-compatible' : null;
  return env.AI && typeof env.AI.run === 'function' ? 'workers-ai' : null;
}

/** Whether there is a model to ask at all. */
export const hasAi = (env: AiSettings): boolean => providerOf(env) !== null;

export const aiModel = (env: Pick<Env, 'AI_MODEL'>): string => env.AI_MODEL?.trim() || DEFAULT_MODEL;

/** The daily cap: AI_DAILY_CALLS when it is a whole number from 0 to 10,000, or the default. */
export function dailyCalls(env: Pick<Env, 'AI_DAILY_CALLS'>): number {
  const n = Number(env.AI_DAILY_CALLS);
  return env.AI_DAILY_CALLS !== undefined && env.AI_DAILY_CALLS !== '' && Number.isInteger(n) && n >= 0 && n <= 10_000 ? n : DEFAULT_DAILY_CALLS;
}

/** Where today's count lives: one kv row per UTC day, gone two days later. */
const capKey = (now: number) => `ai:calls:${new Date(now * 1000).toISOString().slice(0, 10)}`;

/** How many model calls today has used. */
export async function callsUsed(db: D1Database, now = nowSec()): Promise<number> {
  const row = await db.prepare('SELECT v FROM kv WHERE k = ?1').bind(capKey(now)).first<{ v: string }>();
  return row ? Number(row.v) || 0 : 0;
}

/**
 * Take one call from today's allowance, or false when it is used up. One
 * statement, so two requests at the same moment cannot both take the last.
 */
export async function takeCall(db: D1Database, limit: number, now = nowSec()): Promise<boolean> {
  if (limit <= 0) return false;
  const res = await db
    .prepare(
      `INSERT INTO kv (k, v, expires_at) VALUES (?1, '1', ?2)
       ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(kv.v AS INTEGER) + 1 AS TEXT)
       WHERE CAST(kv.v AS INTEGER) < ?3`,
    )
    .bind(capKey(now), now + 2 * 86400, limit)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * The first JSON object in a reply, or null. A model asked for JSON sometimes
 * wraps it in a sentence or a code fence; this finds the object regardless,
 * by matching braces rather than trusting where the text starts.
 */
export function firstJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '\\') i++;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

/**
 * One call to the model: `messages` in, the reply as text and - when a JSON
 * `schema` was asked for - as the object it holds. Workers AI hands a JSON
 * reply back already parsed, and a plain one as a string; both are taken.
 * The caller has already taken the call from the day's allowance. Throws when
 * the model does not answer, which the caller turns into its own fallback.
 */
export async function chat(
  env: Env, messages: ChatMessage[], opts: { schema?: Record<string, unknown>; maxTokens?: number } = {},
): Promise<{ text: string; json: unknown }> {
  if (providerOf(env) === 'openai-compatible') return chatExternal(env, messages, opts);
  if (!env.AI) throw new Error('no AI binding');
  const out = (await env.AI.run(aiModel(env), {
    messages,
    max_tokens: opts.maxTokens ?? 300,
    // Low, so the same question gets the same tool and much the same words.
    temperature: 0.2,
    ...(opts.schema ? { response_format: { type: 'json_schema', json_schema: opts.schema } } : {}),
  })) as { response?: unknown } | null;
  const r = out?.response;
  if (typeof r === 'string') return { text: r.trim(), json: opts.schema ? firstJsonObject(r) : null };
  if (r && typeof r === 'object') return { text: JSON.stringify(r), json: r };
  throw new Error('the model gave no answer');
}

/**
 * The same call to a server that speaks OpenAI's chat completions. JSON is
 * asked for as a JSON object, which such servers widely support, and read
 * leniently all the same. Errors name the status only - never the address,
 * which may carry a key in it.
 */
async function chatExternal(
  env: Env, messages: ChatMessage[], opts: { schema?: Record<string, unknown>; maxTokens?: number },
): Promise<{ text: string; json: unknown }> {
  const res = await fetch(`${env.AI_BASE_URL!.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(env.AI_API_KEY ? { authorization: `Bearer ${env.AI_API_KEY}` } : {}) },
    body: JSON.stringify({
      model: aiModel(env), messages, max_tokens: opts.maxTokens ?? 300, temperature: 0.2,
      ...(opts.schema ? { response_format: { type: 'json_object' } } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) { await res.body?.cancel(); throw new Error(`the model's server said ${res.status}`); }
  const out = (await res.json().catch(() => null)) as { choices?: { message?: { content?: unknown } }[] } | null;
  const text = out?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('the model gave no answer');
  return { text: text.trim(), json: opts.schema ? firstJsonObject(text) : null };
}
