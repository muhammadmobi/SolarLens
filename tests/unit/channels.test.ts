/**
 * The places alerts are posted to: ntfy, Telegram, Discord and any webhook.
 *
 * Held to the promises src/channels.ts makes: what the owner types is checked
 * for the shape its service gives it, and only https to a named host on the
 * internet is accepted; the secret is sealed at rest, never served, and never
 * written into a failure; each service gets the request it expects, with
 * vendor text kept as text; a channel is one more listener to announce(), told
 * each condition once and primed like a first device. Every address, token and
 * topic here is made up, and every post goes to a stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_BODY, MAX_CHANNELS, NTFY_DEFAULT, addChannel, alertMessage, deliver, getChannel, parseChannel,
  publicHttpsUrl, requestFor, resealChannels, testMessage, type ChannelConfig, type Message, type NewChannel,
} from '../../src/channels';
import { seal, unseal } from '../../src/auth/crypto';
import { createShare } from '../../src/auth/sessions';
import { insertReading, upsertInverter } from '../../src/db';
import { announce, needsPriming, subscribe, unsubscribe } from '../../src/push';
import { bearer, createHarness, testInverter, testReading, type Harness } from '../helpers/worker';

const API = 'api-token-for-tests';
const NOW = 1_790_000_000;
const ORIGIN = 'https://dashboard.test';
// Made-up credentials in each service's shape.
const TG_TOKEN = '4242:AAexampleExampleExample_example-1';
const DISCORD = 'https://discord.com/api/webhooks/4242/exampleToken-abcd';
const HOOK = 'https://hooks.example.net/api/webhook/made-up-hook-id';

/** Every POST the Worker makes, recorded and answered with `status` and `body`. */
function stubServices(status = 200, body = '{}') {
  const sent: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> | null }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    // A 204 has no body, and a Response refuses to be made with one.
    return new Response(status === 204 ? null : body, { status });
  }));
  return sent;
}

afterEach(() => { vi.unstubAllGlobals(); });

const json = (method: string, body?: unknown, auth = true): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', ...(auth ? bearer(API) : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

// ------------------------------------------------------------------ sealing

describe('a sealed secret', () => {
  it('opens with the same secret and label, and with nothing else', async () => {
    const sealed = await seal(API, 'label one', 'the webhook address');
    expect(sealed).toMatch(/^v1\.[\w-]+\.[\w-]+$/);
    expect(sealed).not.toContain('webhook');
    expect(await unseal(API, 'label one', sealed)).toBe('the webhook address');
    expect(await unseal('another-api-token', 'label one', sealed)).toBeNull();
    expect(await unseal(API, 'label two', sealed)).toBeNull();
  });

  it('never looks the same twice, and refuses one that was altered or is not one', async () => {
    const a = await seal(API, 'l', 'same text');
    const b = await seal(API, 'l', 'same text');
    expect(a).not.toBe(b);
    const [v, iv, box] = a.split('.');
    const altered = `${v}.${iv}.${box.slice(0, -2)}${box.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(await unseal(API, 'l', altered)).toBeNull();
    for (const bad of ['', 'v2.a.b', 'v1.only', 'v1.!!.??']) expect(await unseal(API, 'l', bad)).toBeNull();
  });
});

// ------------------------------------------------------------------ what the owner types

describe('an address the Worker will post to', () => {
  it('is https, to a named host', () => {
    expect(publicHttpsUrl('https://hooks.example.net/x')).toBeInstanceOf(URL);
    expect(publicHttpsUrl(' https://ntfy.example.org ')).toBeInstanceOf(URL);
  });

  it('is never plain http, a user and password, a number, or somewhere only this network reaches', () => {
    expect(publicHttpsUrl('http://hooks.example.net/x')).toMatch(/https/);
    // Put together from parts, so it does not read as an email address to the privacy check.
    expect(publicHttpsUrl(['https://user:pass', 'hooks.example.net/x'].join('@'))).toMatch(/user name/);
    for (const host of ['10.0.0.8', '192.168.1.20', '127.0.0.1', '[::1]', '[fd00::1]']) {
      expect(publicHttpsUrl(`https://${host}/hook`)).toMatch(/name, not its number/);
    }
    for (const host of ['localhost', 'nas.local', 'router.lan', 'hass.home', 'box.internal', 'intranet', 'x.in-addr.arpa']) {
      expect(publicHttpsUrl(`https://${host}/hook`)).toMatch(/internet can reach/);
    }
    expect(publicHttpsUrl('')).toMatch(/needed/);
    expect(publicHttpsUrl(42)).toMatch(/needed/);
    expect(publicHttpsUrl('not a url')).toMatch(/not a web address/);
    expect(publicHttpsUrl(`https://hooks.example.net/${'x'.repeat(500)}`)).toMatch(/too long/);
  });
});

