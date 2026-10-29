/**
 * The Worker as it really runs: workerd, wrangler's migrations, the assets
 * binding, over HTTP. See ./setup.ts for how it is started.
 *
 * Each test here is about something the unit suite cannot reach, because it
 * runs the handlers in Node: the page served by the assets binding, whose
 * headers are frozen; cookies surviving the security-header rebuild; PBKDF2,
 * HMAC and ECDSA as workerd implements them; and the deploy's own smoke test,
 * run against a Worker rather than trusted.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { authenticator } from '../helpers/passkey';

const base = inject('baseUrl');
const tokens = inject('tokens');
const url = (path: string) => `${base}${path}`;
const fixture = (name: string) => JSON.parse(readFileSync(`tests/fixtures/${name}`, 'utf8'));

/** What a relay does: push a plant snapshot with its token. */
async function ingest(provider: string, plantId: string, raw: unknown, source: string) {
  const res = await fetch(url('/api/ingest/station'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens.INGEST_TOKEN}` },
    body: JSON.stringify({ provider, plantId, name: `${provider} plant`, capacityW: 5000, source, raw }),
  });
  expect(res.status).toBe(200);
}

/** A browser's cookies, carried from one request to the next. */
function jar() {
  const cookies = new Map<string, string>();
  return {
    cookies,
    header: () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
    take(res: Response) {
      for (const line of res.headers.getSetCookie()) {
        const pair = line.split(';')[0];
        const name = pair.slice(0, pair.indexOf('='));
        const value = pair.slice(pair.indexOf('=') + 1);
        if (!value || /max-age=0/i.test(line)) cookies.delete(name); else cookies.set(name, value);
      }
      return res;
    },
  };
}

beforeAll(async () => {
  await ingest('soliscloud', 'it-1', fixture('solis-station.json'), 'soliscloud-relay');
  await ingest('solarman', 'it-2', fixture('solarman-station.json'), 'solarman-web');
});

describe('the page, from the assets binding', () => {
  it('carries the whole security policy, though its own headers are frozen', async () => {
    const res = await fetch(url('/'));
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(await res.text()).toContain('<title>');
  });
});

describe('what the relays and the dashboard exchange', () => {
  it('stores a relay push and serves it back without identifiers', async () => {
    const body = await (await fetch(url('/api/latest'))).text();
    const latest = JSON.parse(body) as { inverters: { provider: string; telemetry: string | null }[] };
    expect(latest.inverters.map((i) => i.provider).sort()).toEqual(['solarman', 'soliscloud']);
    for (const i of latest.inverters) expect(JSON.parse(String(i.telemetry))).toBeTypeOf('object');
    expect(body).not.toContain('1000000000000000001');
    expect(body).not.toContain('62000000');
  });

  it('refuses a push without the relay token', async () => {
    const res = await fetch(url('/api/ingest/station'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
  });

  it('keeps /api/status to freshness only', async () => {
    const status = (await (await fetch(url('/api/status'))).json()) as { feeds: Record<string, unknown>[] };
    expect(status.feeds.length).toBeGreaterThan(0);
    for (const f of status.feeds) expect(Object.keys(f).sort()).toEqual(['ok', 'provider', 'ts']);
  });
});

describe('signing in, in workerd', () => {
  const b = jar();

  it('sets up the owner, and both cookies arrive through the header rebuild', async () => {
    const res = b.take(await fetch(url('/auth/setup'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: tokens.API_TOKEN, password: 'integration password one' }),
    }));
    expect(res.status).toBe(200);
    expect(b.cookies.has('sl_session')).toBe(true);
    expect(b.cookies.has('sl_refresh')).toBe(true);
    const status = (await (await fetch(url('/auth/status'), { headers: { cookie: b.header() } })).json()) as { role: string };
    expect(status.role).toBe('owner');
  });

  it('checks the password with workerd\'s PBKDF2', async () => {
    const other = jar();
    const wrong = await fetch(url('/auth/login'), { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.1' }, body: JSON.stringify({ password: 'not the password' }) });
    expect(wrong.status).toBe(401);
    const right = other.take(await fetch(url('/auth/login'), { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.2' }, body: JSON.stringify({ password: 'integration password one' }) }));
    expect(right.status).toBe(200);
    expect(other.cookies.has('sl_refresh')).toBe(true);
  });

  it('makes a passkey and signs in with it, verified by workerd\'s WebCrypto', async () => {
    const origin = new URL(base).origin;
    const rpId = new URL(base).hostname;
    const key = await authenticator();
    const reg = (await (await fetch(url('/auth/passkey/options'), { method: 'POST', headers: { 'content-type': 'application/json', cookie: b.header() }, body: '{"purpose":"register"}' })).json()) as { challenge: string };
    const made = await fetch(url('/auth/passkey/register'), {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: b.header() },
      body: JSON.stringify({ response: await key.register(reg.challenge, origin, rpId), name: 'Integration key' }),
    });
    expect(made.status).toBe(200);
    const { id } = (await made.json()) as { id: string };

    const login = (await (await fetch(url('/auth/passkey/options'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"purpose":"login"}' })).json()) as { challenge: string };
    const fresh = jar();
    const res = fresh.take(await fetch(url('/auth/passkey/login'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, response: await key.sign(login.challenge, origin, rpId) }),
    }));
    expect(res.status).toBe(200);
    expect(fresh.cookies.has('sl_session')).toBe(true);
  });

  it('makes the dashboard private, and a stranger is asked to sign in', async () => {
    const on = await fetch(url('/auth/settings/required'), { method: 'POST', headers: { 'content-type': 'application/json', cookie: b.header() }, body: '{"on":true}' });
    expect(on.status).toBe(200);
    const stranger = await fetch(url('/api/latest'));
    expect(stranger.status).toBe(401);
    expect(await stranger.json()).toEqual({ error: 'signin' });
    expect((await fetch(url('/api/latest'), { headers: { cookie: b.header() } })).status).toBe(200);
    expect((await fetch(url('/api/status'))).status).toBe(200);
  });

  it('lets Home Assistant read the private dashboard with a share link as a bearer token', async () => {
    const made = await fetch(url('/auth/settings/shares'), {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: b.header() },
      body: JSON.stringify({ name: 'Home Assistant', days: null }),
    });
    const link = ((await made.json()) as { url: string }).url;
    const ha = { authorization: `Bearer ${link.slice(link.lastIndexOf('/s/') + 3)}` };
    const sensors = await fetch(url('/api/sensors'), { headers: ha });
    expect(sensors.status).toBe(200);
    const body = (await sensors.json()) as { systems_count: number; systems: Record<string, unknown> };
    expect(body.systems_count).toBe(2);
    expect(Object.keys(body.systems).sort()).toEqual(['s1', 's2']);
    expect((await fetch(url('/api/sensors'))).status).toBe(401);
    expect((await fetch(url('/api/summary'), { headers: ha })).status).toBe(200);
    // Migration 0018 is applied, and the places alerts go are the owner's alone.
    expect(await (await fetch(url('/api/settings/channels'), { headers: { cookie: b.header() } })).json())
      .toEqual({ channels: [], max: 5, ready: true });
    expect((await fetch(url('/api/settings/channels'), { headers: ha })).status).toBe(401);
  });
});

describe("the deploy's own smoke test", () => {
  it('passes against a working Worker, private dashboard and all', () => {
    const run = spawnSync(process.execPath, ['scripts/ci/smoke.mjs'], {
      encoding: 'utf8', env: { ...process.env, SOLARLENS_URL: base, SOLARLENS_API_TOKEN: '' },
    });
    expect(run.stdout).toContain('the private dashboard asks a signed-out caller to sign in');
    expect(run.status, run.stdout + run.stderr).toBe(0);
  });

  it('reads the readings in full when given the owner\'s token', () => {
    const run = spawnSync(process.execPath, ['scripts/ci/smoke.mjs'], {
      encoding: 'utf8', env: { ...process.env, SOLARLENS_URL: base, SOLARLENS_API_TOKEN: tokens.API_TOKEN },
    });
    expect(run.stdout).toContain('at least one inverter is served');
    expect(run.status, run.stdout + run.stderr).toBe(0);
  });
});
