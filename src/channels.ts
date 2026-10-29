/**
 * Alerts and the weekly summary, posted somewhere other than a browser: ntfy,
 * Telegram, Discord, or any webhook - Home Assistant's, for one.
 *
 * Web Push (./push) reaches a phone that has the dashboard installed. These
 * reach wherever the owner already looks: a chat, a notification app, a home
 * automation. Each is a "channel", one row in the channels table (migration
 * 0018), holding what posting there needs. No email: it needs a sending
 * service, and every one of these does the job without one.
 *
 * The rules:
 *
 * - **The same alerts as a phone, told once.** What is worth saying is decided
 *   in one place (./push pushEvents); a channel taking alerts is simply one
 *   more listener to announce(), which tells each condition once.
 * - **One message a run.** However many things went wrong at once, each
 *   channel gets one post listing them, not one post each: a Worker has a
 *   budget of outbound requests per run, and a chat does not want ten pings.
 * - **The secret stays secret.** A bot token, a webhook address, a topic on a
 *   public ntfy server: each lets anyone who has it post as the owner. It is
 *   sealed before it is stored (../auth/crypto seal, a key derived from the
 *   key secret: SECRET_KEY, or API_TOKEN without one) and never sent back. The page is shown a label with the secret
 *   parts left out, and a failure is recorded as a status and a few words,
 *   never the address.
 * - **Only https, only the internet.** The Worker posts to an address the owner
 *   typed, so it is held to what a webhook can be: https, a named host, no
 *   user or password in it, nothing that names this network or a private one.
 * - **Vendor text is text.** A fault message or a plant name reaches a chat as
 *   written, never as markup: Discord is told to ping nobody, Telegram's HTML
 *   is escaped, and ntfy is sent plain text.
 */
import { keySecret, previousKeySecret, randomToken, seal, unseal } from './auth/crypto';
import { nowSec, type Env } from './db';
import type { PushEvent } from './push';

export type ChannelKind = 'ntfy' | 'telegram' | 'discord' | 'webhook';
export const CHANNEL_KINDS: readonly ChannelKind[] = ['ntfy', 'telegram', 'discord', 'webhook'];

/** The most places the owner can be told at once: each is an outbound request per message. */
export const MAX_CHANNELS = 5;
/** Longest name a channel may be given. */
export const CHANNEL_NAME_MAX = 40;
/** The label the sealing key is derived for; a new label would be a new key. */
const SEAL_LABEL = 'solarlens channels v1';
/** How long a post may take before it counts as failed. */
const POST_TIMEOUT_MS = 10_000;
/** Longest message body sent: inside Discord's 4096, Telegram's 4096 and ntfy's 4096 bytes. */
export const MAX_BODY = 3000;
/** Longest title: inside Discord's 256. */
const MAX_TITLE = 200;
/** ntfy.sh, the public server most people use; the owner can name their own. */
export const NTFY_DEFAULT = 'https://ntfy.sh';
/** Discord's hosts for a webhook, the old one and the test builds included. */
const DISCORD_HOSTS = ['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com'];

/** What posting to a channel needs. Sealed at rest; never served. */
export type ChannelConfig =
  | { kind: 'ntfy'; server: string; topic: string; token: string | null }
  | { kind: 'telegram'; token: string; chat: string }
  | { kind: 'discord'; url: string }
  | { kind: 'webhook'; url: string };

/** A channel as the table holds it. */
export interface ChannelRow {
  id: string;
  kind: ChannelKind;
  name: string | null;
  label: string;
  secret: string;
  origin: string;
  alerts: number;
  weekly: number;
  created_at: number;
  last_ok_at: number | null;
  last_error: string | null;
  last_error_at: number | null;
  failures: number;
}

/** A channel as the Settings page is shown it: everything but the secret. */
export interface PublicChannel {
  id: string;
  kind: ChannelKind;
  name: string | null;
  label: string;
  alerts: boolean;
  weekly: boolean;
  created_at: number;
  last_ok_at: number | null;
  last_error: string | null;
  last_error_at: number | null;
  failures: number;
}

/** One message, whatever it is posted to. */
export interface Message {
  kind: 'alert' | 'summary' | 'test';
  title: string;
  body: string;
  /** The page of the dashboard it is about, as a hash: '#/alerts'. */
  path: string;
  ts: number;
}