describe('a channel, from what the Settings form sent', () => {
  it('takes alerts and the weekly summary unless told otherwise, and needs one of them', () => {
    const c = parseChannel({ kind: 'webhook', url: HOOK }) as NewChannel;
    expect([c.alerts, c.weekly]).toEqual([true, true]);
    expect((parseChannel({ kind: 'webhook', url: HOOK, alerts: false }) as NewChannel).weekly).toBe(true);
    expect(parseChannel({ kind: 'webhook', url: HOOK, alerts: false, weekly: false })).toEqual({ error: expect.stringContaining('or both') });
    expect(parseChannel({ kind: 'email' })).toEqual({ error: expect.stringContaining('Choose ntfy') });
    expect(parseChannel(null)).toEqual({ error: expect.stringContaining('Choose ntfy') });
  });

  it('tidies a name, and refuses one that is not text or is too long', () => {
    expect((parseChannel({ kind: 'webhook', url: HOOK, name: '  My\u0007   phone ' }) as NewChannel).name).toBe('My phone');
    expect((parseChannel({ kind: 'webhook', url: HOOK, name: '' }) as NewChannel).name).toBeNull();
    expect(parseChannel({ kind: 'webhook', url: HOOK, name: 7 })).toEqual({ error: 'A name is text.' });
    expect(parseChannel({ kind: 'webhook', url: HOOK, name: 'x'.repeat(41) })).toEqual({ error: expect.stringContaining('at most 40') });
  });

  it('ntfy: ntfy.sh unless another server is named, a topic in its alphabet, and an optional token', () => {
    const c = parseChannel({ kind: 'ntfy', topic: 'solar-alerts-made-up' }) as NewChannel;
    expect(c.config).toEqual({ kind: 'ntfy', server: NTFY_DEFAULT, topic: 'solar-alerts-made-up', token: null });
    const own = parseChannel({ kind: 'ntfy', server: 'https://push.example.org/ntfy/', topic: 'abc', token: 'tk_madeup123' }) as NewChannel;
    expect(own.config).toEqual({ kind: 'ntfy', server: 'https://push.example.org/ntfy', topic: 'abc', token: 'tk_madeup123' });
    expect(parseChannel({ kind: 'ntfy', topic: 'has space' })).toEqual({ error: expect.stringContaining('1 to 64') });
    expect(parseChannel({ kind: 'ntfy', topic: 'ok', token: 'not a token!' })).toEqual({ error: expect.stringContaining('access token') });
    expect(parseChannel({ kind: 'ntfy', topic: 'ok', server: 'http://push.example.org' })).toEqual({ error: expect.stringContaining('ntfy server') });
  });

  it('Telegram: a bot token as @BotFather gives it, and a chat number or @channel', () => {
    const c = parseChannel({ kind: 'telegram', token: TG_TOKEN, chat: '-4242' }) as NewChannel;
    expect(c.config).toEqual({ kind: 'telegram', token: TG_TOKEN, chat: '-4242' });
    expect((parseChannel({ kind: 'telegram', token: TG_TOKEN, chat: 4242 }) as NewChannel).config).toMatchObject({ chat: '4242' });
    expect((parseChannel({ kind: 'telegram', token: TG_TOKEN, chat: '@solar_news' }) as NewChannel).config).toMatchObject({ chat: '@solar_news' });
    expect(parseChannel({ kind: 'telegram', token: 'nope', chat: '1' })).toEqual({ error: expect.stringContaining('BotFather') });
    expect(parseChannel({ kind: 'telegram', token: TG_TOKEN, chat: 'my chat' })).toEqual({ error: expect.stringContaining('@channel') });
  });

  it("Discord: a webhook address on Discord's own hosts, and nothing else", () => {
    expect((parseChannel({ kind: 'discord', url: DISCORD }) as NewChannel).config).toEqual({ kind: 'discord', url: DISCORD });
    expect((parseChannel({ kind: 'discord', url: DISCORD.replace('discord.com', 'discordapp.com') }) as NewChannel).kind).toBe('discord');
    expect(parseChannel({ kind: 'discord', url: 'https://discord.example.net/api/webhooks/4242/abc' })).toEqual({ error: expect.stringContaining('Integrations') });
    expect(parseChannel({ kind: 'discord', url: 'https://discord.com/channels/4242/abc' })).toEqual({ error: expect.stringContaining('Integrations') });
    expect(parseChannel({ kind: 'discord', url: 'http://discord.com/api/webhooks/4242/abc' })).toEqual({ error: expect.stringContaining('https') });
  });

  it('labels each by where it posts, with the secret parts left out', () => {
    const labels = [
      parseChannel({ kind: 'ntfy', topic: 'solar-alerts-made-up' }),
      parseChannel({ kind: 'ntfy', topic: 'abc' }),
      parseChannel({ kind: 'telegram', token: TG_TOKEN, chat: '-4242' }),
      parseChannel({ kind: 'discord', url: DISCORD }),
      parseChannel({ kind: 'webhook', url: HOOK }),
    ].map((c) => (c as NewChannel).label);
    expect(labels).toEqual(['ntfy.sh · topic …up', 'ntfy.sh · topic …', 'Telegram · chat …', 'Discord webhook …abcd', 'hooks.example.net webhook']);
    for (const l of labels) {
      for (const secret of ['solar-alerts', TG_TOKEN, 'exampleToken', 'made-up-hook-id']) expect(l).not.toContain(secret);
    }
  });
});

