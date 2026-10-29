/**
 * The assistant: a conversation about SolarLens and its figures.
 *
 * Held to src/assistant.ts: a question is read the way a person means it - its
 * kind, its period, its system - with a model or without one; a follow-up
 * moves the turn before; up to three tools answer one message; the model is
 * shown the conversation and held to the figures; a reply of its own never
 * states a figure; and the same calls go to a server of the owner's choosing
 * when one is set. Workers AI and any other server are scripts here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkTurns, converse, guessCalls, mend, periodBefore, periodIn, timesIn, type Call, type Reply } from '../../src/assistant';
import { hasAi, providerOf } from '../../src/ai';
import { setRequired } from '../../src/auth/sessions';
import type { Env } from '../../src/db';
import type { Sys } from '../../src/tools';
import { bearer, createHarness, type Harness } from '../helpers/worker';
import { addDay, addSystem, dayNumber, isoOf } from '../helpers/solar-days';

/** Monday 28 September 2026, 09:00 UTC. */
const NOW = Date.UTC(2026, 8, 28, 9) / 1000;
const TODAY = '2026-09-28';
const SYSTEMS: Sys[] = [
  { id: 'solarman:station:alpha', alias: 's1', name: 'Roof', provider: 'solarman', kwp: 5, off: 0 },
  { id: 'solarman:station:beta', alias: 's2', name: 'Garage roof', provider: 'solarman', kwp: 4, off: 0 },
];

afterEach(() => { vi.unstubAllGlobals(); });

describe('reading a period in plain words', () => {
  it('knows the named ones, a month by name, a day, a date and a year', () => {
    expect(periodIn('how much last week?', TODAY)).toEqual({ range: 'last_week' });
    expect(periodIn('What about YESTERDAY', TODAY)).toEqual({ range: 'yesterday' });
    expect(periodIn('the past 30 days', TODAY)).toEqual({ range: 'last_30_days' });
    expect(periodIn('what did I make in August?', TODAY)).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(periodIn('in feb 2024', TODAY)).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    // A month still to come this year means last year's.
    expect(periodIn('in November', TODAY)).toEqual({ from: '2025-11-01', to: '2025-11-30' });
    expect(periodIn('on 21 September', TODAY)).toEqual({ from: '2026-09-21', to: '2026-09-21' });
    expect(periodIn('september 3rd', TODAY)).toEqual({ from: '2026-09-03', to: '2026-09-03' });
    expect(periodIn('on 2026-09-14', TODAY)).toEqual({ from: '2026-09-14', to: '2026-09-14' });
    expect(periodIn('the whole of 2025', TODAY)).toEqual({ from: '2025-01-01', to: '2025-12-31' });
    expect(periodIn('how is it doing', TODAY)).toBeNull();
  });

  it('does not take "may" the verb for May the month', () => {
    expect(periodIn('may I see the faults?', TODAY)).toBeNull();
    expect(periodIn('what happened in may?', TODAY)).toEqual({ from: '2026-05-01', to: '2026-05-31' });
    expect(periodIn('may 2025', TODAY)).toEqual({ from: '2025-05-01', to: '2025-05-31' });
  });

  it('finds the whole period before one: the year, the month, the week, or as many days again', () => {
    const p = (from: string, to: string) => ({ from, to, label: '' });
    expect(periodBefore(p('2026-08-01', '2026-08-31'))).toEqual({ from: '2026-07-01', to: '2026-07-31' });
    expect(periodBefore(p('2026-01-01', '2026-01-31'))).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(periodBefore(p('2026-03-01', '2026-03-31'))).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(periodBefore(p('2025-01-01', '2025-12-31'))).toEqual({ from: '2024-01-01', to: '2024-12-31' });
    expect(periodBefore(p('2026-09-21', '2026-09-27'))).toEqual({ from: '2026-09-14', to: '2026-09-20' });
    // So far this month, this year and this week: the whole one before.
    expect(periodBefore(p('2026-09-01', '2026-09-28'), 'this_month')).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(periodBefore(p('2026-01-01', '2026-09-28'), 'this_year')).toEqual({ from: '2025-01-01', to: '2025-12-31' });
    expect(periodBefore(p('2026-09-28', '2026-09-28'), 'this_week')).toEqual({ from: '2026-09-21', to: '2026-09-27' });
    // The first days of a month, or of a year, are not the month or the year.
    expect(periodBefore(p('2026-06-01', '2026-06-07'))).toEqual({ from: '2026-05-25', to: '2026-05-31' });
    expect(periodBefore(p('2026-01-01', '2026-01-07'), 'last_7_days')).toEqual({ from: '2025-12-25', to: '2025-12-31' });
  });
});

