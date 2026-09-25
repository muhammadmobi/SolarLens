/**
 * The Worker's entry point: every HTTP route, and the five-minute cron.
 *
 * Requests arrive here from three kinds of caller:
 *
 * - The dashboard (public/index.html), which reads the GET /api/* routes.
 *   Who is asking is worked out first (./auth/sessions identify): the owner,
 *   someone who opened a share link, or nobody. Reads are open to nobody too
 *   until the owner turns "require sign-in to view" on in Settings; every
 *   answer carrying plant data goes through ./public-view either way, so no
 *   vendor identifier leaves the Worker. /api/status (freshness only),
 *   /api/push/key (a public key) and /api/push/recent (only for a device that
 *   is signed up) stay open regardless.
 * - The relay laptops, which push what SolisCloud's portal shows them to
 *   POST /api/ingest/*, each request carrying INGEST_TOKEN. The login does not
 *   touch them.
 * - The owner writing: signing a phone up for notifications, or forcing a
 *   poll. Those need the owner signed in, or API_TOKEN as a header - except
 *   turning a phone's notifications off, which needs only that phone's own
 *   push address (see the middleware below).
 * - The sign-in routes under /auth (./auth/routes), and share links at /s/.
 *
 * Anything else is the dashboard itself, served from public/ by the
 * static-assets binding at the bottom of this file. The page holds no data of
 * its own - it is the same file as in the public repository - so it is served
 * to anyone, and asks for a sign-in when the API says one is needed.
 *
 * The cron (scheduled, at the very end) polls every vendor the secrets allow,
 * then decides whether anything is worth a phone notification.
 */
import { Hono, type Context, type Next } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Env } from './db';
import { auth, applyCookies, openShareLink, type AuthVars } from './auth/routes';
import { REFRESH_COOKIE, SESSION_COOKIE, type Caller, deviceLabel, identify, owner, startDevice } from './auth/sessions';
import { timingSafeEqual } from './auth/crypto';
import { daily, deviceNetworks, deviceSamples, earliestDayStart, forgetOldDeviceSamples, insertReading, inverterIds, latest, latestPerProvider, listAlarms, listDevices, listPeriods, listRelays, logPoll, nowSec, recentPolls, series, upsertAlarms, upsertDevice, upsertInverter, upsertPeriods, upsertRelay } from './db';
import { solisAlarm, solisPeriods } from './providers/events';
import { tzNameOf, tzOffsetSec } from './providers/units';
import { aliasFor, deviceAliasFor, publicAlarms, publicDeviceSamples, publicDevices, publicInverters, publicRelays, publicRows } from './public-view';
import { parseRelayStatus } from './relays';
import { plantFilter, pollAll } from './poll';
import { announce, forgetOldMessages, isPushEndpoint, needsPriming, recentMessages, subscribe, tellOne, unsubscribe, vapidKey, vapidPublicKey } from './push';
import type { Inverter, Reading } from './providers/types';
import {
  deviceFromCollector,
  deviceFromInverter,
  deviceFromInverterDetail,
  historyFromChart,
  stationReading as solisStationReading,
} from './providers/soliscloud';
import { stationReading as solarmanStationReading } from './providers/solarman';

/**
 * The cookie 2.x left on a device that opened /auth?t=: the API token itself.
 * No longer accepted. It could not be signed out - not by the device, not from
 * Settings - short of replacing the token everywhere, which is exactly what a
 * sign-in must not depend on. A browser that still has it is simply asked to
 * sign in, and the cookie is cleared the first time it is seen.
 */
const LEGACY_COOKIE = 'sl_token';

const app = new Hono<{ Bindings: Env; Variables: AuthVars }>();

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

/** The token from an "Authorization: Bearer <token>" header, or null. */
function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1].trim() : null;
}

/**
 * Who is asking, for every route that answers with data or signs in.
 *
 * The API token as a header is the owner. Otherwise the session and refresh
 * cookies are read, and renewed on the way
 * if the session has run out (./auth/sessions identify), so a signed-in
 * browser never has to sign in again. The static page is left alone: it has
 * no data in it, and its response cannot take cookies.
 */
