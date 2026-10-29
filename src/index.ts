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
 * - The owner writing: signing a phone up for notifications, setting the
 *   tariff, the systems' groups or the places alerts are posted to
 *   (/api/settings/*), or forcing a poll.
 * - Home Assistant, reading /api/sensors on a timer - with a share link as a
 *   bearer token when the dashboard is private.
 * - The assistant (/api/chat, and /api/ask for one question), for anyone who
 *   may read: the model's words for someone signed in - the owner, or a share
 *   link - since they spend the day's model calls; SolarLens's own reading of
 *   the question for anyone else.
 * - AI apps outside SolarLens, through the MCP server at /mcp (./mcp), each
 *   with an OAuth token from an approval the owner gave once (./oauth). Those need the owner signed in, or API_TOKEN as a header - except
 *   turning a phone's notifications off, which needs only that phone's own
 *   push address (see the middleware below).
 * - The sign-in routes under /auth (./auth/routes), and share links at /s/.
 *
 * Anything else is the dashboard itself, served from public/ by the
 * static-assets binding at the bottom of this file. The page holds no data of
 * its own - it is the same file as in the public repository - so it is served
 * to anyone, and asks for a sign-in when the API says one is needed.
 *
 * The crons (scheduled, at the very end): every five minutes, poll every vendor
 * the secrets allow, then decide whether anything is worth a notification;
 * once an hour, the week's agents and summary when due, the weather and the
 * housekeeping (./cron hourly).
 */
import { Hono, type Context, type Next } from 'hono';
import { cors } from 'hono/cors';
import { getCookie } from 'hono/cookie';
import type { Env } from './db';
import { auth, applyCookies, openShareLink, type AuthVars } from './auth/routes';
import { REFRESH_COOKIE, SESSION_COOKIE, type Caller, identify, openShare, owner } from './auth/sessions';
import { keySecret, timingSafeEqual } from './auth/crypto';
import { locationOf, locations, upsertLocation, weatherSince } from './weather';
import { expectedToday } from './expected';
import { getGroups, getTariff, parseGroups, parseTariff, setGroups, setTariff } from './settings';
import { MAX_CHANNELS, addChannel, channelsFor, deliver, getChannel, listChannels, parseChannel, publicChannel, removeChannel, testMessage, updateChannel } from './channels';
import { buildSummary, currentSlot, summaryMessage, withReport } from './summary';
import { aiModel, callsUsed, dailyCalls, hasAi, providerOf } from './ai';
import { ask } from './ask';
import { converse } from './assistant';
import { latestReports } from './agents';
import { ANONYMOUS_DAYS, TOOLS, jsonSchemaOf, runTool, type ToolLimits } from './tools';
import {
  appForToken, approve, authorizationServer, checkAuthorization, connectedApps, consentPage, deny, errorPage,
  protectedResource, register, registration, revokeGrant, revokeToken, signInPage, token,
} from './oauth';
import { handleMcp } from './mcp';
import { HOURLY, hourly } from './cron';
import { sensors } from './sensors';
import {
  daily, dbBytes, deviceNetworks, deviceSamples, earliestDayStart, insertHistory, insertReading,
  inverterIds, latest, latestPerProvider, listAlarms, listDevices, listPeriods, listRelays, logPoll, nowSec, recentPolls, series,
  upsertAlarms, upsertDevice, upsertInverter, upsertPeriods, upsertRelay,
} from './db';
import { solisAlarm, solisPeriods } from './providers/events';
import { tzNameOf, tzOffsetSec } from './providers/units';
import { aliasFor, deviceAliasFor, publicAlarms, publicDeviceSamples, publicDevices, publicInverters, publicRelays, publicRows } from './public-view';
import { parseRelayStatus } from './relays';
import { plantFilter, pollAll } from './poll';
import { announce, forgetToldIfAlone, isPushEndpoint, needsPriming, recentMessages, subscribe, tellOne, unsubscribe, vapidKey, vapidPublicKey } from './push';
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
 * The page loads one web font from Google, and - on the owner's site map only -
 * Leaflet from cdnjs (integrity-checked) and tiles from OpenStreetMap; the policy is
 * strict about everything but those, and about where the page may send data:
 * `connect-src 'self'` stops a script from posting a reading to another site
 * with fetch, and `form-action 'none'` with a form. It does not stop a script
 * that runs from navigating the page away with data in the address, which no
 * policy can - the defence against that is the page never letting one run
 * (every value it shows is escaped). `frame-ancestors 'none'` keeps the page
 * out of somebody else's iframe.
 *
 * Kept identical to public/_headers, which covers the same page when the edge
 * serves it without invoking this Worker at all (scripts/ci/check-headers.mjs).
 *
 * `'unsafe-inline'` is unavoidable while the script and styles live in the
 * HTML; that is the deliberate trade for having no build step.
 *
 * `Strict-Transport-Security` keeps a browser from ever trying plain http once it
 * has been here, where a network could read a session on its way; a year, and
 * this host only - a custom domain's other hosts are not this Worker's to
 * decide. `Permissions-Policy` turns off the device features the page never
 * uses, so nothing that got into it could ask for a camera or a location.
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
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https://tile.openstreetmap.org",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; '));
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'no-referrer');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('X-Frame-Options', 'DENY');
  h.set('Strict-Transport-Security', 'max-age=31536000');
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  c.res = res;
});