describe('reading a question without a model', () => {
  const guess = (q: string, previous = []) => guessCalls(q, SYSTEMS, NOW, 0, previous);

  it('takes its kind from its words', () => {
    expect(guess('How do I get alerts on Telegram?')).toEqual([{ tool: 'app_help', args: { question: 'How do I get alerts on Telegram?' } }]);
    expect(guess('Write me a report on last month')).toEqual([{ tool: 'report', args: { range: 'last_month' } }]);
    expect(guess('Why was yesterday so low?')).toEqual([{ tool: 'day_report', args: { date: 'yesterday' } }]);
    expect(guess('why was 21 September low for the garage roof')).toEqual([{ tool: 'day_report', args: { date: '2026-09-21', system: 'Garage roof' } }]);
    expect(guess('Is the Roof degrading?')).toEqual([{ tool: 'performance_trend', args: { system: 'Roof' } }]);
    expect(guess('any faults this year?')).toEqual([{ tool: 'faults', args: { range: 'this_year' } }]);
    expect(guess('compare my systems in August')).toEqual([{ tool: 'compare_systems', args: { from: '2026-08-01', to: '2026-08-31' } }]);
    expect(guess('statistics for the last 30 days')).toEqual([{ tool: 'stats', args: { range: 'last_30_days' } }]);
    expect(guess('what is it producing right now?')).toEqual([{ tool: 'status_now', args: {} }]);
    expect(guess('how much did I sell last week')).toEqual([{ tool: 'energy', args: { measure: 'exported', range: 'last_week' } }]);
    expect(guess('How much did the house use yesterday?')).toEqual([{ tool: 'energy', args: { measure: 'used', range: 'yesterday' } }]);
    expect(guess('Which month produced the most this year?')).toEqual([{ tool: 'energy', args: { group_by: 'month', range: 'this_year' } }]);
    expect(guess('blue elephants')).toBeNull();
  });

  it('names the system a question names - the longest name it contains - and by alias', () => {
    expect(guess('energy of the garage roof last week')).toEqual([{ tool: 'energy', args: { range: 'last_week', system: 'Garage roof' } }]);
    expect(guess('energy for s1 today')).toEqual([{ tool: 'energy', args: { range: 'today', system: 'Roof' } }]);
  });

  it('moves the turn before for a follow-up: another period, the one before, another system', () => {
    const before = [{ tool: 'energy', args: { range: 'last_month', measure: 'exported' } }] as never;
    expect(guess('and the month before?', before)).toEqual([{ tool: 'energy', args: { measure: 'exported', from: '2026-07-01', to: '2026-07-31' } }]);
    expect(guess('what about this year?', before)).toEqual([{ tool: 'energy', args: { measure: 'exported', range: 'this_year' } }]);
    expect(guess('and for the Roof?', before)).toEqual([{ tool: 'energy', args: { measure: 'exported', range: 'last_month', system: 'Roof' } }]);
    const why = [{ tool: 'day_report', args: { date: '2026-09-27' } }] as never;
    expect(guess('and the day before?', why)).toEqual([{ tool: 'day_report', args: { date: '2026-09-26' } }]);
    // With no period named, the one before is before the tool's own: a report covers last month, faults the last 30 days.
    expect(guess('and the one before?', [{ tool: 'report', args: {} }] as never)).toEqual([{ tool: 'report', args: { from: '2026-07-01', to: '2026-07-31' } }]);
    expect(guess('and the previous?', [{ tool: 'faults', args: {} }] as never)).toEqual([{ tool: 'faults', args: { from: '2026-07-31', to: '2026-08-29' } }]);
    // This week so far steps back a whole week; the first week of a month steps back a week, not a month.
    expect(guess('and the week before?', [{ tool: 'energy', args: { range: 'this_week' } }] as never)).toEqual([{ tool: 'energy', args: { from: '2026-09-21', to: '2026-09-27' } }]);
    expect(guess('and the week before?', [{ tool: 'energy', args: { from: '2026-09-01', to: '2026-09-07' } }] as never)).toEqual([{ tool: 'energy', args: { from: '2026-08-25', to: '2026-08-31' } }]);
    // A question with a kind of its own is not a follow-up.
    expect(guess('any faults last week?', before)).toEqual([{ tool: 'faults', args: { range: 'last_week' } }]);
  });
});