export const publicChannel = (r: ChannelRow): PublicChannel => ({
  id: r.id, kind: r.kind, name: r.name, label: r.label, alerts: !!r.alerts, weekly: !!r.weekly,
  created_at: r.created_at, last_ok_at: r.last_ok_at, last_error: r.last_error, last_error_at: r.last_error_at, failures: r.failures,
});

// ---------------------------------------------------------------- checking what the owner typed

/** A dotted IPv4 address, or anything in brackets: a host given by number rather than by name. */
const IP_LITERAL = /^(\d{1,3}\.){3}\d{1,3}$|^\[.*\]$/;

/**
 * An address the Worker may post to: https, a named host on the internet, no
 * user or password in it. Returns the URL, or why it is not one.
 *
 * A host given by number is refused outright rather than sorted into public
 * and private ranges: nobody's webhook is a bare address with a valid
 * certificate, and "by name only" leaves nothing to get wrong.
 */
export function publicHttpsUrl(value: unknown): URL | string {
  if (typeof value !== 'string' || !value.trim()) return 'An address is needed.';
  if (value.length > 500) return 'That address is too long.';
  let url: URL;
  try { url = new URL(value.trim()); } catch { return 'That is not a web address.'; }
  if (url.protocol !== 'https:') return 'The address must start with https://.';
  if (url.username || url.password) return 'Leave any user name and password out of the address.';
  const host = url.hostname.toLowerCase();
  if (IP_LITERAL.test(host)) return 'Give the address by its name, not its number.';
  if (!host.includes('.') || /(^|\.)(localhost|local|internal|lan|home|arpa)$/.test(host)) {
    return 'The address must be one the internet can reach.';
  }
  return url;
}

/** A name for a channel: tidied, at most CHANNEL_NAME_MAX characters, or null. */
function channelName(v: unknown): string | null | { error: string } {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') return { error: 'A name is text.' };
  const name = v.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (name.length > CHANNEL_NAME_MAX) return { error: `A name is at most ${CHANNEL_NAME_MAX} characters.` };
  return name || null;
}

/** The last few characters of a secret, enough to tell two apart, and only when it is long enough to spare them. */
const tail = (s: string, n = 4) => (s.length >= 3 * n ? `…${s.slice(-n)}` : '…');

export interface NewChannel {
  kind: ChannelKind;
  name: string | null;
  alerts: boolean;
  weekly: boolean;
  config: ChannelConfig;
  /** Where it posts, with the secret parts left out: what the page shows. */
  label: string;
}

/**
 * A channel from what the Settings form sent, or the reason it is not one.
 * Every field is checked for the shape its service gives it, so a mistake is
 * caught here rather than as a failed post at three in the morning.
 */
export function parseChannel(body: unknown): NewChannel | { error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const kind = b.kind as ChannelKind;
  if (!CHANNEL_KINDS.includes(kind)) return { error: 'Choose ntfy, Telegram, Discord or a webhook.' };
  const name = channelName(b.name);
  if (name && typeof name === 'object') return name;
  const alerts = b.alerts !== false;
  const weekly = b.weekly !== false;
  if (!alerts && !weekly) return { error: 'Tick alerts, the weekly summary, or both.' };
  const base = { kind, name: name as string | null, alerts, weekly };

  if (kind === 'ntfy') {
    const server = publicHttpsUrl(b.server == null || b.server === '' ? NTFY_DEFAULT : b.server);
    if (typeof server === 'string') return { error: `The ntfy server: ${server}` };
    const topic = typeof b.topic === 'string' ? b.topic.trim() : '';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(topic)) return { error: 'An ntfy topic is 1 to 64 letters, digits, - or _.' };
    const token = typeof b.token === 'string' && b.token.trim() ? b.token.trim() : null;
    if (token !== null && !/^[A-Za-z0-9_.-]{1,200}$/.test(token)) return { error: 'That does not look like an ntfy access token.' };
    // Published as JSON to the server's own root (or the path it is served under).
    const root = `${server.origin}${server.pathname.replace(/\/+$/, '')}`;
    return { ...base, config: { kind, server: root, topic, token }, label: `${server.host} · topic ${tail(topic, 2)}` };
  }

  if (kind === 'telegram') {
    const token = typeof b.token === 'string' ? b.token.trim() : '';
    if (!/^\d{1,15}:[A-Za-z0-9_-]{20,60}$/.test(token)) return { error: 'A Telegram bot token looks like 123456:ABC-def… - copy it whole from @BotFather.' };
    const chat = typeof b.chat === 'string' ? b.chat.trim() : typeof b.chat === 'number' ? String(b.chat) : '';
    if (!/^-?\d{1,20}$/.test(chat) && !/^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(chat)) return { error: 'A Telegram chat is a number (a group\'s starts with -) or a @channel name.' };
    return { ...base, config: { kind, token, chat }, label: `Telegram · chat ${tail(chat, 2)}` };
  }

  const url = publicHttpsUrl(b.url);
  if (typeof url === 'string') return { error: url };
  if (kind === 'discord') {
    if (!DISCORD_HOSTS.includes(url.hostname) || !/^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) {
      return { error: 'A Discord webhook address looks like https://discord.com/api/webhooks/… - copy it from the channel\'s Integrations.' };
    }
    return { ...base, config: { kind, url: url.href }, label: `Discord webhook ${tail(url.pathname.replace(/\/+$/, ''), 4)}` };
  }
  // Any other webhook: the host is shown, the path - where the secret usually is - is not.
  return { ...base, config: { kind: 'webhook', url: url.href }, label: `${url.host} webhook` };
}