/** The token from an "Authorization: Bearer <token>" header, or null. */
function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1].trim() : null;
}

/** A share link's token, "<id>.<secret>": the part of the link after /s/. */
const SHARE_TOKEN = /^[\w-]{6,40}\.[\w-]{16,80}$/;

/**
 * Who is asking, for every route that answers with data or signs in.
 *
 * The API token as a header is the owner. A share link's token as a header
 * is a viewer, as the link itself would make a browser: that is how Home
 * Assistant reads a private dashboard, and taking the link back stops it.
 * Otherwise the session and refresh cookies are read, and renewed on the way
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
  } else if (secret && given && SHARE_TOKEN.test(given) && (await openShare(c.env.DB, given, nowSec()))) {
    caller = { role: 'viewer', deviceId: null, via: 'link' };
  } else if (secret) {
    const session = getCookie(c, SESSION_COOKIE);
    const refresh = getCookie(c, REFRESH_COOKIE);
    if (session || refresh) {
      // Signed under the key secret (./auth/crypto keySecret): SECRET_KEY, or API_TOKEN without one.
      const found = await identify(c.env.DB, keySecret(c.env)!, { session, refresh }, nowSec());
      caller = found.caller;
      applyCookies(c, found.set);
    }
  }
  c.set('caller', caller);
  return next();
};
for (const path of ['/api/*', '/auth', '/auth/*', '/s/*', '/oauth/authorize']) app.use(path, identifyCaller);

/**
 * Callers who are not signed in, held to Cloudflare's rate limiting binding
 * (RATE_LIMIT) when the Worker has one - per address, so one visitor asking
 * too fast is slowed without anyone else noticing.
 *
 * The expensive answers are reads anyone may ask for while the dashboard is
 * open to all - a year of history, a report - and on D1's free plan a day's
 * reads are a fixed allowance for everything, the poller's included, until
 * midnight UTC. Signed-in callers are never held back, nor the relays, which
 * carry their own token. Without the binding nothing changes: it is added in
 * wrangler.jsonc ("ratelimits", see the README), as not every plan has it.
 */
const rateLimited = async (c: Context<{ Bindings: Env; Variables: AuthVars }>, next: Next) => {
  const limiter = c.env.RATE_LIMIT;
  if (!limiter || c.get('caller')?.role || c.req.path.startsWith('/api/ingest')) return next();
  const { success } = await limiter.limit({ key: c.req.header('cf-connecting-ip') ?? 'unknown' });
  if (success) return next();
  c.header('Retry-After', '60');
  return c.json({ error: 'Too many requests from this address. Wait a minute, or sign in.' }, 429);
};
for (const path of ['/api/*', '/auth/*', '/oauth/register']) app.use(path, rateLimited);