// ------------------------------------------------------------------ the requests

describe('the request each service is sent', () => {
  const msg: Message = { kind: 'alert', title: 'South <roof>: stopped', body: 'Tell @everyone & <b>all</b>', path: '#/alerts', ts: NOW };
  const post = (config: ChannelConfig, m = msg) => {
    const { url, init } = requestFor(config, m, ORIGIN);
    return { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as Record<string, unknown> };
  };

  it('ntfy: JSON to the server root, high priority for an alert, a link to the page, and the token if there is one', () => {
    const p = post({ kind: 'ntfy', server: 'https://ntfy.sh', topic: 'abc', token: 'tk_madeup' });
    expect(p.url).toBe('https://ntfy.sh');
    expect(p.headers).toMatchObject({ 'content-type': 'application/json', Authorization: 'Bearer tk_madeup' });
    expect(p.body).toEqual({ topic: 'abc', title: msg.title, message: msg.body, priority: 4, tags: ['warning'], click: `${ORIGIN}/#/alerts` });
    const quiet = post({ kind: 'ntfy', server: 'https://ntfy.sh', topic: 'abc', token: null }, { ...msg, kind: 'summary', path: '#/history' });
    expect(quiet.headers).not.toHaveProperty('Authorization');
    expect(quiet.body).toMatchObject({ priority: 3, tags: ['sunny'], click: `${ORIGIN}/#/history` });
  });

  it("Telegram: the bot's own address, and the vendor's text escaped so it stays text", () => {
    const p = post({ kind: 'telegram', token: TG_TOKEN, chat: '-4242' });
    expect(p.url).toBe(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`);
    expect(p.body).toMatchObject({ chat_id: '-4242', parse_mode: 'HTML', disable_web_page_preview: true });
    expect(p.body.text).toBe(`<b>South &lt;roof&gt;: stopped</b>\nTell @everyone &amp; &lt;b&gt;all&lt;/b&gt;\n\n<a href="${ORIGIN}/#/alerts">Open SolarLens</a>`);
  });

  it('Discord: an embed, and nobody pinged whatever the text says', () => {
    const p = post({ kind: 'discord', url: DISCORD });
    expect(p.url).toBe(DISCORD);
    expect(p.body).toEqual({
      username: 'SolarLens', allowed_mentions: { parse: [] },
      embeds: [{ title: msg.title, description: msg.body, url: `${ORIGIN}/#/alerts`, color: 0xd64545 }],
    });
  });

  it('a webhook: plain JSON, which Home Assistant reads as trigger.json', () => {
    const p = post({ kind: 'webhook', url: HOOK });
    expect(p.url).toBe(HOOK);
    expect(p.body).toEqual({ source: 'solarlens', kind: 'alert', title: msg.title, message: msg.body, url: `${ORIGIN}/#/alerts`, ts: NOW });
  });

  it('cuts a message down to what every service takes', () => {
    const p = post({ kind: 'webhook', url: HOOK }, { ...msg, title: 't'.repeat(400), body: 'b'.repeat(MAX_BODY + 500) });
    expect(String(p.body.message)).toHaveLength(MAX_BODY);
    expect(String(p.body.message).endsWith('…')).toBe(true);
    expect(String(p.body.title)).toHaveLength(200);
  });

  it('one event is the message; several are listed in one', () => {
    const one = alertMessage([{ key: 'k1', title: 'A: stopped', body: 'Nothing since 14:05.' }], NOW);
    expect(one).toEqual({ kind: 'alert', title: 'A: stopped', body: 'Nothing since 14:05.', path: '#/alerts', ts: NOW });
    const two = alertMessage([{ key: 'k1', title: 'A: stopped', body: 'x' }, { key: 'k2', title: 'B: fault', body: 'y' }], NOW);
    expect(two.title).toBe('2 things need attention');
    expect(two.body).toBe('• A: stopped\nx\n\n• B: fault\ny');
    // The condition keys name internal ids; they are never part of a message.
    expect(JSON.stringify(two)).not.toContain('k1');
  });

  it('a test says what the channel will get', () => {
    expect(testMessage({ alerts: true, weekly: true }, NOW).body).toContain('alerts, and a summary every Monday morning');
    expect(testMessage({ alerts: 1, weekly: 0 }, NOW).body).toContain('a system that stops');
    expect(testMessage({ alerts: false, weekly: true }, NOW).body).toContain('a summary every Monday morning');
  });
});