describe('the questions an owner asks of a day, as typed', () => {
  // Two made-up systems, named the way owners name them: a brand or place, and what the inverter is.
  const SITES: Sys[] = [
    { id: 'soliscloud:plant:gamma', alias: 's1', name: 'Riverside Ongrid', provider: 'soliscloud', kwp: 12, off: 0 },
    { id: 'solarman:station:delta', alias: 's2', name: 'Orchard Hybrid', provider: 'solarman', kwp: 3.5, off: 0 },
  ];
  const ask = (q: string, previous: Call[] = []) => guessCalls(q, SITES, NOW, 0, previous);

  it('reads them as they were asked: a time of day, one word of a name, and the typing', () => {
    expect(ask('how much genration is done bewtwwn 2pm aand 4pm today ?')).toEqual([{ tool: 'power_day', args: { date: 'today', start: '14:00', end: '16:00' } }]);
    expect(ask('what is power fluctarion today')).toEqual([{ tool: 'power_day', args: { date: 'today' } }]);
    expect(ask('what is power fluctuations today on orchard invertor?')).toEqual([{ tool: 'power_day', args: { date: 'today', system: 'Orchard Hybrid' } }]);
    expect(ask('from when riverside is not working?')).toEqual([{ tool: 'outages', args: { system: 'Riverside Ongrid' } }]);
    expect(ask('last genrated riverside pv and whn it was ofline?')).toEqual([{ tool: 'outages', args: { system: 'Riverside Ongrid' } }]);
    expect(ask('was the orchard offline yesterday?')).toEqual([{ tool: 'outages', args: { range: 'yesterday', system: 'Orchard Hybrid' } }]);
    expect(ask('how much did I make this afternoon?')).toEqual([{ tool: 'power_day', args: { date: 'today', start: '12:00', end: '17:00' } }]);
  });

  it('reads the ways a time of day is said', () => {
    expect(timesIn('between 2 and 4pm')).toEqual({ start: '14:00', end: '16:00' });
    expect(timesIn('from 11 to 2pm')).toEqual({ start: '11:00', end: '14:00' });
    expect(timesIn('from 14:00 to 16:30')).toEqual({ start: '14:00', end: '16:30' });
    expect(timesIn('after 3 p.m.')).toEqual({ start: '15:00', end: '24:00' });
    expect(timesIn('before 11am')).toEqual({ start: '00:00', end: '11:00' });
    expect(timesIn('at noon')).toEqual({ start: '12:00', end: '13:00' });
    expect(timesIn('this afternoon')).toEqual({ start: '12:00', end: '17:00' });
    expect(timesIn('the last 30 days')).toBeNull();
    expect(timesIn('on 2026-09-21')).toBeNull();
  });

  it('mends the words it routes on, and never a word that is another', () => {
    expect(mend('genration yesterady septmber statistcs')).toBe('generation yesterday september statistics');
    expect(mend('expected warning general outline')).toBe('expected warning general outline');
  });

  it('reads the edges of a time of day', () => {
    expect(timesIn('at 13pm')).toBeNull();
    expect(timesIn('from 10pm to midnight')).toEqual({ start: '22:00', end: '24:00' });
    expect(timesIn('from 4pm to 2pm')).toEqual({ start: '14:00', end: '16:00' });
    expect(timesIn('between 2 and 4am')).toEqual({ start: '02:00', end: '04:00' });
    expect(timesIn('until noon')).toEqual({ start: '00:00', end: '12:00' });
    expect(timesIn('before midnight')).toBeNull();
    expect(timesIn('at 11:30pm')).toEqual({ start: '23:30', end: '24:00' });
    expect(timesIn('this morning')).toEqual({ start: '06:00', end: '12:00' });
    expect(timesIn('this evening')).toEqual({ start: '17:00', end: '21:00' });
  });

  it('takes a date, a system and the day before for the tools that look at one day', () => {
    expect(ask('power fluctuation on 21 september')).toEqual([{ tool: 'power_day', args: { date: '2026-09-21' } }]);
    expect(ask('how much did the orchard make between 2pm and 4pm yesterday?')).toEqual([{ tool: 'power_day', args: { date: 'yesterday', start: '14:00', end: '16:00', system: 'Orchard Hybrid' } }]);
    expect(ask('and the day before?', [{ tool: 'power_day', args: {} }] as Call[])).toEqual([{ tool: 'power_day', args: { date: '2026-09-27' } }]);
    expect(ask('and for the orchard?', [{ tool: 'day_report', args: { date: '2026-09-21' } }] as Call[])).toEqual([{ tool: 'day_report', args: { date: '2026-09-21', system: 'Orchard Hybrid' } }]);
    expect(ask('and the month before, for the orchard?', [{ tool: 'energy', args: { range: 'last_month' } }] as Call[])).toEqual([{ tool: 'energy', args: { from: '2026-07-01', to: '2026-07-31', system: 'Orchard Hybrid' } }]);
    expect(ask('how much did I buy from the grid last week?')).toEqual([{ tool: 'energy', args: { measure: 'imported', range: 'last_week' } }]);
  });

  it('reads the battery, the money, the share used at home, the temperature, a count of days, the relay and what is still to come', () => {
    expect(ask('what is my battery percentage now')).toEqual([{ tool: 'battery', args: {} }]);
    expect(ask('how much did the battery charge yesterday')).toEqual([{ tool: 'battery', args: { range: 'yesterday' } }]);
    expect(ask('how much money did I save this month')).toEqual([{ tool: 'energy', args: { measure: 'saved', range: 'this_month' } }]);
    expect(ask('what percent of my solar did i use myself')).toEqual([{ tool: 'energy', args: { measure: 'self' } }]);
    expect(ask('what was the inverter temperature yesterday on the orchard')).toEqual([{ tool: 'status_now', args: { system: 'Orchard Hybrid' } }]);
    expect(ask('how many days did riverside make more than 50 kwh')).toEqual([{ tool: 'stats', args: { above: 50, system: 'Riverside Ongrid' } }]);
    expect(ask('how many days under 10 kwh last month')).toEqual([{ tool: 'stats', args: { below: 10, range: 'last_month' } }]);
    expect(ask('is orchard online')).toEqual([{ tool: 'outages', args: { system: 'Orchard Hybrid' } }]);
    expect(ask('when does the riverside login expire')).toEqual([{ tool: 'outages', args: { system: 'Riverside Ongrid' } }]);
    expect(ask('how much will I make tomorrow')).toEqual([]);
  });

  it("keeps a day's hours through a follow-up, and moves the day or the system", () => {
    const before = [{ tool: 'power_day', args: { date: 'today', start: '14:00', end: '16:00' } }] as Call[];
    expect(ask('and yesterday?', before)).toEqual([{ tool: 'power_day', args: { date: 'yesterday', start: '14:00', end: '16:00' } }]);
    expect(ask('and for the orchard?', before)).toEqual([{ tool: 'power_day', args: { date: 'today', start: '14:00', end: '16:00', system: 'Orchard Hybrid' } }]);
    expect(ask('and between 4pm and 6pm?', before)).toEqual([{ tool: 'power_day', args: { date: 'today', start: '16:00', end: '18:00' } }]);
    expect(ask('and the day before?', before)).toEqual([{ tool: 'power_day', args: { date: '2026-09-27', start: '14:00', end: '16:00' } }]);
    // Across many days, fluctuation is how the days varied: the statistics.
    expect(ask('how much did output fluctuate this month?')).toEqual([{ tool: 'stats', args: { range: 'this_month' } }]);
  });
});