const identifyCaller = async (c: Context<{ Bindings: Env; Variables: AuthVars }>, next: Next) => {
  const secret = c.env.API_TOKEN;
  let caller: Caller = { role: null, deviceId: null, via: 'none' };
  if (getCookie(c, LEGACY_COOKIE) !== undefined) applyCookies(c, [{ name: LEGACY_COOKIE, value: '', maxAge: 0 }]);
  const given = bearer(c.req.header('Authorization'));
  if (secret && given && timingSafeEqual(given, secret)) {
    caller = { role: 'owner', deviceId: null, via: 'token' };
  } else if (secret) {
    const session = getCookie(c, SESSION_COOKIE);
    const refresh = getCookie(c, REFRESH_COOKIE);
    if (session || refresh) {
      const found = await identify(c.env.DB, secret, { session, refresh }, nowSec());
      caller = found.caller;
      applyCookies(c, found.set);
    }
  }
  c.set('caller', caller);
  return next();
};
for (const path of ['/api/*', '/auth', '/auth/*', '/s/*']) app.use(path, identifyCaller);

/**
 * /auth?t=<API_TOKEN>: the 2.x way to unlock a device, kept as a back door
 * that needs no password. It now signs the browser in as the owner with a
 * proper session, rather than leaving the token itself in a cookie as 2.x did.
 */
app.get('/auth', async (c) => {
  const token = c.env.API_TOKEN;
  const given = c.req.query('t') ?? '';
  if (!token || !timingSafeEqual(given, token)) return c.text('forbidden', 403);
  applyCookies(c, await startDevice(c.env.DB, token, 'owner', deviceLabel(c.req.header('user-agent')), nowSec()));
  return c.redirect('/');
});

app.route('/auth', auth);
app.get('/s/:link', openShareLink);

/**
 * Who may read, and who may write.
 *
 * Reads: anyone, until the owner turns "require sign-in to view" on in
 * Settings - then the owner and anyone they shared a link with. Until 3.0 the
 * dashboard was always open, which is still the default, so nothing locks by
 * surprise on the day this ships; see docs/roadmap.md phase 3.
 *
 * Writes need the owner: signed in, or with API_TOKEN as a header. A share
 * link can read and never write. /api/ingest/* keeps its own INGEST_TOKEN,
 * which the relays carry.
 *
 * Open whatever the setting: /api/status says only how fresh each feed is, for
 * a monitor; /api/push/key is a public key; /api/push/recent answers only a
 * device that is signed up, and the service worker asking has no session to
 * show once its hour is up.
 */
const ALWAYS_OPEN = new Set(['/api/status', '/api/push/key', '/api/push/recent', '/api/push/unsubscribe']);
app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/ingest' || c.req.path.startsWith('/api/ingest/')) return next();
  // Turning notifications off for a device takes that device's own push
  // endpoint, which only it knows; it can do no harm to anyone else, and asking
  // for a sign-in to stop notifications would only keep unwanted ones coming.
  if (ALWAYS_OPEN.has(c.req.path)) return next();
  const caller = c.get('caller');

  if (c.req.method === 'GET') {
    if (caller.role) return next();
    const o = await owner(c.env.DB);
    if (o?.require_sign_in) return c.json({ error: 'signin' }, 401);
    return next();
  }

  if (!c.env.API_TOKEN) {
    console.warn('API_TOKEN is not set: the write endpoints under /api/* are unauthenticated');
    return next();
  }
  if (caller.role === 'owner') return next();
  return c.json({ error: 'unauthorized' }, 401);
});

/**
 * The read endpoints are not cached, by anyone.
 *
 * Until 3.0 they carried `public, max-age=60`, which spared D1 a repeat request
 * inside the same minute. An answer now depends on who is asking - the owner
 * sees a logger's network handles, and once the dashboard is private a
 * signed-out browser is refused - and any cache, even the browser's own, would
 * go on showing the last answer across a sign-out or the switch being turned
 * on. The page asks every ten minutes, so the minute of caching saved little.
 */
