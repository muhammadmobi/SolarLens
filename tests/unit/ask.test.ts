/**
 * Ask SolarLens: the model chooses and words, the Worker computes.
 *
 * Workers AI is replaced by a script of replies, so each test says exactly
 * what the model "answered" and can read what it was sent. Held to the
 * promises in src/ask.ts and the assistant behind it: the model's choice is
 * checked like any input, a sentence stating a number the figures do not hold
 * is set aside for the tool's own words, the day's cap is kept, nobody
 * anonymous spends it, and with no model at all - or none left today - the
 * question is read by SolarLens itself and answered from the figures.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ask, numbersAgree, numbersIn, type AskReply } from '../../src/ask';
import { DEFAULT_MODEL, aiModel, callsUsed, chat, dailyCalls, firstJsonObject, hasAi, takeCall } from '../../src/ai';
import { createShare, setRequired } from '../../src/auth/sessions';
import type { Env } from '../../src/db';
import type { ToolResult } from '../../src/tools';
import { bearer, createHarness, type Harness } from '../helpers/worker';
import { addDay, addSystem, dayNumber, isoOf } from '../helpers/solar-days';

/** Monday 28 September 2026, 09:00 UTC. */
const NOW = Date.UTC(2026, 8, 28, 9) / 1000;
const API = 'api-token-for-tests';