/** A whole number from a query parameter, inside its range; the default for anything that is not a number. */
function intParam(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

/** A request's JSON body, or null when it is not JSON: a malformed body is the sender's mistake, answered 400, never a crash. */
const jsonOf = <T>(c: Context): Promise<T | null> => c.req.json<T>().catch(() => null);

/** What a caller not signed in may ask of the tools (./tools ANONYMOUS_DAYS); a signed-in one, anything. */
const toolLimits = (c: Context<{ Bindings: Env; Variables: AuthVars }>): ToolLimits => (c.get('caller').role ? {} : { maxDays: ANONYMOUS_DAYS });

/**
 * /auth?t=<API_TOKEN>, the 2.x way to unlock a device, signs nothing in any
 * more. A link carrying the key to everything travels badly: into the
 * browser's history, into request logs, onto whatever it is pasted into. The
 * same key typed as the setup code on the sign-in page (POST /auth/setup) does
 * the same job without leaving it anywhere, and a share link signs a device in
 * to view. So the address only says where to go instead, whatever it carries,
 * and never whether the token given was right.
 */
app.get('/auth', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.text('This link no longer signs a browser in. Open SolarLens and sign in with a passkey, the password, or the setup code (your API_TOKEN).', 410);
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
/**
 * Posts that only read: a message to the assistant. They are answered as a
 * read is - open, or with sign-in required, for the owner and a share link -
 * and the route itself decides who may spend a model call.
 */
const READING_POSTS = new Set(['/api/ask', '/api/chat']);
const ALWAYS_OPEN = new Set(['/api/status', '/api/push/key', '/api/push/recent', '/api/push/unsubscribe']);
app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/ingest' || c.req.path.startsWith('/api/ingest/')) return next();
  // Turning notifications off for a device takes that device's own push
  // endpoint, which only it knows; it can do no harm to anyone else, and asking
  // for a sign-in to stop notifications would only keep unwanted ones coming.
  if (ALWAYS_OPEN.has(c.req.path)) return next();
  const caller = c.get('caller');

  if (c.req.method === 'GET' || READING_POSTS.has(c.req.path)) {
    if (caller.role) return next();
    const o = await owner(c.env.DB);
    if (o?.require_sign_in) return c.json({ error: 'signin' }, 401);
    return next();
  }

  // Without API_TOKEN nobody can be the owner, so nothing may be written. This
  // used to let every write through, with a line in the log: a deploy that lost
  // the secret became one anyone could change.
  if (!c.env.API_TOKEN) {
    return c.json({ error: 'This server has no API_TOKEN, so nothing on it can be changed. Set one: npm run cf -- secret put API_TOKEN' }, 503);
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
 * Each system's weather, hour by hour: sunlight on the ground, temperature and
 * cloud, for the expected-output line and the underperformance alert. The
 * systems are named by alias, and no position is in it. `days` is 1 to 14.
 */
app.get('/api/weather', async (c) => {
  const asked = Number(c.req.query('days') ?? 2);
  const days = Number.isFinite(asked) ? Math.min(14, Math.max(1, Math.round(asked))) : 2;
  const from = nowSec() - days * 86400;
  const [hours, ids] = await Promise.all([weatherSince(c.env.DB, from), inverterIds(c.env.DB)]);
  c.header('Cache-Control', CACHE);
  return c.json({ now: nowSec(), days, from, hours: publicRows(hours, aliasFor(ids)) });
});

/**
 * What each system should have made today, from the sunlight it has had and
 * the ratio learned from its last fortnight (./expected). A system with no
 * position, no size or no weather yet is simply not in the list.
 */
app.get('/api/expected', async (c) => {
  const rows = await latest(c.env.DB);
  const alias = aliasFor(rows.map((r) => r.id));
  const systems = await expectedToday(c.env.DB, rows);
  c.header('Cache-Control', CACHE);
  return c.json({ now: nowSec(), systems: systems.map((e) => ({ ...e, inverter_id: alias(e.inverter_id) })) });
});

/**
 * Where each system is, for the owner's site map. The one read that is the
 * owner's alone whatever the switch says: a share link does not get it, and
 * nor does anyone while the dashboard is open to all.
 */
app.get('/api/locations', async (c) => {
  if (c.get('caller').role !== 'owner') return c.json({ error: 'owner only' }, 401);
  const [rows, ids] = await Promise.all([locations(c.env.DB), inverterIds(c.env.DB)]);
  const alias = aliasFor(ids);
  c.header('Cache-Control', CACHE);
  return c.json({ now: nowSec(), locations: rows.map((r) => ({ id: alias(r.inverter_id), lat: r.lat, lng: r.lng })) });
});

/**
 * The tariff the owner set in Settings, from which the page works out what the
 * sun has saved and the CO2 it has avoided (./settings). Read by anyone who
 * may read the dashboard, since the savings are shown to them too: prices and
 * a carbon figure say nothing about who or where the owner is beyond a
 * currency. `tariff` is null until the owner fills it in.
 */
app.get('/api/settings/tariff', async (c) => {
  c.header('Cache-Control', CACHE);
  return c.json({ tariff: await getTariff(c.env.DB) });
});

/** Set the tariff: the owner only, as every write under /api/ (the middleware above). */
app.put('/api/settings/tariff', async (c) => {
  const parsed = parseTariff(await c.req.json().catch(() => null));
  if ('error' in parsed) return c.json({ error: parsed.error }, 400);
  await setTariff(c.env.DB, parsed.tariff);
  return c.json({ tariff: parsed.tariff });
});

/** Forget the tariff, and with it every money figure on the page. */
app.delete('/api/settings/tariff', async (c) => {
  await setTariff(c.env.DB, null);
  return c.json({ tariff: null });
});

/**
 * The groups the owner sorts the systems into, by alias: `{ groups: { s1: 'Home' } }`.
 * Read by anyone who may read the dashboard, since the Overview is laid out by
 * them. A group kept for a system that has since gone is simply not served.
 */
app.get('/api/settings/groups', async (c) => {
  const [groups, ids] = await Promise.all([getGroups(c.env.DB), inverterIds(c.env.DB)]);
  const alias = aliasFor(ids);
  const known = new Set(ids);
  c.header('Cache-Control', CACHE);
  return c.json({ groups: Object.fromEntries(Object.entries(groups).filter(([id]) => known.has(id)).map(([id, name]) => [alias(id), name])) });
});

/**
 * Set every system's group at once, by alias; a system left out, or sent with
 * a blank name, is in no group. The owner only, as every write under /api/.
 */
app.put('/api/settings/groups', async (c) => {
  const ids = await inverterIds(c.env.DB);
  const alias = aliasFor(ids);
  const byAlias = new Map(ids.map((id) => [alias(id), id]));
  const parsed = parseGroups(await c.req.json().catch(() => null), (a) => byAlias.get(a) ?? null);
  if ('error' in parsed) return c.json({ error: parsed.error }, 400);
  await setGroups(c.env.DB, parsed.groups);
  return c.json({ groups: Object.fromEntries(Object.entries(parsed.groups).map(([id, name]) => [alias(id), name])) });
});

/**
 * Every figure Home Assistant wants, flat and under names that do not move
 * (./sensors). A read like any other: open, or - with sign-in required - for
 * the owner and a share link, which Home Assistant sends as a bearer token.
 */
app.get('/api/sensors', async (c) => {
  c.header('Cache-Control', CACHE);
  return c.json(await sensors(c.env.DB));
});

/**
 * The last `days` full days (7 unless asked; 1 to 31), system by system,
 * against the days before - what the weekly summary says, as data and in words.
 */
app.get('/api/summary', async (c) => {
  const asked = Number(c.req.query('days') ?? 7);
  const days = Number.isFinite(asked) ? Math.min(31, Math.max(1, Math.round(asked))) : 7;
  const s = await buildSummary(c.env.DB, nowSec(), days);
  const { title, body } = summaryMessage(s);
  c.header('Cache-Control', CACHE);
  return c.json({ ...s, message: { title, body } });
});

// ---------- Ask SolarLens, the tools and the agents (./ask, ./tools, ./agents) ----------

/**
 * Whether there is a model here (`available`), which one and where it runs,
 * whether this caller may use it (`can_ask`: anyone signed in), and how much
 * of today's allowance is used.
 */
app.get('/api/ask/status', async (c) => {
  c.header('Cache-Control', CACHE);
  return c.json({
    available: hasAi(c.env), model: hasAi(c.env) ? aiModel(c.env) : null, provider: providerOf(c.env),
    used: await callsUsed(c.env.DB), limit: dailyCalls(c.env), can_ask: !!c.get('caller').role,
  });
});

/**
 * One question - `{question}` - or a tool asked for directly - `{tool, args}`.
 * Anyone who may read may ask; only someone signed in - the owner, or a share
 * link - spends a model call, since a stranger could spend the day's allowance.
 * Anyone else is answered by SolarLens reading the question itself.
 */
app.post('/api/ask', async (c) => {
  const out = await ask(c.env, await c.req.json().catch(() => null), !!c.get('caller').role, nowSec(), toolLimits(c));
  c.header('Cache-Control', 'no-store');
  return c.json(out.body, out.status as 200);
});

/**
 * The assistant: `{messages}`, the conversation so far with the owner's
 * latest last, answered with the figures it used. The Worker keeps none of
 * the conversation. Who may spend a model call is as for /api/ask.
 */
app.post('/api/chat', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { messages?: unknown } | null;
  const out = await converse(c.env, { messages: body?.messages }, !!c.get('caller').role, nowSec(), toolLimits(c));
  c.header('Cache-Control', 'no-store');
  return c.json(out.body, out.status as 200);
});

/** The read-only tools: what each answers and the arguments it takes, as JSON Schema. */
app.get('/api/tools', (c) => {
  c.header('Cache-Control', CACHE);
  return c.json({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: jsonSchemaOf(t) })) });
});

