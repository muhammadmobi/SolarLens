/**
 * SolarLens as an MCP server, at /mcp: the read-only tools of Ask SolarLens
 * (./tools), offered to AI apps outside SolarLens - Claude, an IDE, anything
 * that speaks the Model Context Protocol - so they can ask the same questions
 * and get the same figures.
 *
 * It runs inside this Worker on Cloudflare, so it answers whether the relay
 * laptops are on or off; with them off, the SolisCloud figures stop at their
 * last reading, and every result says how fresh its data is.
 *
 * The transport is MCP's Streamable HTTP, in its simplest form: each JSON-RPC
 * message is POSTed to /mcp and answered with JSON - no event stream, no
 * session to keep, since nothing here ever speaks first. What it answers:
 *
 * - initialize: the protocol version (the client's, when it is one of ours),
 *   the tools capability, and a word on how to read the figures;
 * - ping;
 * - tools/list: each tool with its arguments as JSON Schema, marked read-only;
 * - tools/call: the tool run with its arguments checked, the result as text for
 *   the model and as structured content for the app. A question the arguments
 *   cannot answer is a tool error the model can read and correct, not a
 *   protocol error.
 *
 * Who may call it is settled before this runs: an OAuth access token from an
 * app the owner approved (./oauth).
 */
import pkg from '../package.json';
import type { Env } from './db';
import { nowSec } from './db';
import { TOOLS, jsonSchemaOf, runTool, toolByName, type ToolResult } from './tools';

/** The protocol versions this server speaks, newest first. */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** What each tool is called in an app's list. */
const TITLES: Record<string, string> = {
  status_now: 'Right now',
  outages: 'Outages, and the last power',
  energy: 'Energy over a period',
  power_day: "A day's power, hour by hour",
  compare_systems: 'Systems compared per kWp',
  faults: 'Faults',
  day_report: 'Why a day was low',
  performance_trend: 'Slow decline',
  stats: 'Statistics',
  report: 'A full report',
  app_help: 'How to use SolarLens',
};

const INSTRUCTIONS = [
  "SolarLens is one owner's solar-power dashboard. Every tool only reads, and SolarLens works out every figure: quote a tool's figures rather than computing your own.",
  "Each result says the period it covers, on the plants' own calendar, and how fresh the data is. A system that has stopped reporting shows its last reading and counts as making nothing now.",
  'Name a system as the dashboard does; leave it out for all of them. Periods are named ranges or YYYY-MM-DD dates.',
].join(' ');

type Id = string | number | null;
type Rpc = { jsonrpc: '2.0'; id: Id; result?: unknown; error?: { code: number; message: string } };

const ok = (id: Id, result: unknown): Rpc => ({ jsonrpc: '2.0', id, result });
const fail = (id: Id, code: number, message: string): Rpc => ({ jsonrpc: '2.0', id, error: { code, message } });

/** A version this server speaks: the client's own when it is one of them, else the newest. */
export const negotiate = (asked: unknown) =>
  (typeof asked === 'string' && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0]);

/** A tool's result as text for a model: the answer, the figures, what they rest on, how fresh. */
export function resultText(r: ToolResult, now = nowSec()): string {
  const lines = [`${r.title}${r.period ? ` - ${r.period.label}` : ''}`, r.summary, ''];
  if (r.rows.length) {
    lines.push(r.columns.join(' | '));
    for (const row of r.rows.slice(0, 60)) lines.push(row.map((v) => (v === null ? '-' : String(v))).join(' | '));
    if (r.rows.length > 60) lines.push(`… and ${r.rows.length - 60} more rows.`);
    lines.push('');
  }
  const facts = Object.entries(r.facts).filter(([, v]) => v !== null);
  if (facts.length) lines.push(`Figures: ${facts.map(([k, v]) => `${k}: ${v}`).join('; ')}.`);
  for (const n of r.notes) lines.push(`Note: ${n}`);
  // A report's parts, each in brief: its title, its sentence, and the first rows of its table.
  for (const s of r.sections ?? []) {
    lines.push('', `## ${s.title}${s.period ? ` - ${s.period.label}` : ''}`, s.summary);
    if (s.rows.length) {
      lines.push(s.columns.join(' | '));
      for (const row of s.rows.slice(0, 20)) lines.push(row.map((v) => (v === null ? '-' : String(v))).join(' | '));
      if (s.rows.length > 20) lines.push(`… and ${s.rows.length - 20} more rows.`);
    }
  }
  if (r.freshness.newest) {
    const mins = Math.max(0, Math.round((now - r.freshness.newest) / 60));
    lines.push(`Data up to ${new Date(r.freshness.newest * 1000).toISOString().replace(/:\d\d\.\d+Z$/, ' UTC').replace('T', ' ')} (${mins} min ago)`
      + `${r.freshness.offline.length ? `; not reporting now: ${r.freshness.offline.join(', ')}` : ''}.`);
  }
  return lines.join('\n').trim();
}

/** One JSON-RPC message: a request answered, or a notification (or a stray response) answered with nothing. */
async function answer(env: Env, m: unknown, now: number): Promise<Rpc | null> {
  if (!m || typeof m !== 'object' || Array.isArray(m) || (m as { jsonrpc?: unknown }).jsonrpc !== '2.0') {
    return fail(null, -32600, 'Invalid Request');
  }
  const msg = m as { id?: Id; method?: unknown; params?: Record<string, unknown> };
  if (typeof msg.method !== 'string') return null;             // a response from the client: nothing to say
  if (msg.id === undefined) return null;                       // a notification, such as notifications/initialized
  const id = msg.id;
  const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<string, unknown>;
  switch (msg.method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: negotiate(params.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'solarlens', title: 'SolarLens', version: pkg.version },
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          title: TITLES[t.name] ?? t.name,
          description: t.description,
          inputSchema: jsonSchemaOf(t),
          annotations: { title: TITLES[t.name] ?? t.name, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        })),
      });
    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string' || !toolByName(name)) return fail(id, -32602, `Unknown tool: ${String(name).slice(0, 60)}`);
      const out = await runTool(env.DB, name, params.arguments ?? {}, now);
      if ('error' in out) return ok(id, { content: [{ type: 'text', text: out.error }], isError: true });
      return ok(id, { content: [{ type: 'text', text: resultText(out.result, now) }], structuredContent: out.result });
    }
    default:
      return fail(id, -32601, `Method not found: ${msg.method.slice(0, 60)}`);
  }
}

/**
 * Answer a request to /mcp, already authorised. A POST carries one message or
 * a batch; the answers go back as JSON, or 202 with no body when there is
 * nothing to answer. Nothing is ever sent unasked, so GET, which would open an
 * event stream for that, is refused, as is DELETE: there is no session to end.
 */
export async function handleMcp(env: Env, req: Request, now = nowSec()): Promise<Response> {
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json(fail(null, -32700, 'Parse error'), { status: 400 });
  }
  const batch = Array.isArray(payload);
  const messages = batch ? (payload as unknown[]) : [payload];
  if (batch && !messages.length) return Response.json(fail(null, -32600, 'Invalid Request'), { status: 400 });
  const out: Rpc[] = [];
  for (const m of messages.slice(0, 50)) {
    const r = await answer(env, m, now);
    if (r) out.push(r);
  }
  if (!out.length) return new Response(null, { status: 202 });
  return Response.json(batch ? out : out[0], { headers: { 'Cache-Control': 'no-store' } });
}