// ---------------------------------------------------------------- the table

const SELECT_CHANNELS = 'SELECT * FROM channels';

export async function listChannels(db: D1Database): Promise<ChannelRow[]> {
  const { results } = await db.prepare(`${SELECT_CHANNELS} ORDER BY created_at, id`).all<ChannelRow>();
  return results;
}

export async function getChannel(db: D1Database, id: string): Promise<ChannelRow | null> {
  return db.prepare(`${SELECT_CHANNELS} WHERE id = ?1`).bind(id).first<ChannelRow>();
}

/** The channels that take alerts, or the weekly summary. */
export async function channelsFor(db: D1Database, what: 'alerts' | 'weekly'): Promise<ChannelRow[]> {
  const { results } = await db.prepare(`${SELECT_CHANNELS} WHERE ${what === 'alerts' ? 'alerts' : 'weekly'} = 1 ORDER BY created_at, id`).all<ChannelRow>();
  return results;
}

/** How many channels take alerts: each is a listener to announce(). */
export async function alertChannelCount(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM channels WHERE alerts = 1').first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Keep a new channel, its config sealed under `keys`, the key secret
 * (../auth/crypto keySecret). The limit is decided by the insert itself, in
 * one statement, so two channels added at the same moment cannot both slip
 * under it. `origin` is the dashboard's own address, from the request that
 * added it, for the link each message carries.
 */
export async function addChannel(db: D1Database, keys: string, c: NewChannel, origin: string, now = nowSec()): Promise<ChannelRow | 'full'> {
  const id = randomToken(9);
  const secret = await seal(keys, SEAL_LABEL, JSON.stringify(c.config));
  const res = await db
    .prepare(
      `INSERT INTO channels (id, kind, name, label, secret, origin, alerts, weekly, created_at, failures)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0 WHERE (SELECT COUNT(*) FROM channels) < ?10`,
    )
    .bind(id, c.kind, c.name, c.label, secret, origin, c.alerts ? 1 : 0, c.weekly ? 1 : 0, now, MAX_CHANNELS)
    .run();
  if (!res.meta.changes) return 'full';
  return (await getChannel(db, id))!;
}

/**
 * Change what a channel takes, or its name. Refused, as null, when that would
 * leave it taking nothing - remove it instead - or when there is no such channel.
 */
export async function updateChannel(
  db: D1Database, id: string, change: { alerts?: unknown; weekly?: unknown; name?: unknown },
): Promise<ChannelRow | { error: string } | null> {
  const row = await getChannel(db, id);
  if (!row) return null;
  const alerts = typeof change.alerts === 'boolean' ? change.alerts : !!row.alerts;
  const weekly = typeof change.weekly === 'boolean' ? change.weekly : !!row.weekly;
  if (!alerts && !weekly) return { error: 'A channel takes alerts, the weekly summary, or both. To stop it altogether, remove it.' };
  const name = change.name === undefined ? row.name : channelName(change.name);
  if (name && typeof name === 'object') return name;
  await db.prepare('UPDATE channels SET alerts = ?2, weekly = ?3, name = ?4 WHERE id = ?1')
    .bind(id, alerts ? 1 : 0, weekly ? 1 : 0, name as string | null).run();
  return (await getChannel(db, id))!;
}

export async function removeChannel(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare('DELETE FROM channels WHERE id = ?1').bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}

// ---------------------------------------------------------------- the messages

/** The one post announce() makes to each channel: the event itself, or a list of them. */
export function alertMessage(events: PushEvent[], now = nowSec()): Message {
  if (events.length === 1) return { kind: 'alert', title: events[0].title, body: events[0].body, path: '#/alerts', ts: now };
  return {
    kind: 'alert',
    title: `${events.length} things need attention`,
    body: events.map((e) => `• ${e.title}\n${e.body}`).join('\n\n'),
    path: '#/alerts',
    ts: now,
  };
}

/** What a new channel is sent, so its owner sees the whole path work. */
export function testMessage(c: { alerts: boolean | number; weekly: boolean | number }, now = nowSec()): Message {
  const what = c.alerts && c.weekly ? 'alerts, and a summary every Monday morning'
    : c.alerts ? 'alerts: a system that stops, a fault, a login running out' : 'a summary every Monday morning';
  return { kind: 'test', title: 'SolarLens is connected', body: `This is where SolarLens will post ${what}.`, path: '#/', ts: now };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Telegram's HTML wants these three escaped in text, and the double quote too inside an attribute - the link's href. */
const html = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const NTFY_TAGS: Record<Message['kind'], string> = { alert: 'warning', summary: 'sunny', test: 'white_check_mark' };
const DISCORD_COLOURS: Record<Message['kind'], number> = { alert: 0xd64545, summary: 0xf0a030, test: 0x3c9d5d };

/**
 * The request that posts a message to a channel: pure, so each service's
 * shape can be checked without a network. The link in each is the dashboard's
 * own page for the message - Alerts for an alert, Historical Data for the
 * summary.
 */
export function requestFor(config: ChannelConfig, msg: Message, origin: string): { url: string; init: RequestInit } {
  const link = `${origin}/${msg.path}`;
  const title = clip(msg.title, MAX_TITLE);
  const body = clip(msg.body, MAX_BODY);
  const json = (payload: unknown, extra: Record<string, string> = {}) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extra },
    body: JSON.stringify(payload),
  });
  switch (config.kind) {
    case 'ntfy':
      // JSON to the server's root rather than a header per field: a header
      // cannot carry the accents and symbols a plant name may have.
      return {
        url: config.server,
        init: json({ topic: config.topic, title, message: body, priority: msg.kind === 'alert' ? 4 : 3, tags: [NTFY_TAGS[msg.kind]], click: link },
          config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      };
    case 'telegram':
      return {
        url: `https://api.telegram.org/bot${config.token}/sendMessage`,
        init: json({
          chat_id: config.chat, parse_mode: 'HTML', disable_web_page_preview: true,
          text: `<b>${html(title)}</b>\n${html(body)}\n\n<a href="${html(link)}">Open SolarLens</a>`,
        }),
      };
    case 'discord':
      return {
        url: config.url,
        init: json({ username: 'SolarLens', allowed_mentions: { parse: [] }, embeds: [{ title, description: body, url: link, color: DISCORD_COLOURS[msg.kind] }] }),
      };
    case 'webhook':
      // Plain JSON for anyone's automation: Home Assistant reads it as trigger.json.
      return { url: config.url, init: json({ source: 'solarlens', kind: msg.kind, title, message: body, url: link, ts: msg.ts }) };
  }
}

