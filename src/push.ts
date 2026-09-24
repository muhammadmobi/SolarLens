/**
 * Notifications that reach a closed browser: Web Push.
 *
 * The page's own notification switch works only while a tab has the dashboard
 * open. This is the other half. A device that turns it on hands over its push
 * endpoint; every cron run, the Worker looks for something worth saying and, if
 * it finds it, wakes each device with an empty push. The device's service
 * worker then asks /api/push/recent what there is to show.
 *
 * Empty on purpose. A push that carries text has to be encrypted to the
 * device's own keys (RFC 8291), which is a second protocol to get right; a push
 * that carries nothing needs only the sender's signature (RFC 8292, "VAPID"),
 * and keeps what the message says out of the push services altogether.
 *
 * What counts as worth saying is decided here rather than borrowed from the
 * page, because the page may show things that are not worth waking a phone
 * for. The on-grid system goes quiet every night - its inverter sleeps - so
 * "nothing for 15 minutes" is a badge on a screen but would be a nightly false
 * alarm in a pocket. See pushEvents for each rule and why it is shaped so.
 */
import { nowSec, type Env } from './db';
import { publicRelays } from './public-view';

/** Each device the cron may wake. Kept well inside a Worker's fifty outbound calls per run. */
export const MAX_SUBSCRIPTIONS = 10;

/** A feed that stops mid-generation: how long before it is news. */
const QUIET_AFTER_S = 30 * 60;
/** A relay login: how far ahead to warn. The dashboard warns at the same point. */
const LOGIN_WARN_S = 2 * 86400;
/** A vendor alarm older than this when first seen is history, not news. */
const ALARM_FRESH_S = 6 * 3600;
/** An event, once told, is not told again for as long as it stays the same event. */
const TOLD_FOR_S = 30 * 86400;
/** Messages are kept this long for a woken device to read. */
const KEEP_MESSAGES_S = 7 * 86400;
/** How far back a woken device looks. */
const RECENT_S = 30 * 60;

/**
 * Push services a subscription may point at. An endpoint is a URL the Worker
 * will POST to on every alert, so it is held to the services browsers actually
 * use rather than to "any https URL".
 */
const PUSH_HOSTS = [
  'fcm.googleapis.com',            // Chrome, Edge on Android, most Chromium browsers
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
  '.notify.windows.com',           // Edge on Windows, as wns2-*.notify.windows.com
  '.push.apple.com',
];

export function isPushEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:') return false;
  return PUSH_HOSTS.some((h) => (h.startsWith('.') ? url.hostname.endsWith(h) : url.hostname === h));
}

// ---------------------------------------------------------------- keys

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

interface VapidJwk { kty: 'EC'; crv: 'P-256'; x: string; y: string; d: string }

/** The key pair from VAPID_KEY, a private JWK. Null when it is unset or unreadable. */
export function vapidKey(env: Pick<Env, 'VAPID_KEY'>): VapidJwk | null {
  if (!env.VAPID_KEY) return null;
  try {
    const k = JSON.parse(env.VAPID_KEY) as Partial<VapidJwk>;
    return k.kty === 'EC' && k.crv === 'P-256' && k.x && k.y && k.d ? (k as VapidJwk) : null;
  } catch {
    return null;
  }
}

/** The public half, as the browser's pushManager.subscribe wants it: an uncompressed point. */
export function vapidPublicKey(key: VapidJwk): string {
  const x = fromB64url(key.x);
  const y = fromB64url(key.y);
  const point = new Uint8Array(65);
  point[0] = 4;
  point.set(x, 1);
  point.set(y, 33);
  return b64url(point);
}

/**
 * The Authorization header a push service wants: a short-lived ES256 token
 * naming the push service as its audience and the dashboard as its sender.
 * WebCrypto's ECDSA signature is already the raw r||s that JWS expects.
 */