/**
 * One tool, run with its arguments as the query string, answered in its own
 * words: no model, and so a read like any other - open, or with sign-in
 * required, for the owner and a share link. A caller not signed in may ask
 * for a year of dates at most (./tools ANONYMOUS_DAYS).
 */
app.get('/api/tools/:name', async (c) => {
  const out = await runTool(c.env.DB, c.req.param('name'), c.req.query(), nowSec(), toolLimits(c));
  c.header('Cache-Control', CACHE);
  if ('error' in out) return c.json({ error: out.error }, TOOLS.some((t) => t.name === c.req.param('name')) ? 400 : 404);
  return c.json(out);
});

/** The newest weekly report, and each system's newest health check. */
app.get('/api/agents', async (c) => {
  c.header('Cache-Control', CACHE);
  return c.json(await latestReports(c.env.DB));
});

// ---------- the MCP server, and the OAuth that guards it (./mcp, ./oauth) ----------

/**
 * Open to scripts on any site, as an MCP client or an app's OAuth library may
 * be one: these answer only to a bearer token or a PKCE verifier, never to a
 * cookie, so another site gains nothing it could not do from anywhere. The
 * approval page is not among them: it answers only the owner's own browser.
 */
const openCors = cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type', 'Mcp-Session-Id', 'MCP-Protocol-Version', 'Last-Event-ID'],
  exposeHeaders: ['WWW-Authenticate', 'Mcp-Session-Id'],
  maxAge: 86400,
});
for (const path of ['/mcp', '/.well-known/*', '/oauth/token', '/oauth/register', '/oauth/revoke']) app.use(path, openCors);

