/**
 * Who may change what: every route that writes, and who it answers.
 *
 * The routes are read from the source (app.* in src/index.ts, auth.* under
 * /auth in src/auth/routes.ts), so a new one cannot be added without being
 * placed here: owner only, a signed-in browser only, an approved app only, the
 * relays' ingest token only, or open on purpose - with the reason. Each is
 * then asked by everyone who can reach it with a token: nobody, a share
 * link's viewer, a relay with the ingest token, and the owner's API_TOKEN.
 * Whoever it is not for must be refused; whoever it is for must not be.
 *
 * The owner-only reads are here too: most reads are open while the dashboard
 * is (and all need a sign-in once it is private), but these hold what only the
 * owner may see - where the plants are, the channels' addresses, the apps.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createShare } from '../../src/auth/sessions';
import { bearer, createHarness, type Harness } from '../helpers/worker';

/** Every write route in the Worker, as "METHOD /path", sorted. */
function writeRoutes(): string[] {
  const found: string[] = [];
  const scan = (file: string, router: string, prefix: string) => {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(new RegExp(`^${router}\\.(post|put|patch|delete|all)\\('([^']+)'`, 'gm'))) {
      // app.all('*') is the static page, which writes nothing.
      if (m[2] !== '*') found.push(`${m[1].toUpperCase()} ${prefix}${m[2]}`);
    }
  };
  scan('src/index.ts', 'app', '');
  scan('src/auth/routes.ts', 'auth', '/auth');
  return found.sort();
}

/** The owner's alone: the API_TOKEN as a header, or a browser signed in as the owner. */
const OWNER = [
  'POST /api/push/subscribe',
  'POST /api/push/test',
  'PUT /api/settings/tariff',
  'DELETE /api/settings/tariff',
  'PUT /api/settings/groups',
  'DELETE /api/settings/apps/:id',
  'POST /api/settings/channels',
  'PATCH /api/settings/channels/:id',
  'DELETE /api/settings/channels/:id',
  'POST /api/settings/channels/:id/test',
  'POST /api/settings/summary',
  'POST /api/poll',
  'POST /auth/passkey/register',
  'POST /auth/settings/required',
  'POST /auth/settings/password',
  'POST /auth/settings/passkeys/remove',
  'POST /auth/settings/devices/revoke',
  'POST /auth/settings/shares',
  'POST /auth/settings/shares/revoke',
];

/**
 * The owner, signed in on the browser that asks - not the API_TOKEN as a
 * header, which a script anywhere could hold (tests/unit/oauth.test.ts has the
 * approval itself).
 */
const BROWSER_OWNER = ['POST /oauth/authorize'];

/** An approved app's own token, and nothing else: an app is always an app (tests/unit/mcp.test.ts). */
const APP = ['ALL /mcp'];

/** The relays and the self-hosted loggers: the INGEST_TOKEN, a different key for a different job. */
const INGEST = [
  'POST /api/ingest',
  'POST /api/ingest/alarms',
  'POST /api/ingest/devices',
  'POST /api/ingest/history',
  'POST /api/ingest/periods',
  'POST /api/ingest/relay',
  'POST /api/ingest/station',
];

/** Open to anyone, on purpose - each keeps its own guard, named here and tested where it lives. */
const OPEN: Record<string, string> = {
  'POST /api/push/unsubscribe': "turns notifications off for the one device whose push address it names, which only that device knows",
  'POST /api/ask': 'a question about the readings, open while the dashboard is; a caller not signed in is held to a year at a time (src/tools.ts ANONYMOUS_DAYS)',
  'POST /api/chat': 'the same, as a conversation',
  'POST /oauth/register': 'an app introducing itself, as OAuth has it: it grants nothing until the owner approves',
  'POST /oauth/token': 'trades a code the owner approved, with its PKCE verifier, or a refresh token, for tokens',
  'POST /oauth/revoke': 'an app giving back the token it holds: it can only take back what it is given',
  'POST /auth/setup': 'the first way in, and the way back in: it needs the setup code (the API_TOKEN), behind the lock after wrong tries',
  'POST /auth/login': 'the password, behind the same lock',
  'POST /auth/logout': 'signs out the browser that asks, and nobody else',
  'POST /auth/passkey/options': 'a signed challenge, worth nothing without a passkey to answer it',
  'POST /auth/passkey/login': "a passkey's signature over that challenge, which is spent once it works",
};

