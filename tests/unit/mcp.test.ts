/**
 * The MCP server: SolarLens's read-only tools, offered over the Model Context
 * Protocol's Streamable HTTP transport, one JSON answer per POST.
 *
 * Held to src/mcp.ts and the protocol: initialize and its version, ping,
 * notifications answered with 202, the tools listed with their JSON Schema and
 * marked read-only, a call answered as text for the model and as structured
 * content, a question the arguments cannot answer as a tool error the model can
 * read - and the JSON-RPC errors for everything else. The data is made up.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { handleMcp, negotiate, resultText } from '../../src/mcp';
import type { ToolResult } from '../../src/tools';
import { createHarness, type Harness } from '../helpers/worker';
import { addDay, addSystem, isoOf } from '../helpers/solar-days';

const NOW = Date.UTC(2026, 8, 28, 9) / 1000;
const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string;

let h: Harness;
beforeEach(() => { h = createHarness(); });
afterEach(() => h.close());

/** POST one message, or a batch, to the server as a client would. */
async function send(body: unknown) {
  const res = await handleMcp(h.env, new Request('https://dashboard.test/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: typeof body === 'string' ? body : JSON.stringify(body),
  }), NOW);
  return { status: res.status, body: res.status === 202 ? null : ((await res.json()) as Record<string, any>), headers: res.headers };
}
const call = (id: number, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });

describe('the handshake', () => {
  it('initialises with the client\'s protocol version when it is one it speaks, and its own newest otherwise', async () => {
    const r = await send(call(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'made-up-client', version: '1' } }));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(r.body).toEqual({
      jsonrpc: '2.0', id: 1,
      result: {
        protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'solarlens', title: 'SolarLens', version }, instructions: expect.stringContaining('quote a tool\'s figures'),
      },
    });
    expect(negotiate('2099-01-01')).toBe('2025-06-18');
    expect(negotiate(undefined)).toBe('2025-06-18');
  });

  it('answers a notification with 202 and nothing else, and ping with nothing at all', async () => {
    expect(await send({ jsonrpc: '2.0', method: 'notifications/initialized' })).toMatchObject({ status: 202, body: null });
    expect((await send(call(2, 'ping'))).body).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
    // A response from the client needs no answer either.
    expect((await send({ jsonrpc: '2.0', id: 9, result: {} })).status).toBe(202);
  });
});

describe('the tools', () => {
  it('lists each with its arguments as JSON Schema, marked read-only', async () => {
    const { body } = await send(call(3, 'tools/list'));
    const tools = body!.result.tools as Record<string, any>[];
    expect(tools.map((t) => t.name)).toEqual(['status_now', 'outages', 'energy', 'power_day', 'battery', 'compare_systems', 'stats', 'faults', 'day_report', 'performance_trend', 'report', 'app_help']);
    expect(tools[2]).toMatchObject({
      title: 'Energy over a period', inputSchema: { type: 'object', additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    });
    expect(tools[2].inputSchema.properties.range.enum).toContain('last_month');
    // Every tool has a title of its own for an app's list.
    expect(tools.filter((t) => t.title === t.name)).toEqual([]);
  });

  it('answers a call as text for the model and as structured content for the app', async () => {
    await addSystem(h.env.DB, { id: 'solarman:station:alpha', name: 'Roof', kwp: 5 });
    for (let n = Math.floor(NOW / 86400) - 7; n < Math.floor(NOW / 86400); n++) await addDay(h.env.DB, 'solarman:station:alpha', isoOf(n), 20);
    const { body } = await send(call(4, 'tools/call', { name: 'energy', arguments: { range: 'last_week' } }));
    const result = body!.result as { content: { type: string; text: string }[]; structuredContent: ToolResult; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ tool: 'energy', facts: { total_made_kwh: 140 } });
    const text = result.content[0].text;
    expect(result.content[0].type).toBe('text');
    expect(text.startsWith('Energy per day, Roof - last week (21 – 27 Sep 2026)\nRoof made 140 kWh last week (21 – 27 Sep 2026).')).toBe(true);
    expect(text).toContain('Day | Made (kWh)');
    expect(text).toContain('Mon 21 Sep 2026 | 20');
    expect(text).toContain('Figures: total_made_kwh: 140;');
    expect(text).toMatch(/Data up to 2026-09-27 19:39 UTC \(\d+ min ago\); not reporting now: Roof\./);
    expect(JSON.stringify(body)).not.toMatch(/station|alpha/);
  });

  it('reports a question the arguments cannot answer as a tool error the model can read and correct', async () => {
    const { body } = await send(call(5, 'tools/call', { name: 'energy', arguments: { range: 'next_week' } }));
    expect(body!.result).toEqual({ content: [{ type: 'text', text: expect.stringContaining('range is one of') }], isError: true });
  });
});

describe('everything else', () => {
  it('answers with the JSON-RPC error for each kind of mistake', async () => {
    expect((await send(call(6, 'tools/call', { name: 'drop_everything' }))).body!.error).toEqual({ code: -32602, message: 'Unknown tool: drop_everything' });
    expect((await send(call(7, 'resources/list'))).body!.error).toEqual({ code: -32601, message: 'Method not found: resources/list' });
    const parse = await send('{not json');
    expect(parse).toMatchObject({ status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } });
    expect((await send({ id: 8, method: 'ping' })).body!.error.code).toBe(-32600);
    expect((await send([])).status).toBe(400);
  });

  it('answers a batch with a batch, leaving out what needs no answer', async () => {
    const { body } = await send([call(10, 'ping'), { jsonrpc: '2.0', method: 'notifications/initialized' }, call(11, 'tools/list')]);
    expect((body as unknown as { id: number }[]).map((m) => m.id)).toEqual([10, 11]);
  });

  it('opens no event stream and keeps no session: GET and DELETE are refused', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await handleMcp(h.env, new Request('https://dashboard.test/mcp', { method }), NOW);
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    }
  });
});

describe('a result as text', () => {
  it('shows sixty rows at most, and leaves out the figures that are empty', () => {
    const r: ToolResult = {
      tool: 't', title: 'Many', period: null, columns: ['Day', 'kWh'], rows: Array.from({ length: 65 }, (_, i) => [`d${i}`, i === 0 ? null : i]),
      facts: { total: 5, none: null }, notes: ['A note.'], summary: 'Sum.', freshness: { newest: null, offline: [] },
    };
    const text = resultText(r, NOW);
    expect(text).toContain('d0 | -');
    expect(text).toContain('… and 5 more rows.');
    expect(text).toContain('Figures: total: 5.');
    expect(text).toContain('Note: A note.');
    expect(text).not.toContain('none');
    expect(text).not.toContain('Data up to');
  });
});

describe('a report, as text', () => {
  it("shows each of its parts in brief, after the headline", () => {
    const part = (title: string, n: number): ToolResult => ({
      tool: 'x', title, period: { from: 'a', to: 'b', label: 'last month' }, columns: ['Day', 'kWh'],
      rows: Array.from({ length: n }, (_, i) => [`d${i}`, i]), facts: {}, notes: [], summary: `${title} in a sentence.`, freshness: { newest: null, offline: [] },
    });
    const r: ToolResult = { ...part('Report', 2), sections: [part('Energy per day', 25), part('Faults', 0)] };
    const text = resultText(r, NOW);
    expect(text).toContain('## Energy per day - last month\nEnergy per day in a sentence.\nDay | kWh');
    expect(text).toContain('… and 5 more rows.');
    expect(text).toContain('## Faults - last month\nFaults in a sentence.');
  });
});