const originOf = (c: Context) => new URL(c.req.url).origin;

/** Where the MCP server's tokens come from (RFC 9728), at the root and at the resource's own path. */
for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
  app.get(path, (c) => c.json(protectedResource(originOf(c))));
}
/** The authorization server's endpoints (RFC 8414); some clients look for them under the resource's path too. */
for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp']) {
  app.get(path, (c) => c.json(authorizationServer(originOf(c))));
}

/** An app registers itself (RFC 7591): a public client, with PKCE and no secret. */
app.post('/oauth/register', async (c) => {
  const out = await register(c.env.DB, await c.req.json().catch(() => null));
  c.header('Cache-Control', 'no-store');
  if ('error' in out) return c.json({ error: out.error, error_description: out.description }, 400);
  return c.json(registration(out.client), 201);
});

/**
 * The approval page. A link naming an unknown app or an address it did not
 * register is answered here, never sent on; anything else wrong goes back to
 * the app, as OAuth says. The owner, signed in on this browser, is asked;
 * anyone else is asked to sign in first, and brought back here after.
 */
app.get('/oauth/authorize', async (c) => {
  const params = c.req.query();
  const checked = await checkAuthorization(c.env.DB, params, originOf(c));
  c.header('Cache-Control', 'no-store');
  if ('page' in checked) return c.html(errorPage(checked.page), 400);
  if ('redirect' in checked) return c.redirect(checked.redirect, 302);
  const caller = c.get('caller');
  if (caller.role !== 'owner' || (caller.via !== 'session' && caller.via !== 'refresh')) {
    return c.html(signInPage(`/oauth/authorize?${new URL(c.req.url).searchParams}`, caller.role === 'viewer'));
  }
  return c.html(consentPage(checked.ok, params));
});

/**
 * The owner's choice, posted by the approval page: from a signed-in browser
 * only - its session cookie never leaves this site, and a script elsewhere
 * cannot post JSON here without a CORS answer it never gets. The request is
 * checked again, whole, before a code is made.
 */
app.post('/oauth/authorize', async (c) => {
  const origin = originOf(c);
  const from = c.req.header('Origin');
  if (from && from !== origin) return c.json({ error: 'forbidden' }, 403);
  const caller = c.get('caller');
  if (caller.role !== 'owner' || (caller.via !== 'session' && caller.via !== 'refresh')) {
    return c.json({ error: 'Only the owner, signed in on this browser, can connect an app.' }, 401);
  }
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: 'The request is not JSON.' }, 400);
  const params = Object.fromEntries(Object.entries(body).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  const checked = await checkAuthorization(c.env.DB, params, origin);
  c.header('Cache-Control', 'no-store');
  if ('page' in checked) return c.json({ error: checked.page }, 400);
  if ('redirect' in checked) return c.json({ redirect: checked.redirect });
  return c.json({ redirect: body.allow === true ? await approve(c.env.DB, checked.ok, origin) : deny(checked.ok, origin) });
});