/** Reads that are the owner's alone, however open the dashboard is. */
const OWNER_READS = ['/api/locations', '/api/settings/apps', '/api/settings/channels', '/auth/settings'];

const [METHOD, PATH] = [0, 1];
const parts = (route: string) => {
  const [method, path] = route.split(' ');
  // A route's :id asks after something that is not there: who is refused is decided before that is looked up.
  return [method === 'ALL' ? 'POST' : method, path.replace(/:\w+/g, 'nothing-here')] as const;
};

describe('who may change what', () => {
  let h: Harness;
  let viewer: string;
  beforeEach(async () => {
    h = createHarness();
    viewer = (await createShare(h.env.DB, 'Family', null, Math.floor(Date.now() / 1000))).token;
    // Nothing leaves the test: a poll the owner asks for finds every vendor unreachable.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    h.close();
  });

  /**
   * The status each caller is answered with: nobody, a viewer, a relay, the
   * owner's token. Refused for who they are is 401 (or 403); anything else -
   * a 400 for a body of {}, a 404 for nothing-here, a 503 for notifications
   * this server has not set up - is past the guard, answered for what was
   * asked. (With no API_TOKEN every write is a 503, whoever asks: that is in
   * tests/unit/worker-edges.test.ts.)
   */
  async function answers(route: string) {
    const [method, path] = parts(route);
    const ask = (headers: Record<string, string>) => h.fetch(path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: method === 'GET' ? undefined : '{}',
    }).then((r) => r.status);
    return {
      nobody: await ask({}),
      viewer: await ask(bearer(viewer)),
      relay: await ask(bearer(h.env.INGEST_TOKEN!)),
      owner: await ask(bearer(h.env.API_TOKEN!)),
    };
  }

  it('has placed every write route: a new one must be decided on here', () => {
    const placed = [...OWNER, ...BROWSER_OWNER, ...APP, ...INGEST, ...Object.keys(OPEN)].sort();
    expect(writeRoutes()).toEqual(placed);
    // Each is placed once.
    expect(new Set(placed).size).toBe(placed.length);
  });

  it.each(OWNER)('%s: the owner, and nobody else', async (route) => {
    const got = await answers(route);
    expect({ nobody: got.nobody, viewer: got.viewer, relay: got.relay }).toEqual({ nobody: 401, viewer: 401, relay: 401 });
    expect([401, 403]).not.toContain(got.owner);
  });

  it.each(BROWSER_OWNER)("%s: the owner's own browser - not even the owner's token", async (route) => {
    expect(await answers(route)).toEqual({ nobody: 401, viewer: 401, relay: 401, owner: 401 });
  });

  it.each(APP)("%s: an approved app's token, and no one else's", async (route) => {
    expect(await answers(route)).toEqual({ nobody: 401, viewer: 401, relay: 401, owner: 401 });
  });

  it.each(INGEST)('%s: the ingest token - not even the owner\'s', async (route) => {
    const got = await answers(route);
    expect({ nobody: got.nobody, viewer: got.viewer, owner: got.owner }).toEqual({ nobody: 401, viewer: 401, owner: 401 });
    expect([401, 403]).not.toContain(got.relay);
  });

  it.each(OWNER_READS)('%s: read by the owner alone', async (path) => {
    expect(await answers(`GET ${path}`)).toEqual({ nobody: 401, viewer: 401, relay: 401, owner: 200 });
  });

  it('keeps every open route open for a reason', () => {
    for (const [route, why] of Object.entries(OPEN)) {
      expect(route.split(' ')[METHOD]).toMatch(/^(POST|PUT|PATCH|DELETE|ALL)$/);
      expect(route.split(' ')[PATH]).toMatch(/^\//);
      expect(why.length).toBeGreaterThan(20);
    }
  });
});
