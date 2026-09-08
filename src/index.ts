import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Env } from './db';
import { daily, insertReading, latest, latestPollPerProvider, listDevices, logPoll, nowSec, recentPolls, series, upsertDevice, upsertInverter } from './db';
import { plantFilter, pollAll } from './poll';
import { stampWeather } from './weather';
import type { Inverter, Reading } from './providers/types';
import {
  deviceFromCollector,
  deviceFromInverter,
  deviceFromInverterDetail,
  historyFromChart,
  stationReading as solisStationReading,
} from './providers/soliscloud';
import { stationReading as solarmanStationReading } from './providers/solarman';

const COOKIE = 'sl_token';

const app = new Hono<{ Bindings: Env }>();

/**
 * Security headers on every response.
 *
 * The page loads one web font from Google and nothing else, so the policy is
 * strict about everything but that - and, more usefully, about where anything
 * may be *sent*. `connect-src 'self'` means injected script could not
 * exfiltrate a reading even if it ran, and `frame-ancestors 'none'` keeps the
 * page out of somebody else's iframe.
 *
 * Kept identical to public/_headers, which covers the same page when the edge
 * serves it without invoking this Worker at all.
 *
 * `'unsafe-inline'` is unavoidable while the script and styles live in the
 * HTML; that is the deliberate trade for having no build step.
 *
 * `Referrer-Policy: no-referrer` matters more than it looks: the one-time
 * `/auth?t=<token>` link would otherwise put the token in a Referer header.
 */
app.use('*', async (c, next) => {
  await next();
  // The static-assets binding hands back a Response whose headers are frozen,
  // so they have to be rebuilt rather than appended to - otherwise the policy
  // silently applies to the JSON routes and not to the page it is protecting.
  const res = new Response(c.res.body, {
    status: c.res.status,
    statusText: c.res.statusText,
    headers: new Headers(c.res.headers),
  });
  const h = res.headers;
  h.set('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; '));
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'no-referrer');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('X-Frame-Options', 'DENY');
  c.res = res;
});

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
  // No token configured means no gate. That is the documented local-dev
  // affordance, but it fails open: a deploy that lost the secret would serve
  // the whole dataset to anyone who found the URL, silently. So it is said out
  // loud - in the log, and in /api/health, which the dashboard turns into a
  // banner - rather than left to be discovered.
  if (!token) {
    console.warn('API_TOKEN is not set: /api/* is unauthenticated');
    return next();
  }
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
  // `polls` is the recent history; `feeds` is the newest line per provider, so
  // a feed that has gone quiet cannot be hidden by a busier one logging over it.
  const [polls, feeds] = await Promise.all([recentPolls(c.env.DB), latestPollPerProvider(c.env.DB)]);
  // The dashboard turns this into a banner. An unauthenticated deployment is
  // not something anyone should have to notice for themselves.
  return c.json({ now: nowSec(), polls, feeds, authDisabled: !c.env.API_TOKEN });
});

/**
 * Daily history, one row per inverter per day.
 *
 * `tz` is the caller's UTC offset in minutes (what `getTimezoneOffset()`
 * returns), because a solar day ends at the array's midnight and not at UTC's.
 */
app.get('/api/history', async (c) => {
  const days = Math.min(400, Math.max(1, Number(c.req.query('days') ?? 30)));
  const tz = Number(c.req.query('tz') ?? 0);
  if (!Number.isFinite(tz) || Math.abs(tz) > 900) return c.json({ error: 'tz out of range' }, 400);
  const to = nowSec();
  const from = to - days * 86400;
  return c.json({ now: to, days, rows: await daily(c.env.DB, from, to, tz) });
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
    /** inverter/detail payloads: per-string V/A, per-phase AC, temperature. */
    details?: Record<string, unknown>[];
  };
  if (body?.provider !== 'soliscloud' || !body?.plantId) {
    return c.json({ error: 'provider=soliscloud and plantId required' }, 400);
  }
  const plantId = String(body.plantId);
  if (!plantFilter(c.env)(plantId)) return c.json({ stored: 0, skipped: 'not in INCLUDE_PLANTS' });

  const devices = [
    ...(body.inverters ?? []).map((r) => deviceFromInverter(r, plantId)),
    ...(body.collectors ?? []).map((r) => deviceFromCollector(r, plantId)),
    ...(body.details ?? []).map((r) => deviceFromInverterDetail(r, plantId)),
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
  await stampWeather(c.env, reading);
  const stored = await insertReading(c.env.DB, reading);
  // The relay is how SolisCloud data arrives, so it belongs in the poll log
  // beside the cloud poller. Without this the footer only ever mentioned
  // SolarMan, and the dashboard read as though one system were untracked.
  // Worded like the cron poller's own line, so two feeds in one footer read
  // as the same kind of statement rather than two unrelated ones.
  await logPoll(c.env.DB, body.provider, true,
    `plants=1 inverters=1 new=${stored ? 1 : 0} via ${source}`);
  return c.json({ stored, inverterId: inv.id, ts: reading.ts, acPowerW: reading.acPowerW });
});