const CACHE = 'no-store';

app.get('/api/latest', async (c) => {
  const rows = await latest(c.env.DB);
  const alias = aliasFor(rows.map((r) => r.id));
  c.header('Cache-Control', CACHE);
  return c.json({ now: nowSec(), inverters: publicInverters(rows, alias) });
});

/**
 * Samples over a window.
 *
 * Omit `from` and the window opens at the earliest of the plants' own
 * midnights, which is what "today" means for a solar array: its day ends when
 * the sun sets on it, not when the reader's clock rolls over. `tz`, the
 * caller's UTC offset in minutes, is the fallback for a plant whose vendor
 * never said where it is.
 */
app.get('/api/series', async (c) => {
  const to = Number(c.req.query('to') ?? nowSec());
  const tz = Number(c.req.query('tz') ?? 0);
  if (!Number.isFinite(to) || !Number.isFinite(tz) || Math.abs(tz) > 900) {
    return c.json({ error: 'bad range' }, 400);
  }
  const asked = c.req.query('from');
  const from = asked !== undefined
    ? Number(asked)
    : await earliestDayStart(c.env.DB, to, -tz * 60);
  if (!Number.isFinite(from) || to - from > 31 * 24 * 3600) {
    return c.json({ error: 'bad range (max 31 days)' }, 400);
  }
  const [points, ids] = await Promise.all([series(c.env.DB, from, to), inverterIds(c.env.DB)]);
  c.header('Cache-Control', CACHE);
  return c.json({ from, to, points: publicRows(points, aliasFor(ids)) });
});

// ---------- notifications that reach a closed browser (./push) ----------

/** The public half of the signing key, which a browser needs to subscribe. */
app.get('/api/push/key', (c) => {
  const key = vapidKey(c.env);
  if (!key) return c.json({ error: 'notifications to a closed browser are not set up on this server' }, 404);
  c.header('Cache-Control', CACHE);
  return c.json({ publicKey: vapidPublicKey(key) });
});

/**
 * Turn notifications on for a device. A write, so it needs the key - by
 * header, or by the cookie /auth leaves - which keeps a stranger who can read
 * the dashboard from signing their own phone up to it. What is already wrong
 * is recorded without being announced, and the device is sent one message so
 * its owner sees the whole path work.
 */
app.post('/api/push/subscribe', async (c) => {
  if (!vapidKey(c.env)) return c.json({ error: 'notifications to a closed browser are not set up on this server' }, 503);
  const body = await c.req.json<{ endpoint?: unknown }>().catch(() => ({} as { endpoint?: unknown }));
  if (!isPushEndpoint(body.endpoint)) return c.json({ error: 'not a browser push endpoint' }, 400);
  const outcome = await subscribe(c.env.DB, body.endpoint, new URL(c.req.url).origin);
  if (outcome === 'full') return c.json({ error: 'the most devices this server will notify are already signed up' }, 409);
  // Only the first device primes. Priming for a later one would mark as told an
  // event the devices already signed up have not heard yet; a later device
  // simply joins, and hears whatever is new from the next run on.
  if (outcome === 'added' && (await needsPriming(c.env.DB))) await announce(c.env, nowSec(), true);
  await tellOne(c.env, body.endpoint, 'Notifications are on',
    'This device will be told when a system stops mid-day, a fault is recorded, or a SolisCloud login needs renewing.');
  return c.json({ ok: true, state: outcome });
});

app.post('/api/push/unsubscribe', async (c) => {
  const body = await c.req.json<{ endpoint?: unknown }>().catch(() => ({} as { endpoint?: unknown }));
  if (typeof body.endpoint !== 'string') return c.json({ error: 'endpoint missing' }, 400);
  return c.json({ ok: true, removed: await unsubscribe(c.env.DB, body.endpoint) });
});

