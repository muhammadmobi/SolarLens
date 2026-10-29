/**
 * OAuth for the MCP server: an app approved once by the owner, and connected
 * until the owner disconnects it.
 *
 * Held to src/oauth.ts step by step - discovery, registration, the approval
 * page, the code, the tokens and their rotation, disconnecting - and to each
 * refusal: an app nobody vouched for, an address it did not register, no PKCE,
 * the wrong verifier, a code used twice, a refresh token copied, anyone but the
 * owner's own browser approving. Apps, addresses and names are all made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { b64url, sha256 } from '../../src/auth/crypto';
import { createShare, setRequired, startDevice } from '../../src/auth/sessions';
import { ACCESS_S, CODE_S, GRACE_S, MAX_CLIENTS, STALE_CLIENT_S, redirectProblem, register } from '../../src/oauth';
import { bearer, createHarness, type Harness } from '../helpers/worker';

const API = 'api-token-for-tests';
const ORIGIN = 'https://dashboard.test';
const APP_REDIRECT = 'https://app.example.org/oauth/callback';
const VERIFIER = 'a-made-up-pkce-verifier-that-is-long-enough-0123456789';
const T0 = Date.UTC(2026, 8, 28, 9);

let h: Harness;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  h = createHarness();
});
afterEach(() => { h.close(); vi.useRealTimers(); });
const at = (s: number) => vi.setSystemTime(T0 + s * 1000);

const challenge = async (v = VERIFIER) => b64url(await sha256(v));
const json = (method: string, body: unknown, headers: Record<string, string> = {}): RequestInit =>
  ({ method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const form = (fields: Record<string, string>): RequestInit =>
  ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });

/** A browser signed in as the owner: its two cookies, as a Cookie header. */
async function ownerCookie(role: 'owner' | 'viewer' = 'owner') {
  const cookies = await startDevice(h.env.DB, API, role, 'Chrome on Windows', Math.floor(Date.now() / 1000));
  return { cookie: cookies.map((k) => `${k.name}=${k.value}`).join('; ') };
}

async function registerApp(body: Record<string, unknown> = {}) {
  const res = await h.fetch('/oauth/register', json('POST', { client_name: 'Made-up Assistant', redirect_uris: [APP_REDIRECT], ...body }));
  return { res, client: (await res.json()) as Record<string, unknown> & { client_id: string } };
}

async function authorizeParams(clientId: string, over: Record<string, string> = {}) {
  return {
    response_type: 'code', client_id: clientId, redirect_uri: APP_REDIRECT, code_challenge: await challenge(),
    code_challenge_method: 'S256', state: 'state-made-up', scope: 'solarlens:read', resource: `${ORIGIN}/mcp`, ...over,
  };
}

/** Register, approve as the owner, and swap the code: an app connected, with its tokens. */
async function connect() {
  const { client } = await registerApp();
  const params = await authorizeParams(client.client_id);
  const decided = await h.fetch('/oauth/authorize', json('POST', { ...params, allow: true }, { ...(await ownerCookie()), origin: ORIGIN }));
  const code = new URL(((await decided.json()) as { redirect: string }).redirect).searchParams.get('code')!;
  const res = await h.fetch('/oauth/token', form({ grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: client.client_id, redirect_uri: APP_REDIRECT }));
  const tokens = (await res.json()) as { access_token: string; refresh_token: string };
  return { clientId: client.client_id, code, ...tokens };
}