/**
 * Backfill: today's curve as the vendor's own chart reports it.
 *
 * The relay records only what it sees while it is running, so any stretch when
 * the machine was asleep is missing from a graph that otherwise looks like a
 * system that produced nothing. The portal has the whole day; this takes it.
 *
 * Rows land under a "-history" source so they never masquerade as the live
 * feed: `latest` ignores them, and the series query prefers a live sample
 * whenever both exist for the same instant.
 */
app.post('/api/ingest/history', async (c) => {
  const token = c.env.INGEST_TOKEN;
  if (!token) return c.json({ error: 'INGEST_TOKEN not configured' }, 503);
  const given = bearer(c.req.header('Authorization')) ?? '';
  if (!timingSafeEqual(given, token)) return c.json({ error: 'unauthorized' }, 401);

  const body = (await c.req.json()) as { provider?: string; plantId?: string | number; raw?: unknown };
  if (!body?.provider || !body?.plantId || body.raw === undefined) {
    return c.json({ error: 'provider, plantId and raw required' }, 400);
  }
  const plantId = String(body.plantId);
  if (!plantFilter(c.env)(plantId)) return c.json({ stored: 0, skipped: 'not in INCLUDE_PLANTS' });

  const points = historyFromChart(body.raw);
  if (!points.length) {
    // "0 points" on its own is a dead end. Naming what the payload did contain
    // turns a silent failure into something the next person can act on - the
    // chart endpoint is the least documented thing either vendor returns.
    const top = body.raw && typeof body.raw === 'object' ? body.raw as Record<string, unknown> : {};
    const inner = top.data && typeof top.data === 'object' ? top.data as Record<string, unknown> : top;
    return c.json({ stored: 0, points: 0, sawKeys: Object.keys(inner).slice(0, 40) });
  }

  const inverterId = `${body.provider}:station:${plantId}`;
  const source = `${body.provider}-history`;
  // A day of five-minute samples is under 300 rows; anything larger is not a
  // day curve and is refused rather than written.
  if (points.length > 1000) return c.json({ error: 'too many points' }, 400);

  // The chart payload names a unit in a field that turns out to label the axis
  // rather than the numbers, so a perfectly plausible-looking curve can be out
  // by a factor of a thousand. Measure it against the nameplate before writing:
  // an array cannot deliver several times its rating, and half a day of
  // nonsense is far harder to spot in a graph than a refusal is here.
  const nameplate = await c.env.DB
    .prepare('SELECT capacity_w FROM inverters WHERE id = ?1')
    .bind(inverterId)
    .first<{ capacity_w: number | null }>();
  const cap = nameplate?.capacity_w ?? null;
  const peak = Math.max(...points.map((p) => Math.abs(p.acPowerW)));
  if (cap && peak > cap * 5) {
    return c.json({
      error: 'implausible curve',
      detail: `peak ${Math.round(peak)} W against a ${cap} W array - the payload's units are not what they claim`,
      stored: 0,
      points: points.length,
    }, 422);
  }

  let stored = 0;
  for (const p of points) {
    if (await insertReading(c.env.DB, {
      inverterId, ts: p.ts, source,
      acPowerW: p.acPowerW, dcPowerW: null, todayKwh: null, totalKwh: null,
      batterySoc: null, batteryPowerW: null, gridPowerW: null, loadPowerW: null,
      tempC: null, status: null, metrics: null, raw: null,
    })) stored++;
  }
  return c.json({ stored, points: points.length });
});

// Everything else is the static UI.
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(pollAll(env));
  },
} satisfies ExportedHandler<Env>;