/** Send one test message to one device, which is how its owner knows it works. */
app.post('/api/push/test', async (c) => {
  const body = await c.req.json<{ endpoint?: unknown }>().catch(() => ({} as { endpoint?: unknown }));
  if (typeof body.endpoint !== 'string') return c.json({ error: 'endpoint missing' }, 400);
  const sent = await tellOne(c.env, body.endpoint, 'SolarLens test', 'If you can read this, notifications reach this device.');
  return sent ? c.json({ ok: true }) : c.json({ error: 'this device is not signed up, or its push service refused' }, 404);
});

/**
 * What a woken device shows. Never cached: the device is asking because
 * something has just been written. `for` is the device's own hash - a hash of
 * its push endpoint, which never leaves - and only a device that is signed up
 * gets an answer. The messages name systems and faults, and the dashboard's
 * reads being public is no reason for this to be.
 */
app.get('/api/push/recent', async (c) => {
  const audience = (c.req.query('for') ?? '').slice(0, 32);
  c.header('Cache-Control', 'no-store');
  const found = await recentMessages(c.env.DB, audience);
  if (!found) return c.json({ error: 'not a device signed up for notifications' }, 404);
  return c.json({ now: nowSec(), ...found });
});

/**
 * How fresh each feed is, and nothing else: open to anyone even when sign-in is
 * required, so an uptime monitor - and the deploy's own smoke test - can tell
 * that readings are arriving without being able to read them.
 */
app.get('/api/status', async (c) => {
  const feeds = latestPerProvider(await recentPolls(c.env.DB, 200)).map((f) => ({ provider: f.provider, ok: f.ok, ts: f.ts }));
  c.header('Cache-Control', 'public, max-age=60');
  return c.json({ now: nowSec(), feeds });
});

app.get('/api/health', async (c) => {
  // `polls` is the recent history; `feeds` is the newest line per provider, so
  // a feed that has gone quiet cannot be hidden by a busier one logging over it.
  // One read, two answers: the recent history, and the newest line per feed
  // folded out of the same rows. 200 covers well over a day of both feeds.
  const now = nowSec();
  // Relays that have reported in the last fortnight. A laptop switched off for
  // longer than that drops out of the list instead of warning about a login
  // nobody is using.
  const [polls, relays] = await Promise.all([recentPolls(c.env.DB, 200), listRelays(c.env.DB, now - 14 * 86400)]);
  const feeds = latestPerProvider(polls);
  // The footer shows every feed; the table below it wants only the recent few.
  c.header('Cache-Control', CACHE);
  return c.json({ now, polls: polls.slice(0, 20), feeds, relays: publicRelays(relays) });
});

/**
 * Daily history, one row per inverter per day.
 *
 * `tz` is the caller's UTC offset in minutes (what `getTimezoneOffset()`
 * returns), because a solar day ends at the array's midnight and not at UTC's.
 */
/**
 * Fault history, newest first.
 *
 * Open like every other read. What an alarm carries is a code, a message, a
 * severity, the vendor's advice and two times - nothing that identifies the
 * owner - and the system it belongs to is named by its alias.
 */
app.get('/api/alarms', async (c) => {
  const days = Math.min(3650, Math.max(1, Number(c.req.query('days') ?? 730)));
  const since = nowSec() - days * 86400;
  const [rows, ids] = await Promise.all([listAlarms(c.env.DB, since), inverterIds(c.env.DB)]);
  c.header('Cache-Control', CACHE);
  return c.json({ now: nowSec(), days, alarms: publicAlarms(rows, aliasFor(ids)) });
});

/** The vendors' own month and year totals, reaching back before SolarLens began collecting. */
app.get('/api/periods', async (c) => {
  const [rows, ids] = await Promise.all([listPeriods(c.env.DB), inverterIds(c.env.DB)]);
  c.header('Cache-Control', CACHE);
  return c.json({ now: nowSec(), periods: publicRows(rows, aliasFor(ids)) });
});