// ------------------------------------------------------------------ sending

describe('posting', () => {
  let h: Harness;
  beforeEach(() => { h = createHarness(); });
  afterEach(() => h.close());

  const add = async (body: Record<string, unknown>) => {
    const row = await addChannel(h.env.DB, API, parseChannel(body) as NewChannel, ORIGIN, NOW);
    if (row === 'full') throw new Error('full');
    return row;
  };

  it('keeps the secret sealed in the table', async () => {
    const row = await add({ kind: 'telegram', token: TG_TOKEN, chat: '-4242' });
    expect(row.secret).not.toContain('4242');
    expect(row.secret).not.toContain('example');
    expect(JSON.parse((await unseal(API, 'solarlens channels v1', row.secret))!)).toEqual({ kind: 'telegram', token: TG_TOKEN, chat: '-4242' });
  });

  it('records a success, and forgives the failures before it', async () => {
    const row = await add({ kind: 'webhook', url: HOOK });
    await h.env.DB.prepare("UPDATE channels SET failures = 3, last_error = 'HTTP 500' WHERE id = ?1").bind(row.id).run();
    const sent = stubServices(204, '');
    expect(await deliver(h.env, row, testMessage(row, NOW), NOW)).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(await getChannel(h.env.DB, row.id)).toMatchObject({ last_ok_at: NOW, failures: 0, last_error: null });
  });

  it("records a failure in the service's own words where it gives them, never with the address or the token", async () => {
    const tg = await add({ kind: 'telegram', token: TG_TOKEN, chat: '-4242' });
    stubServices(400, JSON.stringify({ ok: false, error_code: 400, description: `Bad Request: chat not found <${TG_TOKEN}>` }));
    const r = await deliver(h.env, tg, testMessage(tg, NOW), NOW);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^HTTP 400: Bad Request: chat not found/);
    const stored = await getChannel(h.env.DB, tg.id);
    expect(stored).toMatchObject({ failures: 1, last_error_at: NOW });
    expect(stored!.last_error).not.toContain('<');
    expect(stored!.last_error).toBe('HTTP 400: Bad Request: chat not found');   // the echoed token gone, every part of it

    // Echoed as it was sent, or in a form of its own, no part of a token or an address is kept.
    stubServices(400, JSON.stringify({ description: `Bad Request: chat -4242 not found for bot${TG_TOKEN.replace(':', '%3A')}` }));
    expect((await deliver(h.env, tg, testMessage(tg, NOW), NOW)).error).toBe('HTTP 400: Bad Request: chat not found for');

    const dc = await add({ kind: 'discord', url: DISCORD });
    stubServices(401, JSON.stringify({ message: 'Invalid Webhook Token', code: 50027 }));
    expect((await deliver(h.env, dc, testMessage(dc, NOW), NOW)).error).toBe('HTTP 401: Invalid Webhook Token');
    stubServices(404, JSON.stringify({ message: `Unknown Webhook ${DISCORD}` }));
    expect((await deliver(h.env, dc, testMessage(dc, NOW), NOW)).error).toBe('HTTP 404: Unknown Webhook');

    // A webhook's answer is not read at all: it could echo anything.
    const hook = await add({ kind: 'webhook', url: HOOK });
    stubServices(500, `failed to post to ${HOOK}`);
    expect((await deliver(h.env, hook, testMessage(hook, NOW), NOW)).error).toBe('HTTP 500');
    stubServices(404, 'not json');
    expect((await deliver(h.env, hook, testMessage(hook, NOW), NOW)).error).toBe('HTTP 404, not found: check the address, the topic or the chat');
    expect((await getChannel(h.env.DB, hook.id))!.failures).toBe(2);
  });

  it('says only that it could not connect, since the error itself can carry the address', async () => {
    const row = await add({ kind: 'webhook', url: HOOK });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError(`fetch failed for ${HOOK}`); }));
    expect(await deliver(h.env, row, testMessage(row, NOW), NOW)).toEqual({ ok: false, error: 'could not connect' });
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw timeout; }));
    expect((await deliver(h.env, row, testMessage(row, NOW), NOW)).error).toBe('no answer in 10 s');
    expect(JSON.stringify(await getChannel(h.env.DB, row.id))).not.toContain('made-up-hook-id');
  });

  it('cannot post once API_TOKEN has changed, and says what to do', async () => {
    const row = await add({ kind: 'webhook', url: HOOK });
    const sent = stubServices();
    const later = { ...h.env, API_TOKEN: 'a-new-api-token' };
    expect((await deliver(later, row, testMessage(row, NOW), NOW)).error).toMatch(/the key it was sealed with has changed/);
    expect(sent).toEqual([]);
  });

  it(`keeps at most ${MAX_CHANNELS}`, async () => {
    for (let i = 0; i < MAX_CHANNELS; i++) await add({ kind: 'webhook', url: `${HOOK}-${i}` });
    expect(await addChannel(h.env.DB, API, parseChannel({ kind: 'webhook', url: HOOK }) as NewChannel, ORIGIN, NOW)).toBe('full');
  });
});

