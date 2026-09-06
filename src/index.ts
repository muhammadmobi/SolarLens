import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Env } from './db';
import { insertReading, latest, listDevices, nowSec, recentPolls, series, upsertDevice, upsertInverter } from './db';
import { plantFilter, pollAll } from './poll';
import type { Inverter, Reading } from './providers/types';
import {
  deviceFromCollector,
  deviceFromInverter,
  stationReading as solisStationReading,
} from './providers/soliscloud';
import { stationReading as solarmanStationReading } from './providers/solarman';

const COOKIE = 'sl_token';

const app = new Hono<{ Bindings: Env }>();

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1].trim() : null;
}

/**
 * /auth?t=<API_TOKEN> drops an HttpOnly cookie so the browser UI can call
 * /api/* without embedding the token in the page. Bookmark the URL once and
 * the dashboard "just opens" on that device afterwards.
 */
app.get('/auth', (c) => {
  const token = c.env.API_TOKEN;
  const given = c.req.query('t') ?? '';
  if (!token || !timingSafeEqual(given, token)) return c.text('forbidden', 403);
  setCookie(c, COOKIE, given, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 365 * 24 * 3600,
  });
  return c.redirect('/');
});

// Read endpoints: gated by API_TOKEN when it is set; open (local dev) when it is not.
app.use('/api/*', async (c, next) => {
  // Push endpoints carry their own INGEST_TOKEN check; everything under /api/ingest/ is theirs.
  if (c.req.path === '/api/ingest' || c.req.path.startsWith('/api/ingest/')) return next();
  const token = c.env.API_TOKEN;
  if (!token) return next();
  const given = bearer(c.req.header('Authorization')) ?? getCookie(c, COOKIE) ?? '';
  if (!timingSafeEqual(given, token)) return c.json({ error: 'unauthorized' }, 401);
  return next();
});

app.get('/api/latest', async (c) => {
  const rows = await latest(c.env.DB);
  return c.json({ now: nowSec(), inverters: rows });
});

app.get('/api/series', async (c) => {
  const to = Number(c.req.query('to') ?? nowSec());
  const from = Number(c.req.query('from') ?? to - 24 * 3600);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to - from > 31 * 24 * 3600) {
    return c.json({ error: 'bad range (max 31 days)' }, 400);
  }
  return c.json({ from, to, points: await series(c.env.DB, from, to) });
});

app.get('/api/health', async (c) => {
  return c.json({ now: nowSec(), polls: await recentPolls(c.env.DB) });
});

app.post('/api/poll', async (c) => {
  return c.json({ now: nowSec(), results: await pollAll(c.env) });
});

/**
 * Push endpoint for the local Modbus agent (and anything else on your side of
 * the LAN). Same normalised Reading shape, tagged with whatever `source` the
 * sender declares, so the UI treats it as just another feed.
 */
app.post('/api/ingest', async (c) => {
  const token = c.env.INGEST_TOKEN;
  if (!token) return c.json({ error: 'INGEST_TOKEN not configured' }, 503);
  const given = bearer(c.req.header('Authorization')) ?? '';
  if (!timingSafeEqual(given, token)) return c.json({ error: 'unauthorized' }, 401);

  const body = (await c.req.json()) as { inverter: Inverter; reading: Omit<Reading, 'inverterId'> };
  if (!body?.inverter?.id || !body?.reading) return c.json({ error: 'inverter and reading required' }, 400);

  await upsertInverter(c.env.DB, body.inverter);
  const stored = await insertReading(c.env.DB, {
    ...body.reading,
    inverterId: body.inverter.id,
    ts: body.reading.ts || nowSec(),
    source: body.reading.source || 'local',
  });
  return c.json({ stored });
});

/**
 * Raw push for the local relay agent: it hands over a vendor station payload
 * exactly as the portal returned it, and the Worker normalises it with the same
 * code path the cloud poller uses - so both routes always agree on field
 * mapping and sign conventions. Body: { provider, plantId, name?, capacityW?, raw }.
 */
/**
 * Hardware inventory pushed by the relay agent. Takes the vendor's own
 * `inverter/listV2` / `collector/listV2` records untouched and normalises them
 * here, so the agent stays a dumb pipe and the field mapping stays testable.
 */
app.post('/api/ingest/devices', async (c) => {
  const token = c.env.INGEST_TOKEN;
  if (!token) return c.json({ error: 'INGEST_TOKEN not configured' }, 503);
  const given = bearer(c.req.header('Authorization')) ?? '';
  if (!timingSafeEqual(given, token)) return c.json({ error: 'unauthorized' }, 401);

  const body = (await c.req.json()) as {
    provider: 'soliscloud';
    plantId: string;
    inverters?: Record<string, unknown>[];
    collectors?: Record<string, unknown>[];
  };
  if (body?.provider !== 'soliscloud' || !body?.plantId) {
    return c.json({ error: 'provider=soliscloud and plantId required' }, 400);
  }
  const plantId = String(body.plantId);
  if (!plantFilter(c.env)(plantId)) return c.json({ stored: 0, skipped: 'not in INCLUDE_PLANTS' });

  const devices = [
    ...(body.inverters ?? []).map((r) => deviceFromInverter(r, plantId)),
    ...(body.collectors ?? []).map((r) => deviceFromCollector(r, plantId)),
  ];
  for (const d of devices) await upsertDevice(c.env.DB, d);
  return c.json({ stored: devices.length, ids: devices.map((d) => d.id) });
});

app.get('/api/devices', async (c) => c.json({ now: nowSec(), devices: await listDevices(c.env.DB) }));

app.post('/api/ingest/station', async (c) => {
  const token = c.env.INGEST_TOKEN;
  if (!token) return c.json({ error: 'INGEST_TOKEN not configured' }, 503);
  const given = bearer(c.req.header('Authorization')) ?? '';
  if (!timingSafeEqual(given, token)) return c.json({ error: 'unauthorized' }, 401);

  const body = (await c.req.json()) as {
    provider: 'soliscloud' | 'solarman';
    plantId: string;
    name?: string;
    capacityW?: number | null;
    source?: string;
    raw: Record<string, unknown>;
  };
  if (!body?.provider || !body?.plantId || !body?.raw) {
    return c.json({ error: 'provider, plantId and raw required' }, 400);
  }
  const plantId = String(body.plantId);
  // Same INCLUDE_PLANTS rule as the cloud poller, so a relay cannot sneak in a
  // plant (e.g. one shared into the account) that the dashboard should ignore.
  if (!plantFilter(c.env)(plantId)) return c.json({ stored: false, skipped: 'not in INCLUDE_PLANTS' });
  const inv: Inverter = {
    id: `${body.provider}:station:${plantId}`,
    provider: body.provider,
    vendorId: plantId,
    serial: null,
    name: body.name ?? '',
    plantId,
    plantName: body.name ?? '',
    capacityW: body.capacityW ?? null,
  };
  const source = body.source ?? `${body.provider}-relay`;
  const reading =
    body.provider === 'soliscloud'
      ? solisStationReading(inv, body.raw, source)
      : solarmanStationReading(inv, body.raw, source);
  if (!inv.name) inv.name = inv.plantName = plantId;
  await upsertInverter(c.env.DB, inv);
  const stored = await insertReading(c.env.DB, reading);
  return c.json({ stored, inverterId: inv.id, ts: reading.ts, acPowerW: reading.acPowerW });
});

// Everything else is the static UI.
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(pollAll(env));
  },
} satisfies ExportedHandler<Env>;