/** A Workers AI that answers from a script, in order, and remembers what it was asked. */
function scriptedAi(replies: unknown[]) {
  const calls: { model: string; inputs: { messages: { role: string; content: string }[]; response_format?: unknown } }[] = [];
  const AI = {
    async run(model: string, inputs: Record<string, unknown>) {
      calls.push({ model, inputs: inputs as (typeof calls)[number]['inputs'] });
      const r = replies.shift();
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { AI, calls };
}

/** Last week: Roof 18 kWh a day, 5 of it sold; Garage 12, its export not metered. */
async function lastWeek(db: D1Database, around = NOW) {
  await addSystem(db, { id: 'solarman:station:alpha', name: 'Roof', kwp: 5 });
  await addSystem(db, { id: 'solarman:station:beta', name: 'Garage', kwp: 4 });
  const today = Math.floor(around / 86400);
  for (let n = today - 8; n < today; n++) {
    await addDay(db, 'solarman:station:alpha', isoOf(n), 18, { exported: 5 });
    await addDay(db, 'solarman:station:beta', isoOf(n), 12);
  }
}

const reply = (out: Awaited<ReturnType<typeof ask>>) => out.body as AskReply;

describe('holding a reply to the figures', () => {
  it('reads every number written in a sentence', () => {
    expect(numbersIn('1,234.5 kWh on 21 Sep 2026, 86% more')).toEqual([1234.5, 21, 2026, 86]);
    expect(firstJsonObject('Sure! {"tool": "faults", "args": {"note": "a } in text"}} and more')).toEqual({ tool: 'faults', args: { note: 'a } in text' } });
    expect(firstJsonObject('no json here')).toBeNull();
    expect(firstJsonObject('{broken')).toBeNull();
  });

  const result = {
    tool: 'energy', title: 'Energy', period: { from: '2026-09-21', to: '2026-09-27', label: 'last week (21 – 27 Sep 2026)' },
    columns: [], rows: [], facts: { total_made_kwh: 412.3, lifetime_kwh: 1234.5, change_pct: 86 }, notes: [], summary: '', freshness: { newest: null, offline: [] },
  } satisfies ToolResult;

  it('takes a number as given, rounded as a person says it, or in MWh - and small counts as they are', () => {
    expect(numbersAgree('Your systems made 412.3 kWh last week, 21 – 27 Sep 2026.', result)).toBe(true);
    expect(numbersAgree('About 412 kWh, 86% more.', result)).toBe(true);
    expect(numbersAgree('1.2 MWh in its life, from 2 of the 3 systems.', result)).toBe(true);
  });

  it('refuses a number it was not given: a sum, a difference, a percentage of its own', () => {
    expect(numbersAgree('Your systems made 450 kWh.', result)).toBe(false);
    expect(numbersAgree('That is 87% more.', result)).toBe(false);
    expect(numbersAgree('Together, 1646.8 kWh.', result)).toBe(false);
  });
});

describe('asking', () => {
  let h: Harness;
  afterEach(() => h.close());
  const withAi = (replies: unknown[], over: Partial<Env> = {}) => {
    const ai = scriptedAi(replies);
    h = createHarness({ AI: ai.AI, ...over });
    return ai;
  };

  it('lets the model choose the tool, runs it, and has the model word the figures', async () => {
    const ai = withAi([
      { response: { calls: [{ tool: 'energy', args: { range: 'last_week', measure: 'exported' } }] } },
      { response: 'Your systems sold 35 kWh to the grid last week, 21 – 27 Sep 2026; Garage does not report its export.' },
    ]);
    await lastWeek(h.env.DB);
    const out = await ask(h.env, { question: 'How much did I export last week?' }, true, NOW);
    expect(out.status).toBe(200);
    expect(reply(out)).toMatchObject({
      question: 'How much did I export last week?', tool: 'energy', args: { range: 'last_week', measure: 'exported' },
      answer: 'Your systems sold 35 kWh to the grid last week, 21 – 27 Sep 2026; Garage does not report its export.',
      worded: 'model', understood: 'model', kind: 'figures', used: 2, limit: 100, model: DEFAULT_MODEL, provider: 'workers-ai',
    });
    expect(reply(out).result?.facts.total_exported_kwh).toBe(35);

    // What the model was shown to choose: today, the systems, every tool, and JSON only.
    const choosing = ai.calls[0].inputs;
    expect(ai.calls[0].model).toBe(DEFAULT_MODEL);
    expect(choosing.messages[0].content).toContain('Today is Mon 28 Sep 2026 (2026-09-28)');
    expect(choosing.messages[0].content).toContain('"Roof" (5 kWp), "Garage" (4 kWp)');
    for (const t of ['status_now', 'outages', 'energy', 'power_day', 'compare_systems', 'stats', 'faults', 'day_report', 'performance_trend', 'report', 'app_help']) expect(choosing.messages[0].content).toContain(`- ${t}:`);
    expect(choosing.messages[1]).toEqual({ role: 'user', content: 'How much did I export last week?' });
    expect(choosing.response_format).toMatchObject({ type: 'json_schema', json_schema: { properties: { calls: { type: 'array' } } } });
    // What it was shown to word: the question and the Worker's figures, not a database.
    const wording = ai.calls[1].inputs.messages;
    expect(wording[0].content).toContain('Do not add, subtract, average');
    expect(wording[1].content).toContain('Latest message: How much did I export last week?');
    expect(wording[1].content).toContain('"total_exported_kwh":35');
    expect(JSON.stringify(ai.calls)).not.toMatch(/station|alpha|beta/);
  });

  it("sets aside a sentence with a number of the model's own, for the tool's own words", async () => {
    withAi([
      { response: { calls: [{ tool: 'energy', args: { range: 'last_week', measure: 'exported' } }] } },
      { response: 'You sold 36 kWh last week.' },
    ]);
    await lastWeek(h.env.DB);
    const r = reply(await ask(h.env, { question: 'How much did I export last week?' }, true, NOW));
    expect(r.worded).toBe('solarlens');
    expect(r.answer).toBe(r.result?.summary);
    expect(r.answer.startsWith('Your systems sold 35 kWh to the grid last week')).toBe(true);
  });

  it("finds the choice inside a chatty reply, and falls back to the figures' own words when wording fails", async () => {
    withAi([{ response: 'Sure! {"calls": [{"tool": "faults", "args": {"range": "last_week"}}]}' }, new Error('model busy')]);
    await lastWeek(h.env.DB);
    const r = reply(await ask(h.env, { question: 'Any faults last week?' }, true, NOW));
    expect(r).toMatchObject({ tool: 'faults', worded: 'solarlens', answer: 'No faults were recorded last week (21 – 27 Sep 2026).' });
  });

  it('answers a question about something else in a sentence, and spends no second call', async () => {
    const ai = withAi([{ response: { calls: [], reply: 'I can only answer questions about your solar figures.' } }]);
    const r = reply(await ask(h.env, { question: 'What is the capital of France?' }, true, NOW));
    expect(r).toMatchObject({ tool: null, result: null, worded: 'model', kind: 'chat', answer: 'I can only answer questions about your solar figures.', used: 1 });
    expect(ai.calls).toHaveLength(1);
  });

  it('says what was wrong when the model chose arguments the tool does not take, or no tool at all', async () => {
    withAi([{ response: { calls: [{ tool: 'energy', args: { range: 'someday' } }] } }, { response: { args: {} } }]);
    await lastWeek(h.env.DB);
    const bad = reply(await ask(h.env, { question: 'How much someday?' }, true, NOW));
    expect(bad).toMatchObject({ tool: null, result: null, worded: 'solarlens' });
    expect(bad.answer).toMatch(/^I could not answer that from the figures: energy: range is one of/);
    // No calls and no reply: SolarLens reads it itself, and "Hmm?" says nothing it can look up.
    const none = reply(await ask(h.env, { question: 'Hmm?' }, true, NOW));
    expect(none).toMatchObject({ kind: 'chat', understood: 'solarlens', worded: 'solarlens' });
    expect(none.answer).toMatch(/^I can answer questions about the energy your systems made/);
  });

  it('reads the question itself when the model does not answer at all', async () => {
    withAi([new Error('4006: daily free allocation used up')]);
    await lastWeek(h.env.DB);
    const r = reply(await ask(h.env, { question: 'How much did I make yesterday?' }, true, NOW));
    expect(r).toMatchObject({ understood: 'solarlens', worded: 'solarlens', tool: 'energy', args: { range: 'yesterday' } });
    expect(r.answer).toBe('Your systems made 30 kWh yesterday (Sun 27 Sep 2026).');
  });

  it('keeps to the daily cap: past it, SolarLens reads the question itself and answers from the figures', async () => {
    // The second reply is the next day's: this day's one call is spent on the first question.
    const ai = withAi([{ response: { calls: [{ tool: 'energy', args: { range: 'last_week' } }] } }, { response: { calls: [{ tool: 'energy', args: { range: 'last_week' } }] } }], { AI_DAILY_CALLS: '1' });
    await lastWeek(h.env.DB);
    const first = reply(await ask(h.env, { question: 'How much last week?' }, true, NOW));
    expect(first).toMatchObject({ tool: 'energy', understood: 'model', worded: 'solarlens', used: 1, limit: 1 });
    const second = reply(await ask(h.env, { question: 'How much did I sell last week?' }, true, NOW));
    expect(second).toMatchObject({ understood: 'solarlens', worded: 'solarlens', args: { range: 'last_week', measure: 'exported' } });
    expect(ai.calls).toHaveLength(1);
    // A new day, a new allowance.
    expect(reply(await ask(h.env, { question: 'How much last week?' }, true, NOW + 86400)).understood).toBe('model');
  });

  it('takes a question of a few words, and not an essay', async () => {
    withAi([]);
    expect(await ask(h.env, { question: 'hi' }, true, NOW)).toEqual({ status: 400, body: { error: 'Ask a question of a few words at least.' } });
    expect((await ask(h.env, { question: 'why '.repeat(100) }, true, NOW)).status).toBe(400);
    expect((await ask(h.env, null, true, NOW)).status).toBe(400);
  });

  it('with no model, reads a question itself, and answers a tool asked for directly, in the figures\' own words', async () => {
    h = createHarness();
    await lastWeek(h.env.DB);
    const asked = reply(await ask(h.env, { question: 'How much did I export last week?' }, true, NOW));
    expect(asked).toMatchObject({ understood: 'solarlens', worded: 'solarlens', tool: 'energy', model: null, provider: null });
    expect(asked.answer.startsWith('Your systems sold 35 kWh')).toBe(true);
    const out = await ask(h.env, { tool: 'energy', args: { range: 'last_week', measure: 'exported' } }, true, NOW);
    expect(out.status).toBe(200);
    expect(reply(out)).toMatchObject({ question: null, tool: 'energy', worded: 'solarlens', used: 0, model: null });
    expect(reply(out).answer.startsWith('Your systems sold 35 kWh')).toBe(true);
    expect(await ask(h.env, { tool: 'drop_tables', args: {} }, true, NOW)).toEqual({ status: 400, body: { error: 'There is no tool called drop_tables.' } });
    expect(await ask(h.env, { tool: 'energy', args: { range: 'someday' } }, true, NOW)).toEqual({ status: 400, body: { error: expect.stringContaining('range is one of') } });
  });
});

describe('the routes', () => {
  let h: Harness;
  beforeEach(() => { h = createHarness(); });
  afterEach(() => h.close());
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    h.fetch('/api/ask', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it("let anyone who may read ask, and only someone signed in spend the day's model calls", async () => {
    const now = Math.floor(Date.now() / 1000);
    await lastWeek(h.env.DB, now);
    const direct = { tool: 'energy', args: { range: 'last_week' } };
    // Anonymous, on an open dashboard: answered, from the figures alone.
    const anonymous = await post(direct);
    expect(anonymous.status).toBe(200);
    expect(await anonymous.json()).toMatchObject({ worded: 'solarlens' });
    expect((await post(direct, bearer(API))).status).toBe(200);
    const share = await createShare(h.env.DB, 'Family', null, now);
    const asViewer = await post(direct, bearer(share.token));
    expect(asViewer.status).toBe(200);
    expect(asViewer.headers.get('cache-control')).toBe('no-store');
    expect(((await asViewer.json()) as AskReply).result?.tool).toBe('energy');
    // With sign-in required, a stranger is asked to sign in, as for any read.
    await setRequired(h.env.DB, true, now);
    expect(await (await post(direct)).json()).toEqual({ error: 'signin' });
  });

  it('spend a model call only for someone signed in', async () => {
    const ai = scriptedAi([{ response: { calls: [{ tool: 'energy', args: { range: 'last_week' } }] } }, { response: 'Your systems made 210 kWh last week.' }]);
    const withModel = createHarness({ AI: ai.AI });
    const now = Math.floor(Date.now() / 1000);
    await lastWeek(withModel.env.DB, now);
    const ask2 = (headers: Record<string, string>) => withModel.fetch('/api/ask', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ question: 'How much last week?' }) });
    expect(await (await ask2({})).json()).toMatchObject({ understood: 'solarlens' });
    expect(ai.calls).toHaveLength(0);
    expect(await (await ask2(bearer(API))).json()).toMatchObject({ understood: 'model' });
    expect(ai.calls).toHaveLength(2);
    withModel.close();
  });

  it('say whether asking works here, and for whom', async () => {
    expect(await (await h.fetch('/api/ask/status')).json()).toEqual({ available: false, model: null, provider: null, used: 0, limit: 100, can_ask: false });
    const withAi = createHarness({ AI: scriptedAi([]).AI, AI_MODEL: '@cf/made-up/model', AI_DAILY_CALLS: '40' });
    expect(await (await withAi.fetch('/api/ask/status', { headers: bearer(API) })).json())
      .toEqual({ available: true, model: '@cf/made-up/model', provider: 'workers-ai', used: 0, limit: 40, can_ask: true });
    withAi.close();
  });

  it('list the tools with their arguments, and run one with no model, as a read like any other', async () => {
    const now = Math.floor(Date.now() / 1000);
    await lastWeek(h.env.DB, now);
    const list = (await (await h.fetch('/api/tools')).json()) as { tools: { name: string; input_schema: { type: string } }[] };
    expect(list.tools.map((t) => t.name)).toEqual(['status_now', 'outages', 'energy', 'power_day', 'compare_systems', 'stats', 'faults', 'day_report', 'performance_trend', 'report', 'app_help']);
    expect(list.tools[1].input_schema.type).toBe('object');
    const ran = await h.fetch('/api/tools/compare_systems?range=last_week');
    expect(ran.status).toBe(200);
    expect(((await ran.json()) as { result: ToolResult }).result.facts.best_system).toBe('Roof');
    expect((await h.fetch('/api/tools/nope')).status).toBe(404);
    expect((await h.fetch('/api/tools/energy?range=someday')).status).toBe(400);
    await setRequired(h.env.DB, true, now);
    expect((await h.fetch('/api/tools/energy')).status).toBe(401);
    expect((await h.fetch('/api/tools/energy', { headers: bearer(API) })).status).toBe(200);
  });
});