const mcp = (token: string | null) =>
  h.fetch('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? bearer(token) : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });

// ------------------------------------------------------------------ discovery

describe('discovery', () => {
  it('names this Worker as the one that issues tokens for /mcp, and lists its endpoints', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      expect(await (await h.fetch(path)).json()).toEqual(expect.objectContaining({
        resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN], scopes_supported: ['solarlens:read'], bearer_methods_supported: ['header'],
      }));
    }
    const as = (await (await h.fetch('/.well-known/oauth-authorization-server')).json()) as Record<string, unknown>;
    expect(as).toMatchObject({
      issuer: ORIGIN, authorization_endpoint: `${ORIGIN}/oauth/authorize`, token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`, revocation_endpoint: `${ORIGIN}/oauth/revoke`,
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
    });
    expect(await (await h.fetch('/.well-known/oauth-authorization-server/mcp')).json()).toEqual(as);
  });

  it('is open to scripts on other sites, as the machine-facing endpoints are, and the approval page is not', async () => {
    const pre = await h.fetch('/mcp', { method: 'OPTIONS', headers: { origin: 'https://client.example.net', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
    expect(pre.headers.get('access-control-allow-headers')).toMatch(/Authorization/i);
    expect((await h.fetch('/.well-known/oauth-authorization-server', { headers: { origin: 'https://client.example.net' } })).headers.get('access-control-allow-origin')).toBe('*');
    const approval = await h.fetch('/oauth/authorize', { method: 'OPTIONS', headers: { origin: 'https://client.example.net', 'access-control-request-method': 'POST' } });
    expect(approval.headers.get('access-control-allow-origin')).toBeNull();
  });
});

// ------------------------------------------------------------------ registration

describe('registering an app', () => {
  it('takes a public client, with its name tidied, and answers as RFC 7591 does', async () => {
    const { res, client } = await registerApp({ client_name: '  Made-up\u0007   Assistant  ', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(client).toMatchObject({
      client_name: 'Made-up Assistant', redirect_uris: [APP_REDIRECT], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'solarlens:read', client_id_issued_at: Math.floor(T0 / 1000),
    });
    expect(client.client_id).toMatch(/^[\w-]{20,}$/);
    expect((await registerApp({ client_name: undefined })).client.client_name).toBe('An unnamed app');
  });

  it('sends answers only to https, to this computer over http, or to a native app\'s own scheme', () => {
    expect(redirectProblem('https://app.example.org/cb')).toBeNull();
    expect(redirectProblem('http://localhost:33418/callback')).toBeNull();
    expect(redirectProblem('http://127.0.0.1:8080/cb')).toBeNull();
    expect(redirectProblem('cursor://anysphere.cursor-retrieval/oauth/callback')).toBeNull();
    expect(redirectProblem('com.example.app:/oauth')).toBeNull();
    expect(redirectProblem('http://app.example.org/cb')).toMatch(/only for this computer/);
    expect(redirectProblem('javascript:alert(1)')).toMatch(/not allowed/);
    expect(redirectProblem('data:text/html,hi')).toMatch(/not allowed/);
    expect(redirectProblem('https://app.example.org/cb#x')).toMatch(/fragment/);
    expect(redirectProblem('not an address')).toMatch(/not an address/);
    expect(redirectProblem(7)).toMatch(/is text/);
  });

  it('refuses a registration it could not honour', async () => {
    const refused = async (body: Record<string, unknown>) => {
      const { res, client } = await registerApp(body);
      expect(res.status).toBe(400);
      return client as unknown as { error: string; error_description: string };
    };
    expect((await refused({ redirect_uris: [] })).error).toBe('invalid_redirect_uri');
    expect((await refused({ redirect_uris: ['http://app.example.org/cb'] })).error).toBe('invalid_redirect_uri');
    expect((await refused({ redirect_uris: Array.from({ length: 6 }, (_, i) => `${APP_REDIRECT}/${i}`) })).error).toBe('invalid_redirect_uri');
    expect((await refused({ token_endpoint_auth_method: 'client_secret_basic' })).error_description).toMatch(/public clients/);
    expect((await refused({ grant_types: ['client_credentials'] })).error).toBe('invalid_client_metadata');
    expect((await refused({ response_types: ['token'] })).error).toBe('invalid_client_metadata');
  });

  it(`keeps at most ${MAX_CLIENTS}, and clears registrations never approved after a week`, async () => {
    const insert = h.env.DB.prepare(`INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?1, 'x', '[]', ?2)`);
    await h.env.DB.batch(Array.from({ length: MAX_CLIENTS }, (_, i) => insert.bind(`c${i}`, Math.floor(T0 / 1000))));
    expect((await registerApp()).res.status).toBe(400);
    at(8 * 86400);
    const { res } = await registerApp();
    expect(res.status).toBe(201);
    expect(await h.env.DB.prepare('SELECT COUNT(*) AS n FROM oauth_clients').first()).toEqual({ n: 1 });
  });
});

// ------------------------------------------------------------------ approval

describe('the approval page', () => {
  it('answers a link it cannot trust on the page, never sending the browser on', async () => {
    const { client } = await registerApp();
    const unknown = await h.fetch(`/oauth/authorize?${new URLSearchParams(await authorizeParams('nobody'))}`);
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toContain('names an app SolarLens does not know');
    const elsewhere = await h.fetch(`/oauth/authorize?${new URLSearchParams(await authorizeParams(client.client_id, { redirect_uri: 'https://evil.example.net/cb' }))}`);
    expect(elsewhere.status).toBe(400);
    expect(await elsewhere.text()).toContain('did not register');
  });

  it('sends anything else wrong back to the app, at its own address, as OAuth says', async () => {
    const { client } = await registerApp();
    const back = async (over: Record<string, string>) => {
      const res = await h.fetch(`/oauth/authorize?${new URLSearchParams(await authorizeParams(client.client_id, over))}`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      const to = new URL(res.headers.get('location')!);
      expect(`${to.origin}${to.pathname}`).toBe(APP_REDIRECT);
      expect(to.searchParams.get('state')).toBe(over.state ?? 'state-made-up');
      expect(to.searchParams.get('iss')).toBe(ORIGIN);
      return to.searchParams.get('error');
    };
    expect(await back({ code_challenge_method: 'plain' })).toBe('invalid_request');
    expect(await back({ code_challenge: 'short' })).toBe('invalid_request');
    expect(await back({ response_type: 'token' })).toBe('unsupported_response_type');
    expect(await back({ scope: 'solarlens:write' })).toBe('invalid_scope');
    expect(await back({ resource: 'https://other.example.net/mcp' })).toBe('invalid_target');
  });

  it('asks anyone but the owner, signed in on this browser, to sign in first - and brings them back', async () => {
    const { client } = await registerApp();
    const query = new URLSearchParams(await authorizeParams(client.client_id));
    const anonymous = await (await h.fetch(`/oauth/authorize?${query}`)).text();
    expect(anonymous).toContain('Sign in to SolarLens first');
    expect(anonymous).toContain(`href="/?next=${encodeURIComponent(`/oauth/authorize?${query}`)}#/settings"`);
    expect(await (await h.fetch(`/oauth/authorize?${query}`, { headers: await ownerCookie('viewer') })).text()).toContain('share link, which can only view');
    // The API token is not a browser: an app must be approved by a person, on the page.
    expect(await (await h.fetch(`/oauth/authorize?${query}`, { headers: bearer(API) })).text()).toContain('Sign in to SolarLens first');
  });

  it('shows the owner which app, where its answer goes, and what it may do - the app\'s name kept as text', async () => {
    const { client } = await registerApp({ client_name: '<script>alert(1)</script> Assistant' });
    const res = await h.fetch(`/oauth/authorize?${new URLSearchParams(await authorizeParams(client.client_id))}`, { headers: await ownerCookie() });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const html = await res.text();
    expect(html).toContain('Connect <strong>&lt;script&gt;alert(1)&lt;/script&gt; Assistant</strong> to SolarLens?');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('Its answer is sent to <strong>https://app.example.org</strong>');
    expect(html).toContain('It cannot change anything');
    const native = await registerApp({ redirect_uris: ['cursor://anysphere.cursor-retrieval/oauth/callback'] });
    const nativePage = await (await h.fetch(`/oauth/authorize?${new URLSearchParams(await authorizeParams(native.client.client_id, { redirect_uri: 'cursor://anysphere.cursor-retrieval/oauth/callback' }))}`, { headers: await ownerCookie() })).text();
    expect(nativePage).toContain('cursor://… (an app on this computer)');
  });

  it("takes the owner's choice only from the owner's own browser", async () => {
    const { client } = await registerApp();
    const params = await authorizeParams(client.client_id);
    expect((await h.fetch('/oauth/authorize', json('POST', { ...params, allow: true }))).status).toBe(401);
    expect((await h.fetch('/oauth/authorize', json('POST', { ...params, allow: true }, bearer(API)))).status).toBe(401);
    expect((await h.fetch('/oauth/authorize', json('POST', { ...params, allow: true }, await ownerCookie('viewer')))).status).toBe(401);
    expect((await h.fetch('/oauth/authorize', json('POST', { ...params, allow: true }, { ...(await ownerCookie()), origin: 'https://evil.example.net' }))).status).toBe(403);

    const allowed = await h.fetch('/oauth/authorize', json('POST', { ...params, allow: true }, { ...(await ownerCookie()), origin: ORIGIN }));
    const to = new URL(((await allowed.json()) as { redirect: string }).redirect);
    expect(`${to.origin}${to.pathname}`).toBe(APP_REDIRECT);
    expect(to.searchParams.get('code')).toMatch(/^[\w-]{40,}$/);
    expect(to.searchParams.get('state')).toBe('state-made-up');
    expect(to.searchParams.get('iss')).toBe(ORIGIN);

    const denied = await h.fetch('/oauth/authorize', json('POST', { ...params, allow: false }, await ownerCookie()));
    expect(new URL(((await denied.json()) as { redirect: string }).redirect).searchParams.get('error')).toBe('access_denied');
    const bad = await h.fetch('/oauth/authorize', json('POST', { ...params, client_id: 'nobody', allow: true }, await ownerCookie()));
    expect(bad.status).toBe(400);
  });
});

// ------------------------------------------------------------------ tokens

describe('tokens', () => {
  it('swaps a code and its PKCE verifier for an hour-long access token and a refresh token, never cached', async () => {
    const { client } = await registerApp();
    const params = await authorizeParams(client.client_id);
    const decided = await h.fetch('/oauth/authorize', json('POST', { ...params, allow: true }, await ownerCookie()));
    const code = new URL(((await decided.json()) as { redirect: string }).redirect).searchParams.get('code')!;
    const res = await h.fetch('/oauth/token', form({ grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: client.client_id, redirect_uri: APP_REDIRECT, resource: `${ORIGIN}/mcp` }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const t = (await res.json()) as Record<string, unknown>;
    expect(t).toMatchObject({ token_type: 'Bearer', expires_in: ACCESS_S, scope: 'solarlens:read' });
    expect(t.access_token).toMatch(/^[\w-]{40,}$/);
    expect(t.refresh_token).toMatch(/^[\w-]+\.[\w-]{40,}$/);
    expect((await mcp(t.access_token as string)).status).toBe(200);
    // Only hashes are stored.
    const stored = JSON.stringify(await h.env.DB.prepare('SELECT * FROM oauth_grants').all()) + JSON.stringify(await h.env.DB.prepare('SELECT * FROM oauth_access').all());
    expect(stored).not.toContain(t.access_token as string);
    expect(stored).not.toContain((t.refresh_token as string).split('.')[1]);
  });

  it('refuses the wrong verifier, another app, another address, a late code, and a malformed request', async () => {
    const { client } = await registerApp();
    const fresh = async () => {
      const d = await h.fetch('/oauth/authorize', json('POST', { ...(await authorizeParams(client.client_id)), allow: true }, await ownerCookie()));
      return new URL(((await d.json()) as { redirect: string }).redirect).searchParams.get('code')!;
    };
    const swap = async (fields: Record<string, string>) => {
      const res = await h.fetch('/oauth/token', form({ grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: APP_REDIRECT, code_verifier: VERIFIER, ...fields }));
      return { status: res.status, ...((await res.json()) as { error: string }) };
    };
    expect(await swap({ code: await fresh(), code_verifier: 'another-made-up-verifier-that-is-long-enough-0123456789' })).toMatchObject({ status: 400, error: 'invalid_grant' });
    expect((await swap({ code: await fresh(), client_id: 'someone-else' })).error).toBe('invalid_grant');
    expect((await swap({ code: await fresh(), redirect_uri: 'https://app.example.org/other' })).error).toBe('invalid_grant');
    expect((await swap({ code: await fresh(), resource: 'https://other.example.net/mcp' })).error).toBe('invalid_target');
    expect((await swap({ code: await fresh(), code_verifier: 'short' })).error).toBe('invalid_request');
    const late = await fresh();
    at(CODE_S + 1);
    expect((await swap({ code: late })).error).toBe('invalid_grant');
    expect((await swap({ code: '' })).error).toBe('invalid_request');
    expect(await (await h.fetch('/oauth/token', form({ grant_type: 'password' }))).json()).toMatchObject({ error: 'unsupported_grant_type' });
  });

  it('takes the fields as JSON too, as some clients send them', async () => {
    const { client } = await registerApp();
    const d = await h.fetch('/oauth/authorize', json('POST', { ...(await authorizeParams(client.client_id)), allow: true }, await ownerCookie()));
    const code = new URL(((await d.json()) as { redirect: string }).redirect).searchParams.get('code')!;
    const res = await h.fetch('/oauth/token', json('POST', { grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: client.client_id, redirect_uri: APP_REDIRECT }));
    expect(res.status).toBe(200);
    expect((await h.fetch('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' })).status).toBe(400);
  });

  it('disconnects the app when its code comes back a second time', async () => {
    const app = await connect();
    const again = await h.fetch('/oauth/token', form({ grant_type: 'authorization_code', code: app.code, code_verifier: VERIFIER, client_id: app.clientId, redirect_uri: APP_REDIRECT }));
    expect(((await again.json()) as { error: string }).error).toBe('invalid_grant');
    expect((await mcp(app.access_token)).status).toBe(401);
  });

  it('stays connected: an access token lasts an hour, and the refresh token renews it and itself', async () => {
    const app = await connect();
    at(ACCESS_S + 1);
    expect((await mcp(app.access_token)).status).toBe(401);
    const renewed = (await (await h.fetch('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: app.refresh_token, client_id: app.clientId }))).json()) as { access_token: string; refresh_token: string };
    expect(renewed.refresh_token).not.toBe(app.refresh_token);
    expect((await mcp(renewed.access_token)).status).toBe(200);
    // Months later, used now and then, still connected.
    at(ACCESS_S + 300 * 86400);
    const later = (await (await h.fetch('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: renewed.refresh_token, client_id: app.clientId }))).json()) as { access_token: string };
    expect((await mcp(later.access_token)).status).toBe(200);
  });

  it('lets a request that crossed with its own renewal through, and disconnects a copied refresh token', async () => {
    const app = await connect();
    const refresh = (t: string) => h.fetch('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: t, client_id: app.clientId }));
    const renewed = (await (await refresh(app.refresh_token)).json()) as { refresh_token: string };
    at(GRACE_S - 10);
    const crossed = (await (await refresh(app.refresh_token)).json()) as Record<string, unknown>;
    expect(crossed.access_token).toBeTruthy();
    expect(crossed).not.toHaveProperty('refresh_token');
    at(GRACE_S + 60);
    expect(((await (await refresh(app.refresh_token)).json()) as { error: string }).error).toBe('invalid_grant');
    // The copy disconnected the app, the real one included.
    expect(((await (await refresh(renewed.refresh_token)).json()) as { error: string }).error).toBe('invalid_grant');
    expect(((await (await h.fetch('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: 'nonsense' }))).json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('refuses a refresh token presented by another app', async () => {
    const app = await connect();
    const res = await h.fetch('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: app.refresh_token, client_id: 'someone-else' }));
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('lets an app disconnect itself, and answers the same whatever the token', async () => {
    const app = await connect();
    expect((await h.fetch('/oauth/revoke', form({ token: 'nothing-real' }))).status).toBe(200);
    expect((await h.fetch('/oauth/revoke', form({ token: app.access_token }))).status).toBe(200);
    expect((await mcp(app.access_token)).status).toBe(401);
    const second = await connect();
    await h.fetch('/oauth/revoke', form({ token: second.refresh_token }));
    expect((await mcp(second.access_token)).status).toBe(401);
  });
});

// ------------------------------------------------------------------ the MCP endpoint, and Settings

describe('the MCP endpoint', () => {
  it('asks for a token the way MCP clients look for one, and takes nothing else', async () => {
    const none = await mcp(null);
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
    const wrong = await mcp('made-up-token');
    expect(wrong.headers.get('www-authenticate')).toContain('error="invalid_token"');
    // Not the API token, not a share link, not the owner's cookie: an app is always an app.
    expect((await mcp(API)).status).toBe(401);
    await setRequired(h.env.DB, false, Math.floor(Date.now() / 1000));
    expect((await mcp((await createShare(h.env.DB, 'x', null, Math.floor(Date.now() / 1000))).token)).status).toBe(401);
    expect((await h.fetch('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...(await ownerCookie()) }, body: '{}' })).status).toBe(401);
  });
});

describe('connected apps, in Settings', () => {
  it('lists each app to the owner, and disconnects one at once', async () => {
    const app = await connect();
    expect((await h.fetch('/api/settings/apps')).status).toBe(401);
    const listed = (await (await h.fetch('/api/settings/apps', { headers: bearer(API) })).json()) as { apps: Record<string, unknown>[]; mcp: string };
    expect(listed.mcp).toBe(`${ORIGIN}/mcp`);
    expect(listed.apps).toEqual([expect.objectContaining({ name: 'Made-up Assistant', redirect_to: 'app.example.org', connected_at: Math.floor(T0 / 1000) })]);
    const id = listed.apps[0].id as string;
    expect((await h.fetch(`/api/settings/apps/${id}`, { method: 'DELETE' })).status).toBe(401);
    expect((await h.fetch(`/api/settings/apps/${id}`, { method: 'DELETE', headers: bearer(API) })).status).toBe(200);
    expect((await mcp(app.access_token)).status).toBe(401);
    expect((await h.fetch(`/api/settings/apps/${id}`, { method: 'DELETE', headers: bearer(API) })).status).toBe(404);
    expect(((await (await h.fetch('/api/settings/apps', { headers: bearer(API) })).json()) as { apps: unknown[] }).apps).toEqual([]);
  });
});

describe('registrations nobody approved', () => {
  it('are cleared after an hour, so a stranger who fills the list holds it that long at most', async () => {
    const reg = (n: number) => register(h.env.DB, { client_name: `App ${n}`, redirect_uris: [APP_REDIRECT] });
    for (let i = 0; i < MAX_CLIENTS; i++) expect('client' in (await reg(i))).toBe(true);
    expect(await reg(MAX_CLIENTS)).toMatchObject({ error: 'invalid_client_metadata' });
    at(STALE_CLIENT_S + 1);
    expect('client' in (await reg(MAX_CLIENTS + 1))).toBe(true);
    expect(h.d1.raw.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get()).toEqual({ n: 1 });
  });
});