export async function vapidHeader(key: VapidJwk, endpoint: string, subject: string, now = nowSec()): Promise<string> {
  const enc = new TextEncoder();
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: now + 12 * 3600,
    sub: subject,
  })));
  const signing = await crypto.subtle.importKey(
    'jwk', { kty: 'EC', crv: 'P-256', x: key.x, y: key.y, d: key.d, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signing, enc.encode(`${header}.${claims}`)));
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${vapidPublicKey(key)}`;
}

/** A device's address for messages meant only for it: a hash, so the endpoint never leaves. */
export async function audienceOf(endpoint: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint)));
  return b64url(digest).slice(0, 16);
}

// ---------------------------------------------------------------- subscriptions

export interface Subscription { endpoint: string; origin: string; audience: string }

/**
 * Record a device. The origin is the dashboard's own, taken from the request
 * that subscribed; the push service is told that is the sender, which is why
 * this needs no setting of its own. Refuses past MAX_SUBSCRIPTIONS.
 */
export async function subscribe(db: D1Database, endpoint: string, origin: string, now = nowSec()): Promise<'added' | 'known' | 'full'> {
  const known = await db.prepare('SELECT 1 FROM push_subscriptions WHERE endpoint = ?1').bind(endpoint).first();
  if (known) return 'known';
  const { n } = (await db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').first<{ n: number }>())!;
  if (n >= MAX_SUBSCRIPTIONS) return 'full';
  await db
    .prepare('INSERT INTO push_subscriptions (endpoint, origin, audience, created_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(endpoint, origin, await audienceOf(endpoint), now)
    .run();
  return 'added';
}

export async function unsubscribe(db: D1Database, endpoint: string): Promise<boolean> {
  const res = await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?1').bind(endpoint).run();
  return res.meta.changes > 0;
}

// ---------------------------------------------------------------- what is worth saying

export interface PushEvent { key: string; title: string; body: string }

const PROVIDER_NAMES: Record<string, string> = { soliscloud: 'SolisCloud', solarman: 'SolarMan' };
const providerName = (p: string) => PROVIDER_NAMES[p] ?? p;

/** "14:05", in the plant's own zone where it is known. */
function clock(ts: number, offsetSec: number | null): string {
  const m = Math.floor((((ts + (offsetSec ?? 0)) % 86400) + 86400) % 86400 / 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

const kw = (w: number) => (w >= 1000 ? `${(w / 1000).toFixed(1)} kW` : `${Math.round(w)} W`);

/**
 * Everything currently worth a notification. Each event's key names the
 * occurrence - the reading it went quiet after, the alarm, the login's expiry
 * - so the same trouble is told once, and trouble that clears and returns is
 * told again.
 *
 * - **Stopped while producing.** Nothing for 30 minutes after a reading that
 *   showed the system generating. A system that goes quiet at dusk, having
 *   produced nothing for its last reading, is asleep rather than broken.
 * - **A new fault.** A vendor alarm that began within six hours when it was
 *   first seen, saying whether it has already cleared. Older alarms are the
 *   history that arrives when a feed is first connected.
 * - **A SolisCloud login.** Two days before it runs out, and when it has.
 * - **A vendor not answering.** Three failed polls in a row, spanning at
 *   least fifteen minutes - one failure is weather, three is a token.
 */
export async function pushEvents(db: D1Database, now = nowSec()): Promise<PushEvent[]> {
  const out: PushEvent[] = [];

  // --- a feed that stopped mid-generation --------------------------------
  const { results: feeds } = await db
    .prepare(
      `SELECT i.id, i.name, i.provider, i.capacity_w, i.tz_offset_sec, r.ts, r.ac_power_w, r.source
       FROM inverters i
       JOIN readings r ON r.rowid = (SELECT rowid FROM readings
                                     WHERE inverter_id = i.id AND source NOT LIKE '%-history'
                                     ORDER BY ts DESC LIMIT 1)
       WHERE i.enabled = 1`,
    )
    .all<{ id: string; name: string; provider: string; capacity_w: number | null; tz_offset_sec: number | null;
      ts: number; ac_power_w: number | null; source: string }>();
  for (const f of feeds) {
    const watts = f.ac_power_w ?? 0;
    if (now - f.ts < QUIET_AFTER_S || watts < Math.max(50, (f.capacity_w ?? 0) * 0.02)) continue;
    const relay = f.source.endsWith('-relay')
      ? ' It is fed by a relay laptop: check that laptop is awake and its SolisCloud login is current.'
      : '';
    out.push({
      key: `quiet:${f.id}:${f.ts}`,
      title: `${f.name}: stopped reporting`,
      body: `Nothing since ${clock(f.ts, f.tz_offset_sec)}, when it was producing ${kw(watts)}.${relay}`,
    });
  }

  // --- a new vendor fault -------------------------------------------------
  const { results: alarms } = await db
    .prepare(
      `SELECT a.id, a.code, a.message, a.severity, a.advice, a.begin_ts, a.end_ts, a.state, i.name, i.tz_offset_sec
       FROM alarms a JOIN inverters i ON i.id = a.inverter_id
       WHERE a.first_seen >= ?1 AND a.begin_ts >= ?2`,
    )
    .bind(now - ALARM_FRESH_S, now - ALARM_FRESH_S)
    .all<{ id: string; code: string; message: string | null; severity: string | null; advice: string | null;
      begin_ts: number; end_ts: number | null; state: string; name: string; tz_offset_sec: number | null }>();
  for (const a of alarms) {
    const what = a.message ?? `fault ${a.code}`;
    const when = `Began ${clock(a.begin_ts, a.tz_offset_sec)}`;
    const status = a.end_ts ? `, cleared ${clock(a.end_ts, a.tz_offset_sec)}` : a.state === 'active' ? ', still active' : '';
    const advice = a.advice && a.advice.toLowerCase() !== 'no action required' ? ` ${a.advice.split('\n')[0]}` : '';
    out.push({
      key: `alarm:${a.id}`,
      title: `${a.name}: ${what}`,
      body: `${a.severity ? a.severity[0].toUpperCase() + a.severity.slice(1) + '. ' : ''}${when}${status}.${advice}`,
    });
  }

  // --- the SolisCloud relays' logins --------------------------------------
  // Named exactly as the dashboard names them: by nickname, or by order over
  // the same fortnight's list, so "Relay 2" here is "Relay 2" there.
  const { results: relayRows } = await db
    .prepare(
      `SELECT id, name, state, login_expires_at FROM relays WHERE last_seen >= ?1 ORDER BY first_seen, id`,
    )
    .bind(now - 14 * 86400)
    .all<{ id: string; name: string | null; state: string; login_expires_at: number | null }>();
  const named = publicRelays(relayRows);
  relayRows.forEach((r, i) => {
    const name = named[i].name;
    const exp = r.login_expires_at;
    if (r.state === 'login-expired' || (exp !== null && exp <= now)) {
      out.push({
        key: `relay-expired:${r.id}:${exp ?? 'unknown'}`,
        title: `SolisCloud login expired on ${name}`,
        body: `Readings from it have stopped. On that computer, double-click renew-solis-login.cmd and log in.`,
      });
    } else if (exp !== null && exp - now <= LOGIN_WARN_S) {
      const hours = Math.max(1, Math.round((exp - now) / 3600));
      out.push({
        key: `relay-expiring:${r.id}:${exp}`,
        title: `SolisCloud login on ${name} runs out in ${hours < 48 ? `${hours} h` : '2 days'}`,
        body: `Renew it before then: on that computer, double-click renew-solis-login.cmd.`,
      });
    }
  });

  // --- a vendor that has stopped answering --------------------------------
  const { results: polls } = await db
    .prepare(`SELECT ts, provider, ok, detail FROM poll_log WHERE ts >= ?1 ORDER BY ts DESC LIMIT 60`)
    .bind(now - 6 * 3600)
    .all<{ ts: number; provider: string; ok: number; detail: string | null }>();
  const byProvider = new Map<string, typeof polls>();
  for (const p of polls) {
    if (p.provider === 'none') continue;
    const list = byProvider.get(p.provider) ?? [];
    if (list.length < 3) list.push(p);
    byProvider.set(p.provider, list);
  }
  for (const [provider, last] of byProvider) {
    if (last.length < 3 || last.some((p) => p.ok)) continue;
    const first = last[last.length - 1];
    if (now - first.ts < 15 * 60) continue;
    out.push({
      key: `poll:${provider}:${first.ts}`,
      title: `${providerName(provider)} is not answering`,
      body: `The last three reads failed: ${String(last[0].detail ?? 'no detail given').slice(0, 140)}`,
    });
  }

  return out;
}

// ---------------------------------------------------------------- sending

/**
 * Store what is new, and wake every device if anything is. Returns how many
 * events were new. With `prime`, what is already wrong is recorded as told
 * without telling anyone: that is what a device turning this on wants, rather
 * than the last six hours at once.
 */
export async function announce(env: Env, now = nowSec(), prime = false): Promise<number> {
  // Nobody listening, or no key to sign with: not worth the reads.
  if (!vapidKey(env)) return 0;
  const { n } = (await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').first<{ n: number }>())!;
  if (!n) return 0;

  const events = await pushEvents(env.DB, now);
  const fresh: PushEvent[] = [];
  for (const e of events) {
    const told = await env.DB.prepare('SELECT 1 FROM kv WHERE k = ?1 AND expires_at > ?2').bind(`push:${e.key}`, now).first();
    if (told) continue;
    await env.DB
      .prepare(`INSERT INTO kv (k, v, expires_at) VALUES (?1, ?2, ?3)
                ON CONFLICT(k) DO UPDATE SET v = excluded.v, expires_at = excluded.expires_at`)
      .bind(`push:${e.key}`, String(now), now + TOLD_FOR_S)
      .run();
    fresh.push(e);
  }
  if (prime || !fresh.length) return prime ? 0 : fresh.length;

  for (const e of fresh) {
    await env.DB
      .prepare('INSERT OR IGNORE INTO push_messages (id, ts, audience, title, body) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(await audienceOf(e.key), now, '', e.title, e.body)
      .run();
  }
  await wakeAll(env, now);
  return fresh.length;
}

/** A message for one device only - the test a device asks for. */
export async function tellOne(env: Env, endpoint: string, title: string, body: string, now = nowSec()): Promise<boolean> {
  const sub = await env.DB
    .prepare('SELECT endpoint, origin, audience FROM push_subscriptions WHERE endpoint = ?1')
    .bind(endpoint)
    .first<Subscription>();
  if (!sub) return false;
  await env.DB
    .prepare('INSERT OR REPLACE INTO push_messages (id, ts, audience, title, body) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(await audienceOf(`${sub.audience}:${now}`), now, sub.audience, title, body)
    .run();
  return wake(env, sub, now);
}

async function wakeAll(env: Env, now: number): Promise<void> {
  const { results } = await env.DB
    .prepare('SELECT endpoint, origin, audience FROM push_subscriptions LIMIT ?1')
    .bind(MAX_SUBSCRIPTIONS)
    .all<Subscription>();
  for (const sub of results) await wake(env, sub, now);
}

/**
 * One empty push. A 404 or 410 means the browser has dropped the subscription
 * - uninstalled, cleared, or turned off from its own settings - and it is
 * removed here too. Anything else counts a failure; a device that has failed
 * fifty times in a row with no success between is removed as well.
 */
export async function wake(env: Env, sub: Subscription, now = nowSec()): Promise<boolean> {
  const key = vapidKey(env);
  if (!key) return false;
  let status = 0;
  try {
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: await vapidHeader(key, sub.endpoint, sub.origin, now),
        TTL: String(24 * 3600),
        Urgency: 'high',
        'Content-Length': '0',
      },
    });
    status = res.status;
  } catch {
    status = 0;
  }
  if (status === 404 || status === 410) {
    await unsubscribe(env.DB, sub.endpoint);
    return false;
  }
  if (status >= 200 && status < 300) {
    await env.DB.prepare('UPDATE push_subscriptions SET last_ok_at = ?2, failures = 0 WHERE endpoint = ?1').bind(sub.endpoint, now).run();
    return true;
  }
  await env.DB.prepare('UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = ?1').bind(sub.endpoint).run();
  await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?1 AND failures >= 50').bind(sub.endpoint).run();
  return false;
}

/** What a woken device shows: the last half hour's messages, for everyone or for it. */
export async function recentMessages(db: D1Database, audience: string, now = nowSec()) {
  const { results } = await db
    .prepare(
      `SELECT id, ts, title, body FROM push_messages
       WHERE ts >= ?1 AND (audience = '' OR audience = ?2)
       ORDER BY ts DESC LIMIT 10`,
    )
    .bind(now - RECENT_S, audience)
    .all<{ id: string; ts: number; title: string; body: string }>();
  return results;
}

/** Messages older than a week have been read or missed; either way they are done. */
export async function forgetOldMessages(db: D1Database, now = nowSec()): Promise<void> {
  await db.prepare('DELETE FROM push_messages WHERE ts < ?1').bind(now - KEEP_MESSAGES_S).run();
}