// The dates the seed writes are whole days before `around`; this keeps them honest.
it('seeds whole days before the moment given', () => {
  expect(isoOf(dayNumber('2026-09-27'))).toBe('2026-09-27');
});

describe("the model's lead (src/ai.ts)", () => {
  it('takes the cap and the model from the settings only when they make sense', () => {
    expect(dailyCalls({})).toBe(100);
    expect(dailyCalls({ AI_DAILY_CALLS: '0' })).toBe(0);
    expect(dailyCalls({ AI_DAILY_CALLS: '250' })).toBe(250);
    for (const bad of ['', 'lots', '-1', '2.5', '99999']) expect(dailyCalls({ AI_DAILY_CALLS: bad })).toBe(100);
    expect(aiModel({})).toBe(DEFAULT_MODEL);
    expect(aiModel({ AI_MODEL: '  @cf/made-up/model ' })).toBe('@cf/made-up/model');
    expect(hasAi({})).toBe(false);
  });

  it('counts calls per UTC day, and never past the cap - nor at all with a cap of nothing', async () => {
    const h = createHarness();
    expect(await takeCall(h.env.DB, 0, NOW)).toBe(false);
    expect(await takeCall(h.env.DB, 2, NOW)).toBe(true);
    expect(await takeCall(h.env.DB, 2, NOW)).toBe(true);
    expect(await takeCall(h.env.DB, 2, NOW)).toBe(false);
    expect(await callsUsed(h.env.DB, NOW)).toBe(2);
    expect(await callsUsed(h.env.DB, NOW + 86400)).toBe(0);
    h.close();
  });

  it('reads a reply as text or as the object JSON mode hands back, and throws when there is none', async () => {
    const h = createHarness();
    const env = (response: unknown) => ({ ...h.env, AI: { run: async () => ({ response }) } });
    expect(await chat(env('  plain words  '), [])).toEqual({ text: 'plain words', json: null });
    expect(await chat(env('here: {"tool":"energy"}'), [], { schema: {} })).toEqual({ text: 'here: {"tool":"energy"}', json: { tool: 'energy' } });
    expect(await chat(env({ tool: 'faults' }), [], { schema: {} })).toEqual({ text: '{"tool":"faults"}', json: { tool: 'faults' } });
    await expect(chat(env(undefined), [])).rejects.toThrow('no answer');
    await expect(chat(h.env, [])).rejects.toThrow('no AI binding');
    h.close();
  });
});