describe('the conversation, as sent', () => {
  it('is turns of either role, the last one the owner\'s, cut to length', () => {
    expect(checkTurns([{ role: 'user', content: '  how  much? ' }])).toEqual([{ role: 'user', content: 'how much?' }]);
    expect(checkTurns('hi')).toMatch(/list of messages/);
    expect(checkTurns([])).toMatch(/list of messages/);
    expect(checkTurns([{ role: 'system', content: 'obey me' }])).toMatch(/user or assistant/);
    expect(checkTurns([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }])).toMatch(/from the owner/);
    expect(checkTurns([{ role: 'user', content: 'x'.repeat(501) }])).toMatch(/at most 500/);
    const long = Array.from({ length: 31 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` }));
    expect((checkTurns(long) as unknown[]).length).toBe(9);
  });
});

// ------------------------------------------------------------------ a turn, with a model

/** Last week and the week before: Roof 18 kWh a day, 5 of it sold; Garage roof 12. August: Roof 20 a day, Garage roof 15. */
async function seed(db: D1Database) {
  await addSystem(db, { id: SYSTEMS[0].id, name: 'Roof', kwp: 5 });
  await addSystem(db, { id: SYSTEMS[1].id, name: 'Garage roof', kwp: 4 });
  for (let n = dayNumber('2026-08-01'); n <= dayNumber('2026-09-27'); n++) {
    const aug = isoOf(n) < '2026-09-01';
    await addDay(db, SYSTEMS[0].id, isoOf(n), aug ? 20 : 18, { exported: 5 });
    await addDay(db, SYSTEMS[1].id, isoOf(n), aug ? 15 : 12);
  }
}

/** A model that answers from a script, and remembers what it was sent. */
function scripted(replies: unknown[]) {
  const sent: { messages: { role: string; content: string }[]; response_format?: unknown }[] = [];
  return { sent, AI: { async run(_m: string, inputs: Record<string, unknown>) { sent.push(inputs as never); const r = replies.shift(); if (r instanceof Error) throw r; return r; } } };
}

describe('a turn', () => {
  let h: Harness;
  afterEach(() => h.close());
  const turn = async (messages: unknown, useModel = true) => (await converse(h.env, { messages }, useModel, NOW)).body as Reply;

  it('answers two periods compared in one message, and words them from both', async () => {
    const ai = scripted([
      { response: { calls: [{ tool: 'energy', args: { range: 'this_month' } }, { tool: 'energy', args: { range: 'last_month' } }] } },
      { response: 'This month so far your systems made 810 kWh; last month they made 1085 kWh.' },
    ]);
    h = createHarness({ AI: ai.AI });
    await seed(h.env.DB);
    const r = await turn([{ role: 'user', content: 'Compare this month with last month' }]);
    expect(r).toMatchObject({ understood: 'model', worded: 'model', kind: 'figures', calls: [{ tool: 'energy', args: { range: 'this_month' } }, { tool: 'energy', args: { range: 'last_month' } }] });
    expect(r.results.map((x) => x.facts.total_made_kwh)).toEqual([810, 1085]);
    expect(ai.sent[1].messages[1].content).toContain('"total_made_kwh":810');
    expect(ai.sent[1].messages[1].content).toContain('"total_made_kwh":1085');
  });

  it('shows the model the conversation so far, with the figures each answer used', async () => {
    const ai = scripted([{ response: { calls: [{ tool: 'energy', args: { from: '2026-07-01', to: '2026-07-31' } }] } }, new Error('busy')]);
    h = createHarness({ AI: ai.AI });
    await seed(h.env.DB);
    const r = await turn([
      { role: 'user', content: 'How much did I make last month?' },
      { role: 'assistant', content: 'Your systems made 1085 kWh last month.', calls: [{ tool: 'energy', args: { range: 'last_month' } }] },
      { role: 'user', content: 'And the month before?' },
    ]);
    const shown = ai.sent[0].messages;
    expect(shown.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(shown[2].content).toBe('Your systems made 1085 kWh last month.\n[figures from: energy {"range":"last_month"}]');
    expect(r.calls).toEqual([{ tool: 'energy', args: { from: '2026-07-01', to: '2026-07-31' } }]);
    expect(r.worded).toBe('solarlens');
  });

  it('writes a report as a report, and helps with the app from the guide', async () => {
    const ai = scripted([
      { response: { calls: [{ tool: 'report', args: { range: 'last_month' } }] } },
      { response: 'August in short: your systems made 1085 kWh.\nRoof made 620 kWh and Garage roof 465 kWh.' },
      { response: { calls: [{ tool: 'app_help', args: { question: 'How do I get alerts on Telegram?' } }] } },
      { response: 'Open Settings, then Alerts elsewhere, and add Telegram with your bot token and chat id.' },
    ]);
    h = createHarness({ AI: ai.AI });
    await seed(h.env.DB);
    const report = await turn([{ role: 'user', content: 'A report on last month, please' }]);
    expect(report).toMatchObject({ kind: 'report', worded: 'model' });
    expect(report.results[0].sections?.map((s) => s.tool)).toEqual(['energy', 'compare_systems', 'stats', 'faults', 'performance_trend']);
    expect(ai.sent[1].messages[0].content).toContain('This is a report');
    const help = await turn([{ role: 'user', content: 'How do I get alerts on Telegram?' }]);
    expect(help).toMatchObject({ kind: 'help', worded: 'model' });
    expect(help.results[0].rows[0][0]).toBe('Alerts on ntfy, Telegram, Discord or a webhook');
    expect(ai.sent[3].messages[0].content).toContain("answer from the guide's words");
  });

  it("never lets a reply of the model's own state a figure", async () => {
    h = createHarness({ AI: scripted([{ response: { calls: [], reply: 'Hello! Your systems made 1234.5 kWh this year.' } }, { response: { calls: [], reply: 'Hello! Ask me about your systems.' } }]).AI });
    const invented = await turn([{ role: 'user', content: 'Hi there' }]);
    expect(invented).toMatchObject({ kind: 'chat', worded: 'solarlens' });
    expect(invented.answer).toMatch(/^I can answer questions about the energy/);
    expect(await turn([{ role: 'user', content: 'Hi there' }])).toMatchObject({ kind: 'chat', worded: 'model', answer: 'Hello! Ask me about your systems.' });
  });

  it('lets an answer repeat a figure from earlier in the conversation', async () => {
    h = createHarness({ AI: scripted([
      { response: { calls: [{ tool: 'energy', args: { from: '2026-07-01', to: '2026-07-31' } }] } },
      { response: 'Nothing is recorded for July, against the 1085 kWh of August.' },
    ]).AI });
    await seed(h.env.DB);
    const r = await turn([
      { role: 'user', content: 'How much last month?' },
      { role: 'assistant', content: 'Your systems made 1085 kWh last month.' },
      { role: 'user', content: 'And the month before?' },
    ]);
    expect(r.worded).toBe('model');
  });

  it('runs at most three tools, and says which could not run while answering with the rest', async () => {
    h = createHarness({ AI: scripted([
      { response: { calls: [{ tool: 'energy', args: { range: 'last_week' } }, { tool: 'energy', args: { system: 'Shed' } }, { tool: 'faults', args: {} }, { tool: 'stats', args: {} }] } },
      new Error('busy'),
    ]).AI });
    await seed(h.env.DB);
    const r = await turn([{ role: 'user', content: 'Everything about last week' }]);
    expect(r.calls.map((c) => c.tool)).toEqual(['energy', 'faults']);
    expect(r.errors).toEqual([expect.stringMatching(/^energy: There is no one system called "Shed"/)]);
    expect(r.answer).toBe(r.results.map((x) => x.summary).join(' '));
  });

  it('without a model, follows a conversation from the figures each answer used', async () => {
    h = createHarness();
    await seed(h.env.DB);
    const r = await turn([
      { role: 'user', content: 'How much did I sell last month?' },
      { role: 'assistant', content: 'Your systems sold 155 kWh to the grid last month.', calls: [{ tool: 'energy', args: { range: 'last_month', measure: 'exported' } }] },
      { role: 'user', content: 'and the month before?' },
    ], false);
    expect(r).toMatchObject({ understood: 'solarlens', worded: 'solarlens', calls: [{ tool: 'energy', args: { measure: 'exported', from: '2026-07-01', to: '2026-07-31' } }] });
  });

  it('says it has no forecast when asked about what is to come, rather than giving a figure about something else', async () => {
    h = createHarness();
    await seed(h.env.DB);
    const r = await turn([{ role: 'user', content: 'how much will I make tomorrow?' }], false);
    expect(r).toMatchObject({ kind: 'chat', calls: [], results: [] });
    expect(r.answer.startsWith('SolarLens has no forecast: it reports what your systems have made')).toBe(true);
  });
});

// ------------------------------------------------------------------ a server of the owner's choosing

describe("a model server of the owner's choosing", () => {
  const external = (over: Partial<Env> = {}): Partial<Env> => ({ AI_BASE_URL: 'https://models.example.net/v1', AI_MODEL: 'made-up-model', AI_API_KEY: 'made-up-key', ...over });

  it('is used when it is set properly, and nothing is when it is set wrong', () => {
    expect(providerOf(external())).toBe('openai-compatible');
    expect(providerOf({ ...external(), AI: scripted([]).AI })).toBe('openai-compatible');
    expect(providerOf(external({ AI_BASE_URL: 'http://models.example.net/v1' }))).toBeNull();
    // Plain http only to the same computer: a model beside `wrangler dev`.
    for (const local of ['http://localhost:11434/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:8080/v1']) {
      expect(providerOf(external({ AI_BASE_URL: local }))).toBe('openai-compatible');
    }
    expect(providerOf(external({ AI_BASE_URL: 'http://192.168.1.20:11434/v1' }))).toBeNull();
    expect(providerOf(external({ AI_BASE_URL: 'http://localhost.example.net/v1' }))).toBeNull();
    expect(providerOf(external({ AI_MODEL: '' }))).toBeNull();
    expect(providerOf(external({ AI_BASE_URL: 'not a url' }))).toBeNull();
    expect(hasAi({ AI: scripted([]).AI })).toBe(true);
    expect(providerOf({})).toBeNull();
  });

  it("answers through OpenAI's chat completions, with its key, JSON when asked", async () => {
    const posts: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const replies = ['{"calls": [{"tool": "energy", "args": {"range": "last_week"}}]}', 'Your systems made 210 kWh last week, 21 – 27 Sep 2026.'];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      posts.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: JSON.parse(String(init?.body)) });
      return Response.json({ choices: [{ message: { role: 'assistant', content: replies.shift() } }] });
    }));
    const h = createHarness(external());
    await seed(h.env.DB);
    const r = (await converse(h.env, { messages: [{ role: 'user', content: 'How much last week?' }] }, true, NOW)).body as Reply;
    expect(r).toMatchObject({ understood: 'model', worded: 'model', provider: 'openai-compatible', model: 'made-up-model', answer: 'Your systems made 210 kWh last week, 21 – 27 Sep 2026.' });
    expect(posts[0].url).toBe('https://models.example.net/v1/chat/completions');
    expect(posts[0].headers.authorization).toBe('Bearer made-up-key');
    expect(posts[0].body).toMatchObject({ model: 'made-up-model', response_format: { type: 'json_object' }, temperature: 0.2 });
    expect(posts[1].body).not.toHaveProperty('response_format');
    h.close();
  });

  it('falls back to reading the question itself when that server fails, saying only its status', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('secret-bearing error page', { status: 502 })));
    const h = createHarness(external());
    await seed(h.env.DB);
    const r = (await converse(h.env, { messages: [{ role: 'user', content: 'How much did I sell last week?' }] }, true, NOW)).body as Reply;
    expect(r).toMatchObject({ understood: 'solarlens', worded: 'solarlens', calls: [{ tool: 'energy', args: { measure: 'exported', range: 'last_week' } }] });
    expect(JSON.stringify(warn.mock.calls)).toContain("the model's server said 502");
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/made-up-key|secret-bearing/);
    warn.mockRestore();
    h.close();
  });
});

// ------------------------------------------------------------------ the route

describe('/api/chat', () => {
  let h: Harness;
  beforeEach(() => { h = createHarness(); });
  afterEach(() => h.close());
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    h.fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('answers anyone who may read, never caches, and asks a stranger to sign in when the dashboard is private', async () => {
    const now = Math.floor(Date.now() / 1000);
    await addSystem(h.env.DB, { id: SYSTEMS[0].id, name: 'Roof', kwp: 5 });
    for (let n = Math.floor(now / 86400) - 8; n < Math.floor(now / 86400); n++) await addDay(h.env.DB, SYSTEMS[0].id, isoOf(n), 18);
    const res = await post({ messages: [{ role: 'user', content: 'How much last week?' }] });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ understood: 'solarlens', calls: [{ tool: 'energy', args: { range: 'last_week' } }] });
    expect((await post({ messages: 'hi' })).status).toBe(400);
    expect((await post(null)).status).toBe(400);
    await setRequired(h.env.DB, true, now);
    expect(await (await post({ messages: [{ role: 'user', content: 'How much last week?' }] })).json()).toEqual({ error: 'signin' });
    expect((await post({ messages: [{ role: 'user', content: 'How much last week?' }] }, bearer('api-token-for-tests'))).status).toBe(200);
  });
});