app.get('/api/history', async (c) => {
  const days = Math.min(400, Math.max(1, Number(c.req.query('days') ?? 30)));
  const tz = Number(c.req.query('tz') ?? 0);
  if (!Number.isFinite(tz) || Math.abs(tz) > 900) return c.json({ error: 'tz out of range' }, 400);
  const to = nowSec();
  const from = to - days * 86400;
  const [rows, ids] = await Promise.all([daily(c.env.DB, from, to, tz), inverterIds(c.env.DB)]);
  c.header('Cache-Control', CACHE);
  return c.json({ now: to, days, rows: publicRows(rows, aliasFor(ids)) });
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

/**
 * The hardware. The owner also gets each datalogger's network handles - its
 * operator and cell, or its MAC address - which nobody else ever does: they
 * are joined in here, after the public view has made each row safe.
 */
app.get('/api/devices', async (c) => {
  const isOwner = c.get('caller').role === 'owner';
  const [devices, ids, networks] = await Promise.all([
    listDevices(c.env.DB), inverterIds(c.env.DB), isOwner ? deviceNetworks(c.env.DB) : Promise.resolve(null),
  ]);
  const rows = publicDevices(devices, aliasFor(ids)).map((row, i) => {
    const network = networks?.get(devices[i].id);
    return network ? { ...row, network } : row;
  });
  c.header('Cache-Control', CACHE);
  return c.json({ now: nowSec(), devices: rows });
});

/**
 * Each device's link history: status and signal over the last few days, for
 * the Devices tab's strip and signal line. Rows are written only when something
 * moved (see recordDeviceSample), so a week is a few hundred rows at most.
 * `days` is 1 to 30, 7 by default; anything that is not a number is the default.
 */
app.get('/api/devices/history', async (c) => {
  const asked = Number(c.req.query('days') ?? 7);
  const days = Number.isFinite(asked) ? Math.min(30, Math.max(1, Math.round(asked))) : 7;
  const from = nowSec() - days * 86400;
  const [devices, ids, samples] = await Promise.all([listDevices(c.env.DB), inverterIds(c.env.DB), deviceSamples(c.env.DB, from)]);
  c.header('Cache-Control', CACHE);
  return c.json({
    now: nowSec(), days, from,
    samples: publicDeviceSamples(samples, deviceAliasFor(devices, aliasFor(ids))),
  });
});

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
    // The relay sends the plant snapshot untouched, and SolisCloud's carries the
    // plant's timezone. Without this the relayed plant was the one system whose
    // day was still cut at the reader's midnight.
    tzOffsetSec: tzOffsetSec(body.raw),
    tzName: tzNameOf(body.raw),
  };
  const source = body.source ?? `${body.provider}-relay`;
  const reading =
    body.provider === 'soliscloud'
      ? solisStationReading(inv, body.raw, source)
      : solarmanStationReading(inv, body.raw, source);
  if (!inv.name) inv.name = inv.plantName = plantId;
  await upsertInverter(c.env.DB, inv);
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
/** The relay's shared secret, checked the same way on every ingest route. */
function ingestRefusal(c: { env: Env; req: { header: (n: string) => string | undefined } }): { error: string; status: 401 | 503 } | null {
  const token = c.env.INGEST_TOKEN;
  if (!token) return { error: 'INGEST_TOKEN not configured', status: 503 };
  const given = bearer(c.req.header('Authorization')) ?? '';
  return timingSafeEqual(given, token) ? null : { error: 'unauthorized', status: 401 };
}

/**
 * A relay's report on itself: whether its SolisCloud login works, and when that
 * login expires. Sent after every cycle, so the dashboard can warn days before
 * a relay goes quiet instead of only noticing afterwards.
 */
app.post('/api/ingest/relay', async (c) => {
  const refused = ingestRefusal(c);
  if (refused) return c.json({ error: refused.error }, refused.status);
  const parsed = parseRelayStatus(await c.req.json().catch(() => null), nowSec());
  if ('error' in parsed) return c.json({ error: parsed.error }, 400);
  await upsertRelay(c.env.DB, parsed);
  return c.json({ stored: true });
});

/**
 * SolisCloud alarms, as the relay reads them off the portal's alarm page.
 *
 * The relay sends the vendor's records untouched and they are normalised here,
 * so the one place that decides which fields are kept - and which personal ones
 * are dropped - is the Worker, not a script on somebody's laptop.
 */
app.post('/api/ingest/alarms', async (c) => {
  const refused = ingestRefusal(c);
  if (refused) return c.json({ error: refused.error }, refused.status);
  const body = (await c.req.json()) as { provider?: string; plantId?: string | number; records?: unknown[] };
  if (body?.provider !== 'soliscloud' || !body.plantId || !Array.isArray(body.records)) {
    return c.json({ error: 'provider soliscloud, plantId and records required' }, 400);
  }
  const plantId = String(body.plantId);
  if (!plantFilter(c.env)(plantId)) return c.json({ stored: 0, skipped: 'not in INCLUDE_PLANTS' });
  // One page of the portal's table is ten rows and the relay sends at most a
  // few pages; anything far larger is not an alarm list.
  if (body.records.length > 500) return c.json({ error: 'too many records' }, 400);
  const alarms = body.records
    .map((r) => (r && typeof r === 'object' ? solisAlarm(plantId, r as Record<string, unknown>) : null))
    .filter((a): a is NonNullable<typeof a> => a !== null);
  const stored = await upsertAlarms(c.env.DB, alarms);
  return c.json({ stored, received: body.records.length });
});

/**
 * SolisCloud's own day, month and year totals, as the relay reads them off the
 * plant page's Month, Year and Lifetime tabs.
 *
 * Checked against the nameplate before anything is written: a 12 kW array
 * cannot make more than 288 kWh in a day, and a unit error in a total is far
 * harder to spot in a bar chart than a refusal is here.
 */
app.post('/api/ingest/periods', async (c) => {
  const refused = ingestRefusal(c);
  if (refused) return c.json({ error: refused.error }, refused.status);
  const body = (await c.req.json()) as {
    provider?: string; plantId?: string | number; which?: string; points?: unknown[];
  };
  const which = body?.which;
  if (body?.provider !== 'soliscloud' || !body.plantId || !Array.isArray(body.points)
    || (which !== 'month' && which !== 'year' && which !== 'all')) {
    return c.json({ error: 'provider soliscloud, plantId, which (month|year|all) and points required' }, 400);
  }
  const plantId = String(body.plantId);
  if (!plantFilter(c.env)(plantId)) return c.json({ stored: 0, skipped: 'not in INCLUDE_PLANTS' });
  if (body.points.length > 400) return c.json({ error: 'too many points' }, 400);

  const periods = solisPeriods(plantId, which,
    body.points.filter((p): p is Record<string, unknown> => !!p && typeof p === 'object'));
  const nameplate = await c.env.DB
    .prepare('SELECT capacity_w FROM inverters WHERE id = ?1')
    .bind(`soliscloud:station:${plantId}`)
    .first<{ capacity_w: number | null }>();
  const capKw = (nameplate?.capacity_w ?? 0) / 1000;
  if (capKw > 0) {
    const hours = { day: 24, month: 24 * 31, year: 24 * 366 } as const;
    const bad = periods.find((p) => (p.yieldKwh ?? 0) > capKw * hours[p.period]);
    if (bad) {
      return c.json({ error: `${bad.key}: ${bad.yieldKwh} kWh exceeds what a ${capKw} kW array can make in a ${bad.period}` }, 422);
    }
  }
  const stored = await upsertPeriods(c.env.DB, periods);
  return c.json({ stored, received: body.points.length });
});

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
  /** The five-minute cron (wrangler.jsonc triggers): poll every vendor, then judge notifications. */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    // Notifications are judged after the poll, against what it just stored. A
    // failure there is logged and dropped: it must never cost a reading.
    ctx.waitUntil(pollAll(env).then(async () => {
      try {
        await announce(env);
        await forgetOldMessages(env.DB);
      } catch (e) {
        console.error('push:', String(e));
      }
      // Housekeeping, kept apart so a push failure never leaves it undone.
      try {
        await forgetOldDeviceSamples(env.DB);
      } catch (e) {
        console.error('housekeeping:', String(e));
      }
    }));
  },
} satisfies ExportedHandler<Env>;