// ------------------------------------------------------------------ the routes

describe('/api/settings/channels', () => {
  let h: Harness;
  beforeEach(() => { h = createHarness(); });
  afterEach(() => h.close());

  it('lists the channels to the owner alone, with no secret in them', async () => {
    stubServices();
    await h.fetch('/api/settings/channels', json('POST', { kind: 'ntfy', topic: 'solar-alerts-made-up', token: 'tk_madeup', name: 'Phone' }));
    expect((await h.fetch('/api/settings/channels')).status).toBe(401);
    const share = await createShare(h.env.DB, 'Home Assistant', null, Math.floor(Date.now() / 1000));
    expect((await h.fetch('/api/settings/channels', { headers: bearer(share.token) })).status).toBe(401);
    const res = await h.fetch('/api/settings/channels', { headers: bearer(API) });
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { channels: Record<string, unknown>[]; max: number; ready: boolean };
    expect(body.max).toBe(MAX_CHANNELS);
    expect(body.ready).toBe(true);
    expect(body.channels).toEqual([expect.objectContaining({ kind: 'ntfy', name: 'Phone', label: 'ntfy.sh · topic …up', alerts: true, weekly: true })]);
    expect(body.channels[0]).not.toHaveProperty('secret');
    expect(JSON.stringify(body)).not.toMatch(/solar-alerts|tk_madeup/);
  });

  it('adds one, posts a test to it at once, and says how the test went', async () => {
    const sent = stubServices();
    const res = await h.fetch('/api/settings/channels', json('POST', { kind: 'ntfy', topic: 'abc', weekly: false }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channel: Record<string, unknown>; test: { ok: boolean } };
    expect(body.test).toEqual({ ok: true });
    expect(body.channel).toMatchObject({ kind: 'ntfy', alerts: true, weekly: false, last_ok_at: expect.any(Number) });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ url: 'https://ntfy.sh', body: { topic: 'abc', title: 'SolarLens is connected' } });
    expect(sent[0].body!.click).toBe('https://dashboard.test/#/');

    stubServices(403, JSON.stringify({ code: 40301, error: 'forbidden' }));
    const refused = (await (await h.fetch('/api/settings/channels', json('POST', { kind: 'ntfy', topic: 'def' }))).json()) as { test: unknown };
    expect(refused.test).toEqual({ ok: false, error: 'HTTP 403: forbidden' });
  });

  it('is the owner\'s to change: nobody else adds, changes, tests or removes one', async () => {
    stubServices();
    expect((await h.fetch('/api/settings/channels', json('POST', { kind: 'ntfy', topic: 'abc' }, false))).status).toBe(401);
    const share = await createShare(h.env.DB, 'viewer', null, Math.floor(Date.now() / 1000));
    const asViewer = { method: 'POST', headers: { 'content-type': 'application/json', ...bearer(share.token) }, body: JSON.stringify({ kind: 'ntfy', topic: 'abc' }) };
    expect((await h.fetch('/api/settings/channels', asViewer)).status).toBe(401);
    for (const [method, path] of [['PATCH', '/api/settings/channels/x'], ['DELETE', '/api/settings/channels/x'], ['POST', '/api/settings/channels/x/test'], ['POST', '/api/settings/summary']]) {
      expect((await h.fetch(path, json(method, {}, false))).status, `${method} ${path}`).toBe(401);
    }
  });

  it('says what is wrong with one it will not keep, and when there are too many', async () => {
    stubServices();
    const bad = await h.fetch('/api/settings/channels', json('POST', { kind: 'telegram', token: 'x', chat: '1' }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain('BotFather');
    for (let i = 0; i < MAX_CHANNELS; i++) await h.fetch('/api/settings/channels', json('POST', { kind: 'ntfy', topic: `t${i}` }));
    const full = await h.fetch('/api/settings/channels', json('POST', { kind: 'ntfy', topic: 'one-more' }));
    expect(full.status).toBe(409);
    expect(((await full.json()) as { error: string }).error).toContain(`At most ${MAX_CHANNELS}`);
  });

  it('needs API_TOKEN, which its secrets are sealed with', async () => {
    const open = createHarness({ API_TOKEN: undefined });
    const res = await open.fetch('/api/settings/channels', json('POST', { kind: 'ntfy', topic: 'abc' }, false));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain('API_TOKEN');
    // Nor can one be changed, removed or tested: without API_TOKEN every write is open, and these must not be.
    for (const [method, path] of [['PATCH', '/api/settings/channels/x'], ['DELETE', '/api/settings/channels/x'], ['POST', '/api/settings/channels/x/test']]) {
      expect((await open.fetch(path, json(method, { alerts: true }, false))).status, `${method} ${path}`).toBe(503);
    }
    open.close();
  });

  it('changes what one takes, but never to nothing, and removes one', async () => {
    stubServices();
    const { channel } = (await (await h.fetch('/api/settings/channels', json('POST', { kind: 'ntfy', topic: 'abc' }))).json()) as { channel: { id: string } };
    const patch = (b: unknown) => h.fetch(`/api/settings/channels/${channel.id}`, json('PATCH', b));
    expect(await (await patch({ weekly: false, name: 'Phone' })).json()).toEqual({ channel: expect.objectContaining({ alerts: true, weekly: false, name: 'Phone' }) });
    const none = await patch({ alerts: false });
    expect(none.status).toBe(400);
    expect(((await none.json()) as { error: string }).error).toContain('remove it');
    expect((await patch({ name: 9 })).status).toBe(400);
    expect((await h.fetch('/api/settings/channels/nope', json('PATCH', { alerts: true }))).status).toBe(404);

    expect((await h.fetch(`/api/settings/channels/${channel.id}`, json('DELETE'))).status).toBe(200);
    expect((await h.fetch(`/api/settings/channels/${channel.id}`, json('DELETE'))).status).toBe(404);
    expect(await h.env.DB.prepare('SELECT COUNT(*) AS n FROM channels').first()).toEqual({ n: 0 });
  });

  it('posts a test on request', async () => {
    const sent = stubServices();
    const { channel } = (await (await h.fetch('/api/settings/channels', json('POST', { kind: 'webhook', url: HOOK }))).json()) as { channel: { id: string } };
    const res = await h.fetch(`/api/settings/channels/${channel.id}/test`, json('POST'));
    expect(await res.json()).toEqual({ ok: true });
    expect(sent).toHaveLength(2);
    expect(sent[1].body).toMatchObject({ source: 'solarlens', kind: 'test' });
    expect((await h.fetch('/api/settings/channels/nope/test', json('POST'))).status).toBe(404);
  });
});

// ------------------------------------------------------------------ as a listener

describe('a channel as a listener for alerts', () => {
  let h: Harness;
  // No VAPID_KEY: channels work without Web Push.
  beforeEach(() => { h = createHarness(); });
  afterEach(() => h.close());

  // A system that went quiet forty minutes ago while producing: one thing worth telling.
  async function trouble(id = 'solarman:station:s-test', name = 'Test Plant') {
    await upsertInverter(h.env.DB, testInverter({ id, vendorId: id.split(':').pop(), plantId: id.split(':').pop(), name }) as never);
    await insertReading(h.env.DB, testReading({ inverterId: id, ts: NOW - 40 * 60, acPowerW: 2400 }) as never);
  }
  const addHook = async (over: Record<string, unknown> = {}) => {
    const row = await addChannel(h.env.DB, API, parseChannel({ kind: 'webhook', url: HOOK, ...over }) as NewChannel, ORIGIN, NOW);
    if (row === 'full') throw new Error('full');
    return row;
  };

  it('is told each condition once, with no browser signed up and no push key', async () => {
    await trouble();
    await addHook();
    const sent = stubServices();
    expect(await announce(h.env, NOW)).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatchObject({ kind: 'alert', title: 'Test Plant: stopped reporting', url: 'https://dashboard.test/#/alerts' });
    expect(JSON.stringify(sent[0].body)).not.toContain('solarman:station');
    expect(await announce(h.env, NOW + 300)).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('gets one post listing everything new in a run, and each channel gets its own', async () => {
    await trouble();
    await trouble('solarman:station:s-two', 'Second Plant');
    await addHook();
    await addHook({ url: `${HOOK}-2` });
    const sent = stubServices();
    expect(await announce(h.env, NOW)).toBe(2);
    // Added in the same second, so in no particular order.
    expect(sent.map((s) => s.url).sort()).toEqual([HOOK, `${HOOK}-2`]);
    expect(sent[0].body).toMatchObject({ title: '2 things need attention' });
  });

  it('does not listen when it takes only the weekly summary', async () => {
    await trouble();
    await addHook({ alerts: false });
    const sent = stubServices();
    expect(await announce(h.env, NOW)).toBe(0);
    expect(sent).toEqual([]);
  });

  it('does not stop the others when one fails', async () => {
    await trouble();
    await addHook({ url: 'https://down.example.net/hook' });
    await addHook();
    const sent: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      sent.push(String(input));
      return new Response('', { status: String(input).includes('down') ? 500 : 200 });
    }));
    expect(await announce(h.env, NOW)).toBe(1);
    expect(sent.sort()).toEqual(['https://down.example.net/hook', HOOK]);
  });

  it('as the first listener, starts from what is wrong now rather than telling it all', async () => {
    await trouble();
    const sent = stubServices();
    expect(await needsPriming(h.env.DB)).toBe(true);
    const res = await h.fetch('/api/settings/channels', json('POST', { kind: 'webhook', url: HOOK }));
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);                      // the test, and only the test
    expect(await needsPriming(h.env.DB)).toBe(false);
    expect(await announce(h.env, NOW)).toBe(0);
    await trouble('solarman:station:s-two', 'Second Plant');
    expect(await announce(h.env, NOW)).toBe(1);
    expect(sent[1].body).toMatchObject({ title: 'Second Plant: stopped reporting' });
  });

  it('keeps the told-state while it listens, and takes it away as the last listener to go', async () => {
    await trouble();
    stubServices();
    await subscribe(h.env.DB, 'https://fcm.googleapis.com/fcm/send/device-one', ORIGIN, NOW);
    const { channel } = (await (await h.fetch('/api/settings/channels', json('POST', { kind: 'webhook', url: HOOK }))).json()) as { channel: { id: string } };
    await announce(h.env, NOW);
    const told = async () => (await h.env.DB.prepare("SELECT COUNT(*) AS n FROM kv WHERE k LIKE 'push:%'").first<{ n: number }>())!.n;
    expect(await told()).toBeGreaterThan(0);
    // The device goes; the channel still listens, so nothing is forgotten.
    await unsubscribe(h.env.DB, 'https://fcm.googleapis.com/fcm/send/device-one');
    expect(await told()).toBeGreaterThan(0);
    // Alerts off: nobody is listening now, and the told-state goes.
    await h.fetch(`/api/settings/channels/${channel.id}`, json('PATCH', { alerts: false }));
    expect(await told()).toBe(0);
    // Back on, as the first listener again: primed, not told everything.
    await h.fetch(`/api/settings/channels/${channel.id}`, json('PATCH', { alerts: true }));
    expect(await needsPriming(h.env.DB)).toBe(false);
    expect(await announce(h.env, NOW)).toBe(0);
    await h.fetch(`/api/settings/channels/${channel.id}`, json('DELETE'));
    expect(await told()).toBe(0);
  });
});

