/**
 * Ask SolarLens, one question at a time: POST /api/ask.
 *
 * The assistant (./assistant) answers conversations; this is its single-turn
 * door, kept for a question with no conversation around it, and for the tabs'
 * own buttons - "Why?" on Historical Data names a tool and its arguments, which
 * skips the understanding and goes straight to the figures.
 *
 * The rule is the assistant's: the model chooses and words, the Worker computes,
 * and a sentence stating a number the figures do not hold is set aside for the
 * figures' own. Without a model - or for a caller who may not spend one - the
 * question is read by SolarLens itself, and answered in the figures' own words.
 */
import { converse, numbersAgree, numbersIn, type Reply } from './assistant';
import { nowSec, type Env } from './db';
import { toolByName, type Args, type ToolLimits, type ToolResult } from './tools';

export { numbersAgree, numbersIn };

/** The longest question taken. */
export const QUESTION_MAX = 300;

export interface AskReply extends Omit<Reply, 'calls' | 'results' | 'errors'> {
  question: string | null;
  /** The first tool the answer used, its arguments and its result - the evidence the tabs show. */
  tool: string | null;
  args: Args;
  result: ToolResult | null;
  /** Every tool the answer used, when there was more than one. */
  results: ToolResult[];
}

type Outcome = { status: number; body: AskReply | { error: string } };

/**
 * Answer `body`: `{question}` in words, or `{tool, args}` directly. `useModel`
 * says whether this caller may spend the day's model calls, and `limits` what
 * it may ask of the tools (see ./assistant converse).
 */
export async function ask(env: Env, body: unknown, useModel: boolean, now = nowSec(), limits: ToolLimits = {}): Promise<Outcome> {
  const b = (body && typeof body === 'object' ? body : {}) as { question?: unknown; tool?: unknown; args?: unknown };
  let question: string | null = null;
  let out: Awaited<ReturnType<typeof converse>>;
  if (typeof b.tool === 'string') {
    const tool = toolByName(b.tool);
    if (!tool) return { status: 400, body: { error: `There is no tool called ${b.tool.slice(0, 40)}.` } };
    out = await converse(env, {
      messages: [{ role: 'user', content: `(from the dashboard) ${tool.name}` }],
      calls: [{ tool: tool.name, args: (b.args && typeof b.args === 'object' ? b.args : {}) as Args }],
    }, useModel, now, limits);
    // A tool asked for directly, whose arguments do not let it answer, is the asker's mistake.
    if (out.status === 200 && 'errors' in out.body && out.body.errors.length && !out.body.results.length) {
      return { status: 400, body: { error: out.body.errors[0].replace(/^[a-z_]+: /, '') } };
    }
  } else {
    if (typeof b.question !== 'string' || b.question.trim().length < 3) return { status: 400, body: { error: 'Ask a question of a few words at least.' } };
    question = b.question.replace(/\s+/g, ' ').trim();
    if (question.length > QUESTION_MAX) return { status: 400, body: { error: `A question is at most ${QUESTION_MAX} characters.` } };
    out = await converse(env, { messages: [{ role: 'user', content: question }] }, useModel, now, limits);
  }
  if (out.status !== 200 || !('answer' in out.body)) return out as Outcome;
  const { calls, results, errors: _errors, ...rest } = out.body;
  return {
    status: 200,
    body: { ...rest, question, tool: calls[0]?.tool ?? null, args: calls[0]?.args ?? {}, result: results[0] ?? null, results },
  };
}