/** A token endpoint's fields: a form, as OAuth sends them, or JSON, which some clients do. */
async function formOf(c: Context): Promise<Record<string, string | undefined>> {
  const text = await c.req.text().catch(() => '');
  if ((c.req.header('content-type') ?? '').includes('application/json')) {
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(j).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
    } catch { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

/** The code and its PKCE verifier for tokens, or a refresh token for the next pair. Never cached. */
app.post('/oauth/token', async (c) => {
  const out = await token(c.env.DB, await formOf(c), originOf(c));
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  return c.json(out.body, out.status as 200);
});

/** An app disconnects itself (RFC 7009). Always 200: the answer never says which tokens exist. */
app.post('/oauth/revoke', async (c) => {
  await revokeToken(c.env.DB, (await formOf(c)).token);
  return c.body(null, 200);
});

/**
 * The MCP server. An access token from an approved app, or 401 with the way to
 * get one (RFC 9728) - which is how an MCP client finds the approval page on
 * its own. The owner's cookie is not enough: an app is always an app.
 */
app.all('/mcp', async (c) => {
  const given = bearer(c.req.header('Authorization'));
  const connected = given ? await appForToken(c.env.DB, given) : null;
  if (!connected) {
    c.header('WWW-Authenticate', `Bearer resource_metadata="${originOf(c)}/.well-known/oauth-protected-resource/mcp"${given ? ', error="invalid_token"' : ''}`);
    return c.json({ error: given ? 'invalid_token' : 'unauthorized', error_description: 'Connect this app to SolarLens first: it will be asked to sign in.' }, 401);
  }
  return handleMcp(c.env, c.req.raw);
});

/** The apps connected to the MCP server, for the owner's Settings, and its address. */
app.get('/api/settings/apps', async (c) => {
  if (c.get('caller').role !== 'owner') return c.json({ error: 'owner only' }, 401);
  c.header('Cache-Control', CACHE);
  return c.json({ apps: await connectedApps(c.env.DB), mcp: `${originOf(c)}/mcp` });
});

/** Disconnect one: its tokens stop at once. */
app.delete('/api/settings/apps/:id', async (c) => {
  return (await revokeGrant(c.env.DB, c.req.param('id'))) ? c.json({ ok: true }) : c.json({ error: 'There is no such app connected.' }, 404);
});

// ---------- the places alerts are posted to (./channels) ----------

/** Channels need a key secret: what posting to them needs is sealed with a key derived from it (./auth/crypto keySecret). */
const NO_TOKEN = 'Set API_TOKEN first (and ideally SECRET_KEY): what these need is kept encrypted with a key derived from them.';

/**
 * The channels, for the owner's Settings: what each takes, where it posts with
 * the secret parts left out, and how its last post went. The owner's alone,
 * whatever the switch says - like the map, a share link does not get it.
 */
app.get('/api/settings/channels', async (c) => {
  if (c.get('caller').role !== 'owner') return c.json({ error: 'owner only' }, 401);
  c.header('Cache-Control', CACHE);
  return c.json({ channels: (await listChannels(c.env.DB)).map(publicChannel), max: MAX_CHANNELS, ready: !!keySecret(c.env) });
});

/**
 * Add a channel, and post a test to it at once, so the owner sees the whole
 * path work. The first listener of all - no device, no channel before it -
 * primes the told-state, and hears what goes wrong from now on rather than
 * everything already wrong.
 */
app.post('/api/settings/channels', async (c) => {
  const keys = keySecret(c.env);
  if (!keys) return c.json({ error: NO_TOKEN }, 503);
  const parsed = parseChannel(await c.req.json().catch(() => null));
  if ('error' in parsed) return c.json({ error: parsed.error }, 400);
  const now = nowSec();
  const row = await addChannel(c.env.DB, keys, parsed, new URL(c.req.url).origin, now);
  if (row === 'full') return c.json({ error: `At most ${MAX_CHANNELS} places can be told. Remove one first.` }, 409);
  if (row.alerts && (await needsPriming(c.env.DB))) await announce(c.env, now, true);
  const test = await deliver(c.env, row, testMessage(row, now), now);
  return c.json({ channel: publicChannel((await getChannel(c.env.DB, row.id))!), test });
});

/** Change what a channel takes, or its name. Turning alerts on for the first listener primes, as adding one does. */
app.patch('/api/settings/channels/:id', async (c) => {
  // Without API_TOKEN the middleware already refuses every write; this says what a channel needs, should that ever change.
  if (!keySecret(c.env)) return c.json({ error: NO_TOKEN }, 503);
  const body = ((await c.req.json().catch(() => null)) ?? {}) as { alerts?: unknown; weekly?: unknown; name?: unknown };
  const row = await updateChannel(c.env.DB, c.req.param('id'), body);
  if (!row) return c.json({ error: 'There is no such channel.' }, 404);
  if ('error' in row) return c.json({ error: row.error }, 400);
  if (row.alerts && (await needsPriming(c.env.DB))) await announce(c.env, nowSec(), true);
  await forgetToldIfAlone(c.env.DB);
  return c.json({ channel: publicChannel(row) });
});

/** Remove a channel. The last listener to go takes the told-state with it. */
app.delete('/api/settings/channels/:id', async (c) => {
  if (!keySecret(c.env)) return c.json({ error: NO_TOKEN }, 503);
  const removed = await removeChannel(c.env.DB, c.req.param('id'));
  await forgetToldIfAlone(c.env.DB);
  return removed ? c.json({ ok: true }) : c.json({ error: 'There is no such channel.' }, 404);
});

/** Post a test to one channel, and say how it went. */
app.post('/api/settings/channels/:id/test', async (c) => {
  if (!keySecret(c.env)) return c.json({ error: NO_TOKEN }, 503);
  const row = await getChannel(c.env.DB, c.req.param('id'));
  if (!row) return c.json({ error: 'There is no such channel.' }, 404);
  const now = nowSec();
  return c.json(await deliver(c.env, row, testMessage(row, now), now));
});

/**
 * Send the weekly summary now, to every channel that takes it - the owner's
 * way to see one without waiting for Monday. The Monday one still goes out.
 */
app.post('/api/settings/summary', async (c) => {
  if (!keySecret(c.env)) return c.json({ error: NO_TOKEN }, 503);
  const rows = await channelsFor(c.env.DB, 'weekly');
  if (!rows.length) return c.json({ error: 'No channel takes the weekly summary.' }, 409);
  const now = nowSec();
  const msg = await withReport(c.env.DB, summaryMessage(await buildSummary(c.env.DB, now)), await currentSlot(c.env.DB, now));
  let sent = 0;
  for (const row of rows) if ((await deliver(c.env, row, msg, now)).ok) sent++;
  return c.json({ sent, of: rows.length, title: msg.title, body: msg.body });
});

/**
 * How fresh each feed is, and how large the database has grown, and nothing
 * else: open to anyone even when sign-in is required, so an uptime monitor -
 * the deploy's own smoke test, and the watcher (scripts/ci/watch.mjs), which
 * also warns before the database reaches its plan's limit - can tell that
 * readings are arriving without being able to read them. A size in bytes says
 * nothing about whose systems these are.
 */
app.get('/api/status', async (c) => {
  const [polls, size] = await Promise.all([recentPolls(c.env.DB, 200), dbBytes(c.env.DB)]);
  const feeds = latestPerProvider(polls).map((f) => ({ provider: f.provider, ok: f.ok, ts: f.ts }));
  c.header('Cache-Control', 'public, max-age=60');
  return c.json({ now: nowSec(), feeds, db_bytes: size });
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
  const days = intParam(c.req.query('days'), 730, 1, 3650);
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
  const days = intParam(c.req.query('days'), 30, 1, 400);
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
 * Push endpoint for a local agent - the Modbus agent on the roadmap, or
 * anything else on your side of the LAN. Same normalised Reading shape, tagged
 * with whatever `source` the sender declares, so the UI treats it as just
 * another feed.
 *
 * Nothing sends to it yet, and it takes a reading as given rather than a vendor
 * payload to normalise, so it checks what it is given as the other ingest
 * routes' normalisers would: each field of its type, text of a sensible length,
 * and the same INCLUDE_PLANTS rule, so a token cannot bring in a plant the
 * dashboard should ignore.
 */
app.post('/api/ingest', async (c) => {
  const refused = ingestRefusal(c);
  if (refused) return c.json({ error: refused.error }, refused.status);
  const body = await jsonOf<{ inverter: Inverter; reading: Omit<Reading, 'inverterId'> }>(c);
  const problem = localPushProblem(body);
  if (problem) return c.json({ error: problem }, 400);
  if (body!.inverter.plantId && !plantFilter(c.env)(String(body!.inverter.plantId))) {
    return c.json({ stored: false, skipped: 'not in INCLUDE_PLANTS' });
  }

  // Every field a push leaves out is stored as not known (null): D1 refuses to
  // bind a value that is missing, and a partial reading used to be a 500.
  const i = body!.inverter;
  const r = body!.reading;
  await upsertInverter(c.env.DB, {
    id: i.id, provider: i.provider, vendorId: i.vendorId ?? i.id, serial: i.serial ?? null, name: i.name ?? i.id,
    plantId: i.plantId ?? '', plantName: i.plantName ?? '', capacityW: i.capacityW ?? null,
    tzOffsetSec: i.tzOffsetSec ?? null, tzName: i.tzName ?? null,
  });
  const stored = await insertReading(c.env.DB, {
    inverterId: i.id,
    ts: r.ts || nowSec(),
    source: r.source || 'local',
    acPowerW: r.acPowerW ?? null, dcPowerW: r.dcPowerW ?? null, todayKwh: r.todayKwh ?? null, totalKwh: r.totalKwh ?? null,
    batterySoc: r.batterySoc ?? null, batteryPowerW: r.batteryPowerW ?? null, gridPowerW: r.gridPowerW ?? null, loadPowerW: r.loadPowerW ?? null,
    tempC: r.tempC ?? null, status: r.status ?? null, metrics: r.metrics ?? null, raw: r.raw ?? null,
  });
  return c.json({ stored });
});

/** The providers a local push may name. */
const LOCAL_PROVIDERS = new Set(['soliscloud', 'solarman', 'local']);
/** A reading's measured fields: each a number, or null. */
const READING_NUMBERS = ['acPowerW', 'dcPowerW', 'todayKwh', 'totalKwh', 'batterySoc', 'batteryPowerW', 'gridPowerW', 'loadPowerW', 'tempC'] as const;

/** What is wrong with a local push - `{ inverter, reading }` - or null when nothing is. */
function localPushProblem(body: { inverter?: unknown; reading?: unknown } | null): string | null {
  const inv = body?.inverter as Record<string, unknown> | undefined;
  const r = body?.reading as Record<string, unknown> | undefined;
  if (!inv || typeof inv !== 'object' || !r || typeof r !== 'object') return 'inverter and reading required';
  if (typeof inv.id !== 'string' || !/^[\w.:-]{1,120}$/.test(inv.id)) return 'inverter.id is 1 to 120 letters, digits, dots, colons, dashes or underscores';
  if (typeof inv.provider !== 'string' || !LOCAL_PROVIDERS.has(inv.provider)) return `inverter.provider is one of ${[...LOCAL_PROVIDERS].join(', ')}`;
  for (const k of ['name', 'plantId', 'plantName', 'serial', 'vendorId'] as const) {
    if (inv[k] != null && (typeof inv[k] !== 'string' || (inv[k] as string).length > 120)) return `inverter.${k} is text of at most 120 characters`;
  }
  if (inv.capacityW != null && (typeof inv.capacityW !== 'number' || !Number.isFinite(inv.capacityW))) return 'inverter.capacityW is a number';
  if (r.ts != null && (typeof r.ts !== 'number' || !Number.isInteger(r.ts) || r.ts < 0)) return 'reading.ts is whole seconds since 1970';
  for (const k of READING_NUMBERS) {
    if (r[k] != null && (typeof r[k] !== 'number' || !Number.isFinite(r[k] as number))) return `reading.${k} is a number, or null`;
  }
  for (const k of ['source', 'status'] as const) {
    if (r[k] != null && (typeof r[k] !== 'string' || (r[k] as string).length > 40)) return `reading.${k} is text of at most 40 characters`;
  }
  if (r.metrics != null && (typeof r.metrics !== 'object' || Array.isArray(r.metrics))) return 'reading.metrics is an object, or null';
  return null;
}

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
  const refused = ingestRefusal(c);
  if (refused) return c.json({ error: refused.error }, refused.status);

  const body = await jsonOf<{
    provider: 'soliscloud';
    plantId: string;
    inverters?: Record<string, unknown>[];
    collectors?: Record<string, unknown>[];
    /** inverter/detail payloads: per-string V/A, per-phase AC, temperature. */
    details?: Record<string, unknown>[];
  }>(c);
  if (body?.provider !== 'soliscloud' || !body?.plantId) {
    return c.json({ error: 'provider=soliscloud and plantId required' }, 400);
  }
  const plantId = String(body.plantId);
  if (!plantFilter(c.env)(plantId)) return c.json({ stored: 0, skipped: 'not in INCLUDE_PLANTS' });
  // A plant's hardware is a handful of records; a push far larger is not a device list.
  if ((body.inverters?.length ?? 0) + (body.collectors?.length ?? 0) + (body.details?.length ?? 0) > 50) {
    return c.json({ error: 'too many devices' }, 400);
  }

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
  const refused = ingestRefusal(c);
  if (refused) return c.json({ error: refused.error }, refused.status);

  const body = await jsonOf<{
    provider: 'soliscloud' | 'solarman';
    plantId: string;
    name?: string;
    capacityW?: number | null;
    source?: string;
    raw: Record<string, unknown>;
  }>(c);
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
  // The snapshot's position, read before anything strips it from the stored
  // copy: kept apart, for the weather and the owner's map.
  await upsertLocation(c.env.DB, inv.id, locationOf(body.raw));
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
  const body = await jsonOf<{ provider?: string; plantId?: string | number; records?: unknown[] }>(c);
  if (!body || body.provider !== 'soliscloud' || !body.plantId || !Array.isArray(body.records)) {
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
  const body = await jsonOf<{
    provider?: string; plantId?: string | number; which?: string; points?: unknown[];
  }>(c);
  const which = body?.which;
  if (!body || body.provider !== 'soliscloud' || !body.plantId || !Array.isArray(body.points)
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
  const refused = ingestRefusal(c);
  if (refused) return c.json({ error: refused.error }, refused.status);

  const body = await jsonOf<{ provider?: string; plantId?: string | number; raw?: unknown }>(c);
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

  // Only the points newer than the last one stored, in batches (../db insertHistory): the relay sends the whole day every time.
  const stored = await insertHistory(c.env.DB, inverterId, source, points);
  return c.json({ stored, points: points.length });
});

// Everything else is the static UI.
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  /**
   * The crons (wrangler.jsonc triggers): every five minutes, poll every vendor,
   * then judge notifications against what was just stored; once an hour, the
   * slower work (./cron hourly). Any other expression is taken as the
   * five-minute one.
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (controller.cron === HOURLY) {
      ctx.waitUntil(hourly(env));
      return;
    }
    ctx.waitUntil((async () => {
      // The run's own slot, not the moment it started: which plants a run reads
      // when there are many is decided by it (./poll plantsThisRun).
      try {
        await pollAll(env, controller.scheduledTime);
      } catch (e) {
        console.error('poll:', String(e));
      }
      // Notifications are judged after the poll, against what it just stored -
      // and still judged if the poll failed, since a vendor that has stopped
      // answering is one of the things they tell. A failure here is logged and
      // dropped: it must never cost a reading.
      try {
        await announce(env);
      } catch (e) {
        console.error('push:', String(e));
      }
    })());
  },
} satisfies ExportedHandler<Env>;