// ------------------------------------------------------------------ SECRET_KEY

describe('a channel, once SECRET_KEY is set', () => {
  let h: Harness;
  beforeEach(() => { h = createHarness(); });
  afterEach(() => h.close());
  const KEY = 'a-secret-key-that-never-travels';

  it('is read under API_TOKEN, sealed again under SECRET_KEY, and so outlives a new API_TOKEN', async () => {
    // Added before SECRET_KEY existed: sealed under API_TOKEN.
    const row = await addChannel(h.env.DB, API, parseChannel({ kind: 'webhook', url: HOOK }) as NewChannel, ORIGIN, NOW);
    if (row === 'full') throw new Error('full');
    const sent = stubServices();
    const withKey = { ...h.env, SECRET_KEY: KEY };
    expect((await deliver(withKey, row, testMessage(row, NOW), NOW)).ok).toBe(true);
    const moved = (await getChannel(h.env.DB, row.id))!;
    expect(moved.secret).not.toBe(row.secret);
    // API_TOKEN replaced: the channel, sealed under SECRET_KEY now, still posts.
    expect((await deliver({ ...withKey, API_TOKEN: 'a-brand-new-api-token' }, moved, testMessage(moved, NOW), NOW)).ok).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it('is moved over by the hourly housekeeping, before anything is posted to it', async () => {
    const row = await addChannel(h.env.DB, API, parseChannel({ kind: 'webhook', url: HOOK, alerts: false }) as NewChannel, ORIGIN, NOW);
    if (row === 'full') throw new Error('full');
    // Nothing to move from without SECRET_KEY: nothing read, nothing changed.
    await resealChannels(h.env);
    expect((await getChannel(h.env.DB, row.id))!.secret).toBe(row.secret);
    await resealChannels({ ...h.env, SECRET_KEY: KEY });
    const moved = (await getChannel(h.env.DB, row.id))!;
    expect(moved.secret).not.toBe(row.secret);
    const sent = stubServices();
    expect((await deliver({ ...h.env, SECRET_KEY: KEY, API_TOKEN: 'a-brand-new-api-token' }, moved, testMessage(moved, NOW), NOW)).ok).toBe(true);
    expect(sent).toHaveLength(1);
  });
});