/** A few words for a refusal, from the status alone. */
const HINTS: Record<number, string> = {
  400: 'the service refused the message: check the chat or topic',
  401: 'refused: check the token',
  403: 'refused: check the token',
  404: 'not found: check the address, the topic or the chat',
  413: 'the message was too long',
  429: 'too many messages: the service asked to slow down',
};

/**
 * What a service said about a refusal, where it says it in a known place -
 * Telegram's `description`, Discord's `message`, ntfy's `error` - cut to a few
 * plain words. A generic webhook's answer is not read at all: it could echo
 * anything.
 *
 * The others could echo what they were sent, and the words are kept on the
 * channel's row and shown in Settings. So before anything is cut, out comes
 * every value of the channel's config - the token, the chat, the topic, the
 * address - and any long unbroken run, which no service's words are and a key
 * echoed in some form of its own would be.
 */
async function refusal(config: ChannelConfig, res: Response): Promise<string> {
  if (config.kind === 'webhook') { await res.body?.cancel(); return ''; }
  const text = (await res.text().catch(() => '')).slice(0, 2000);
  let said: unknown;
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    said = config.kind === 'telegram' ? j.description : config.kind === 'discord' ? j.message : j.error;
  } catch { return ''; }
  if (typeof said !== 'string') return '';
  let words = said;
  for (const [k, v] of Object.entries(config)) {
    // A value of a character or three names nothing, and taking it out would break the words apart.
    if (k !== 'kind' && typeof v === 'string' && v.length >= 4) words = words.split(v).join(' ');
  }
  return words.replace(/\S{24,}/g, ' ').replace(/[^\w .,:'()-]/g, '').replace(/ {2,}/g, ' ').slice(0, 80).trim();
}

/**
 * A channel's config, unsealed, or null when it can no longer be read. One
 * sealed under API_TOKEN before SECRET_KEY was set is read with that, and
 * sealed again under the key secret on the spot - so each channel moves over
 * the first time it is read, and a later change of API_TOKEN cannot strand it.
 */
async function configOf(env: Env, row: ChannelRow): Promise<ChannelConfig | null> {
  const keys = keySecret(env);
  if (!keys) return null;
  let text = await unseal(keys, SEAL_LABEL, row.secret);
  const before = previousKeySecret(env);
  if (!text && before) {
    text = await unseal(before, SEAL_LABEL, row.secret);
    if (text) await env.DB.prepare('UPDATE channels SET secret = ?2 WHERE id = ?1').bind(row.id, await seal(keys, SEAL_LABEL, text)).run();
  }
  if (!text) return null;
  try { return JSON.parse(text) as ChannelConfig; } catch { return null; }
}

/**
 * Move every channel still sealed under API_TOKEN over to SECRET_KEY, run
 * hourly: a channel that takes only the weekly summary is read once a week,
 * and should not wait that long to stop depending on API_TOKEN. Nothing to do,
 * and no read at all, until SECRET_KEY is set.
 */
export async function resealChannels(env: Env): Promise<void> {
  if (!previousKeySecret(env)) return;
  for (const row of await listChannels(env.DB)) await configOf(env, row);
}

/**
 * Post one message to one channel, and record how it went on the channel's
 * row: when it last worked, or the last failure and how many in a row. The
 * failure is a status and a few words, never the address or the token.
 */
export async function deliver(env: Env, row: ChannelRow, msg: Message, now = nowSec()): Promise<{ ok: boolean; error?: string }> {
  const config = await configOf(env, row);
  let why: string;
  if (!config) {
    why = 'cannot be read: the key it was sealed with has changed since it was added (SECRET_KEY, or API_TOKEN without one) - remove it and add it again';
  } else {
    const { url, init } = requestFor(config, msg, row.origin);
    let status = 0;
    let failure = '';
    let said = '';
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(POST_TIMEOUT_MS) });
      status = res.status;
      if (res.ok) await res.body?.cancel();
      else said = await refusal(config, res);
    } catch (e) {
      // The error's own message can carry the address, so only its kind is kept.
      failure = e instanceof Error && e.name === 'TimeoutError' ? 'no answer in 10 s' : 'could not connect';
    }
    if (status >= 200 && status < 300) {
      await env.DB.prepare('UPDATE channels SET last_ok_at = ?2, failures = 0, last_error = NULL, last_error_at = NULL WHERE id = ?1')
        .bind(row.id, now).run();
      return { ok: true };
    }
    why = status ? `HTTP ${status}${said ? `: ${said}` : HINTS[status] ? `, ${HINTS[status]}` : ''}` : failure;
    console.warn(JSON.stringify({ channel: 'failed', kind: row.kind, status }));
  }
  await env.DB.prepare('UPDATE channels SET last_error = ?2, last_error_at = ?3, failures = failures + 1 WHERE id = ?1')
    .bind(row.id, why, now).run();
  return { ok: false, error: why };
}

/**
 * Post what is new to every channel taking alerts: one message a channel,
 * however many events. Returns how many channels it reached.
 */
export async function sendAlerts(env: Env, events: PushEvent[], now = nowSec()): Promise<number> {
  if (!events.length) return 0;
  const rows = await channelsFor(env.DB, 'alerts');
  const msg = alertMessage(events, now);
  let reached = 0;
  for (const row of rows) if ((await deliver(env, row, msg, now)).ok) reached++;
  return reached;
}
