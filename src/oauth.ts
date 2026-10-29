/**
 * OAuth for the MCP server: how an AI app outside SolarLens is approved once by
 * the owner, and stays connected.
 *
 * The MCP authorization spec makes an MCP server an OAuth 2.1 resource server;
 * here the same Worker is also the authorization server, and the owner's own
 * sign-in (./auth) is what approves an app. In the order an app meets them:
 *
 * - **Discovery.** /mcp answers a request without a token with 401 and a
 *   pointer to /.well-known/oauth-protected-resource (RFC 9728), which names
 *   this Worker as the authorization server; its endpoints are at
 *   /.well-known/oauth-authorization-server (RFC 8414).
 * - **Registration.** The app registers itself at /oauth/register (RFC 7591).
 *   Public clients only: an app proves it is itself with PKCE, never a secret -
 *   a desktop app cannot keep one. Its name is whatever it says, so the
 *   approval page shows where the answer will actually be sent.
 * - **Approval.** /oauth/authorize is a page for the owner, signed in on this
 *   browser: which app, where its answer goes, what it may do - read, nothing
 *   else - with Allow and Deny. Anyone else is asked to sign in, and a share
 *   link cannot approve an app. Allow hands the app a code, good once, for ten
 *   minutes, bound to its PKCE challenge and its redirect address.
 * - **Tokens.** /oauth/token swaps the code and the PKCE verifier for an access
 *   token (an hour) and a refresh token (a year, renewed on use). The refresh
 *   token rotates at every use and the one before is remembered: turning up
 *   again after the app has moved on means a copy exists, and the app is
 *   disconnected. A code that comes back a second time does the same.
 * - **Disconnecting.** Settings lists every connected app and disconnects one
 *   at a tap; /oauth/revoke (RFC 7009) lets an app disconnect itself.
 *
 * Only SHA-256 hashes of codes and tokens are stored (migration 0020), so a copy
 * of the database connects nobody. An access token opens /mcp and nothing else:
 * never /api, never a write.
 */
import { b64url, hashToken, randomToken, sha256, timingSafeEqual } from './auth/crypto';
import { nowSec } from './db';

/** The one thing an app may be allowed: to read. */
export const SCOPE = 'solarlens:read';
export const CODE_S = 600;
export const ACCESS_S = 3600;
export const REFRESH_S = 365 * 86400;
/** How long the refresh token just replaced still works, for a request already in flight. */
export const GRACE_S = 120;
/** Registrations kept at most. */
export const MAX_CLIENTS = 100;
/**
 * How long a registration that was never approved is kept. An app registers and
 * asks for approval in the same breath, so one left unapproved for an hour was
 * abandoned - and registering is open to anyone, so a stranger who fills the
 * list holds it for an hour rather than the week it once was.
 */
export const STALE_CLIENT_S = 3600;

export const resourceOf = (origin: string) => `${origin}/mcp`;

// ---------------------------------------------------------------- discovery

/** RFC 9728: what this resource is, and who issues tokens for it. */
export const protectedResource = (origin: string) => ({
  resource: resourceOf(origin),
  authorization_servers: [origin],
  scopes_supported: [SCOPE],
  bearer_methods_supported: ['header'],
  resource_name: 'SolarLens',
  resource_documentation: 'https://github.com/muhammadmobi/SolarLens/blob/main/docs/mcp.md',
});

/** RFC 8414: where each step happens, and what is supported - PKCE with S256, public clients. */
export const authorizationServer = (origin: string) => ({
  issuer: origin,
  authorization_endpoint: `${origin}/oauth/authorize`,
  token_endpoint: `${origin}/oauth/token`,
  registration_endpoint: `${origin}/oauth/register`,
  revocation_endpoint: `${origin}/oauth/revoke`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
  revocation_endpoint_auth_methods_supported: ['none'],
  scopes_supported: [SCOPE],
  authorization_response_iss_parameter_supported: true,
});

// ---------------------------------------------------------------- registration

/** Schemes a native app's redirect may use besides https: never these, which run or read things. */
const BAD_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:', 'ftp:', 'ws:', 'wss:', 'http:', 'https:']);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Whether an app may be sent its answer at `uri`: https anywhere; plain http
 * only to this computer (a desktop app listening on a loopback port); or a
 * native app's own scheme ("cursor:", "com.example.app:"). Never with a
 * fragment. Returns why not, or null.
 */
export function redirectProblem(uri: unknown): string | null {
  if (typeof uri !== 'string' || !uri || uri.length > 500) return 'a redirect address is text, at most 500 characters';
  let url: URL;
  try { url = new URL(uri); } catch { return `${uri.slice(0, 80)} is not an address`; }
  if (url.hash) return 'a redirect address has no #fragment';
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:') return LOOPBACK.has(url.hostname) ? null : 'plain http is only for this computer (localhost)';
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && !BAD_SCHEMES.has(url.protocol) ? null : `${url.protocol} addresses are not allowed`;
}

export interface Client {
  id: string;
  name: string;
  redirect_uris: string[];
  created_at: number;
}

/** A name for an app, tidied: at most 60 characters, no control characters. */
const tidyName = (v: unknown) =>
  (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) : '') || 'An unnamed app';

/**
 * Register an app, as RFC 7591 asks: its name, its redirect addresses, and no
 * secret. Registrations never approved are cleared after an hour, and there are
 * at most MAX_CLIENTS, decided by the insert itself.
 */
export async function register(db: D1Database, body: unknown, now = nowSec()): Promise<{ client: Client } | { error: string; description: string }> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const bad = (description: string) => ({ error: 'invalid_client_metadata', description });
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 5) return { error: 'invalid_redirect_uri', description: 'Give one to five redirect_uris.' };
  for (const u of uris) {
    const problem = redirectProblem(u);
    if (problem) return { error: 'invalid_redirect_uri', description: `Not allowed: ${problem}.` };
  }
  if (b.token_endpoint_auth_method !== undefined && b.token_endpoint_auth_method !== 'none') {
    return bad('Only public clients are registered here: token_endpoint_auth_method "none", with PKCE.');
  }
  if (Array.isArray(b.grant_types) && b.grant_types.some((g) => g !== 'authorization_code' && g !== 'refresh_token')) {
    return bad('The grant types are authorization_code and refresh_token.');
  }
  if (Array.isArray(b.response_types) && b.response_types.some((r) => r !== 'code')) return bad('The one response type is code.');

  await db
    .prepare(
      `DELETE FROM oauth_clients WHERE created_at < ?1
         AND id NOT IN (SELECT client_id FROM oauth_grants WHERE revoked_at IS NULL)`,
    )
    .bind(now - STALE_CLIENT_S)
    .run();
  const client: Client = { id: randomToken(16), name: tidyName(b.client_name), redirect_uris: uris as string[], created_at: now };
  const res = await db
    .prepare(
      `INSERT INTO oauth_clients (id, name, redirect_uris, created_at)
       SELECT ?1, ?2, ?3, ?4 WHERE (SELECT COUNT(*) FROM oauth_clients) < ?5`,
    )
    .bind(client.id, client.name, JSON.stringify(client.redirect_uris), now, MAX_CLIENTS)
    .run();
  if (!res.meta.changes) return { error: 'invalid_client_metadata', description: 'Too many apps are registered; disconnect some in Settings first.' };
  return { client };
}

/** RFC 7591's answer to a registration. */
export const registration = (c: Client) => ({
  client_id: c.id, client_id_issued_at: c.created_at, client_name: c.name, redirect_uris: c.redirect_uris,
  grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: SCOPE,
});

export async function getClient(db: D1Database, id: unknown): Promise<Client | null> {
  if (typeof id !== 'string' || id.length > 100) return null;
  const row = await db.prepare('SELECT * FROM oauth_clients WHERE id = ?1').bind(id).first<{ id: string; name: string; redirect_uris: string; created_at: number }>();
  if (!row) return null;
  try { return { ...row, redirect_uris: JSON.parse(row.redirect_uris) as string[] }; } catch { return null; }
}

// ---------------------------------------------------------------- approval

/** An authorization request, checked: the client, where to answer, and the PKCE challenge. */
export interface AuthRequest {
  client: Client;
  redirectUri: string;
  state: string | null;
  challenge: string;
  scope: string;
}

/**
 * Check an authorization request. A request naming an unknown app or an
 * address it did not register is answered on the page itself - never by
 * sending the browser to an address nobody vouched for. Anything else wrong is
 * sent back to the app, at its address, as OAuth says.
 */
export async function checkAuthorization(db: D1Database, p: Record<string, string | undefined>, origin: string): Promise<
  { ok: AuthRequest } | { page: string } | { redirect: string }
> {
  const client = await getClient(db, p.client_id);
  if (!client) return { page: 'This link names an app SolarLens does not know. Start connecting it again from the app.' };
  const redirectUri = p.redirect_uri ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : undefined);
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
    return { page: 'This link would send the answer to an address the app did not register. Start connecting it again from the app.' };
  }
  const back = (error: string, description: string) => ({ redirect: withParams(redirectUri, { error, error_description: description, state: p.state ?? null, iss: origin }) });
  if (p.response_type !== 'code') return back('unsupported_response_type', 'The response type is code.');
  if (!p.code_challenge || p.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(p.code_challenge)) {
    return back('invalid_request', 'PKCE with S256 is required.');
  }
  const scopes = (p.scope ?? SCOPE).split(/\s+/).filter(Boolean);
  if (scopes.some((s) => s !== SCOPE)) return back('invalid_scope', `The one scope is ${SCOPE}.`);
  if (p.resource && p.resource.replace(/\/+$/, '') !== resourceOf(origin) && p.resource.replace(/\/+$/, '') !== origin) {
    return back('invalid_target', `The resource is ${resourceOf(origin)}.`);
  }
  if (p.state !== undefined && p.state.length > 500) return back('invalid_request', 'The state is too long.');
  return { ok: { client, redirectUri, state: p.state ?? null, challenge: p.code_challenge, scope: SCOPE } };
}

/** `uri` with query parameters added, the ones that are null left out. */
export function withParams(uri: string, params: Record<string, string | null>): string {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  return url.href;
}

/** Allow: a code for the app, at its address, with its state - good once, for ten minutes. */
export async function approve(db: D1Database, r: AuthRequest, origin: string, now = nowSec()): Promise<string> {
  const code = randomToken(32);
  await db.prepare('DELETE FROM oauth_codes WHERE created_at < ?1').bind(now - CODE_S).run();
  await db
    .prepare('INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, challenge, scope, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(await hashToken(code), r.client.id, r.redirectUri, r.challenge, r.scope, now)
    .run();
  return withParams(r.redirectUri, { code, state: r.state, iss: origin });
}

/** Deny: the app is told, at its address. */
export const deny = (r: AuthRequest, origin: string) =>
  withParams(r.redirectUri, { error: 'access_denied', error_description: 'The owner did not allow it.', state: r.state, iss: origin });

// ---------------------------------------------------------------- tokens

type TokenOutcome = { status: number; body: Record<string, unknown> };
const tokenError = (error: string, description: string, status = 400): TokenOutcome => ({ status, body: { error, error_description: description } });

interface GrantRow {
  id: string;
  client_id: string;
  scope: string;
  refresh_hash: string;
  prev_hash: string | null;
  rotated_at: number;
  created_at: number;
  last_used_at: number;
  expires_at: number;
  revoked_at: number | null;
}

/** A fresh access token for a grant, an hour long; expired ones are cleared as new ones are made. */
async function newAccess(db: D1Database, grantId: string, now: number): Promise<string> {
  const token = randomToken(32);
  await db.batch([
    db.prepare('DELETE FROM oauth_access WHERE expires_at < ?1').bind(now),
    db.prepare('INSERT INTO oauth_access (token_hash, grant_id, expires_at) VALUES (?1, ?2, ?3)').bind(await hashToken(token), grantId, now + ACCESS_S),
  ]);
  return token;
}

const tokens = (access: string, refresh: string | null, scope: string): TokenOutcome => ({
  status: 200,
  body: { access_token: access, token_type: 'Bearer', expires_in: ACCESS_S, scope, ...(refresh ? { refresh_token: refresh } : {}) },
});

/** Disconnect a grant: its refresh token and every access token stop at once. */
export async function revokeGrant(db: D1Database, id: string, now = nowSec()): Promise<boolean> {
  const res = await db.prepare('UPDATE oauth_grants SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL').bind(id, now).run();
  await db.prepare('DELETE FROM oauth_access WHERE grant_id = ?1').bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * The token endpoint: a code and its PKCE verifier for a first pair of tokens,
 * or a refresh token for the next. `form` is the request's form fields.
 */
export async function token(db: D1Database, form: Record<string, string | undefined>, origin: string, now = nowSec()): Promise<TokenOutcome> {
  if (form.grant_type === 'authorization_code') return exchange(db, form, origin, now);
  if (form.grant_type === 'refresh_token') return renew(db, form, now);
  return tokenError('unsupported_grant_type', 'The grant types are authorization_code and refresh_token.');
}

async function exchange(db: D1Database, f: Record<string, string | undefined>, origin: string, now: number): Promise<TokenOutcome> {
  if (!f.code || !f.code_verifier || !f.client_id) return tokenError('invalid_request', 'code, code_verifier and client_id are needed.');
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(f.code_verifier)) return tokenError('invalid_request', 'The code_verifier is 43 to 128 unreserved characters.');
  if (f.resource && f.resource.replace(/\/+$/, '') !== resourceOf(origin) && f.resource.replace(/\/+$/, '') !== origin) {
    return tokenError('invalid_target', `The resource is ${resourceOf(origin)}.`);
  }
  const hash = await hashToken(f.code);
  const row = await db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?1')
    .bind(hash).first<{ client_id: string; redirect_uri: string; challenge: string; scope: string; created_at: number; used: number; grant_id: string | null }>();
  if (!row || row.created_at < now - CODE_S) return tokenError('invalid_grant', 'The code is not valid, or has run out.');
  if (row.used) {
    // A code used twice: someone else has it too. What it made is disconnected.
    if (row.grant_id) await revokeGrant(db, row.grant_id, now);
    return tokenError('invalid_grant', 'The code has already been used.');
  }
  if (row.client_id !== f.client_id) return tokenError('invalid_grant', 'The code was issued to another app.');
  if (f.redirect_uri !== undefined && f.redirect_uri !== row.redirect_uri) return tokenError('invalid_grant', 'The redirect_uri is not the one the code was issued for.');
  const expected = b64url(await sha256(f.code_verifier));
  if (!timingSafeEqual(expected, row.challenge)) return tokenError('invalid_grant', 'The code_verifier does not match the challenge.');

  const id = randomToken(9);
  const secret = randomToken(32);
  // Used once, in the same statement that checks it has not been: two exchanges at once cannot both win.
  const claimed = await db.prepare('UPDATE oauth_codes SET used = 1, grant_id = ?2 WHERE code_hash = ?1 AND used = 0').bind(hash, id).run();
  if (!claimed.meta.changes) return tokenError('invalid_grant', 'The code has already been used.');
  await db
    .prepare(
      `INSERT INTO oauth_grants (id, client_id, scope, refresh_hash, prev_hash, rotated_at, created_at, last_used_at, expires_at, revoked_at)
       VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?5, ?5, ?6, NULL)`,
    )
    .bind(id, row.client_id, row.scope, await hashToken(secret), now, now + REFRESH_S)
    .run();
  return tokens(await newAccess(db, id, now), `${id}.${secret}`, row.scope);
}

/**
 * Renew: the refresh token for a new pair, the old one remembered. The same
 * token again within two minutes is a request that crossed with its own
 * renewal, and gets an access token alone; later, it is a copy, and the app
 * is disconnected.
 */
async function renew(db: D1Database, f: Record<string, string | undefined>, now: number): Promise<TokenOutcome> {
  const [id, secret] = (f.refresh_token ?? '').split('.');
  if (!id || !secret) return tokenError('invalid_grant', 'The refresh token is not valid.');
  const g = await db.prepare('SELECT * FROM oauth_grants WHERE id = ?1').bind(id).first<GrantRow>();
  if (!g || g.revoked_at != null || g.expires_at <= now) return tokenError('invalid_grant', 'This app has been disconnected; connect it again.');
  if (f.client_id && f.client_id !== g.client_id) return tokenError('invalid_grant', 'The refresh token was issued to another app.');
  const presented = await hashToken(secret);
  if (timingSafeEqual(presented, g.refresh_hash)) {
    const next = randomToken(32);
    const res = await db
      .prepare(
        `UPDATE oauth_grants SET refresh_hash = ?3, prev_hash = refresh_hash, rotated_at = ?4, last_used_at = ?4, expires_at = ?5
         WHERE id = ?1 AND refresh_hash = ?2 AND revoked_at IS NULL`,
      )
      .bind(id, presented, await hashToken(next), now, now + REFRESH_S)
      .run();
    if (res.meta.changes) return tokens(await newAccess(db, id, now), `${id}.${next}`, g.scope);
  }
  const fresh = await db.prepare('SELECT * FROM oauth_grants WHERE id = ?1').bind(id).first<GrantRow>();
  if (fresh && fresh.prev_hash && timingSafeEqual(presented, fresh.prev_hash)) {
    if (now - fresh.rotated_at <= GRACE_S && fresh.revoked_at == null) return tokens(await newAccess(db, id, now), null, fresh.scope);
    await revokeGrant(db, id, now);
    console.warn(JSON.stringify({ oauth: 'refresh-token-reused', grant: id.slice(0, 6) }));
  }
  return tokenError('invalid_grant', 'The refresh token is not valid.');
}

/**
 * RFC 7009: an app disconnects itself with its refresh token, or drops an
 * access token. Always "done", whether or not the token meant anything - an
 * answer must not say which tokens exist.
 */
export async function revokeToken(db: D1Database, tokenText: unknown, now = nowSec()): Promise<void> {
  if (typeof tokenText !== 'string' || !tokenText) return;
  const [id, secret] = tokenText.split('.');
  if (id && secret) {
    const g = await db.prepare('SELECT refresh_hash, prev_hash FROM oauth_grants WHERE id = ?1').bind(id).first<{ refresh_hash: string; prev_hash: string | null }>();
    const presented = await hashToken(secret);
    if (g && (timingSafeEqual(presented, g.refresh_hash) || (g.prev_hash && timingSafeEqual(presented, g.prev_hash)))) await revokeGrant(db, id, now);
    return;
  }
  await db.prepare('DELETE FROM oauth_access WHERE token_hash = ?1').bind(await hashToken(tokenText)).run();
}

/**
 * The connected app an access token belongs to, or null: a token SolarLens
 * issued, in date, for an app still connected. Marks the app as used, at most
 * once a minute.
 */
export async function appForToken(db: D1Database, tokenText: string, now = nowSec()): Promise<{ grant: string; client: string } | null> {
  const row = await db
    .prepare(
      `SELECT g.id, g.client_id, g.last_used_at FROM oauth_access a JOIN oauth_grants g ON g.id = a.grant_id
       WHERE a.token_hash = ?1 AND a.expires_at > ?2 AND g.revoked_at IS NULL`,
    )
    .bind(await hashToken(tokenText), now)
    .first<{ id: string; client_id: string; last_used_at: number }>();
  if (!row) return null;
  if (now - row.last_used_at > 60) await db.prepare('UPDATE oauth_grants SET last_used_at = ?2 WHERE id = ?1').bind(row.id, now).run();
  return { grant: row.id, client: row.client_id };
}

/** Every app still connected, for Settings: what it called itself, where its answers went, since when, last used. */
export async function connectedApps(db: D1Database, now = nowSec()) {
  const { results } = await db
    .prepare(
      `SELECT g.id, g.created_at, g.last_used_at, c.name, c.redirect_uris FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id
       WHERE g.revoked_at IS NULL AND g.expires_at > ?1 ORDER BY g.last_used_at DESC`,
    )
    .bind(now)
    .all<{ id: string; created_at: number; last_used_at: number; name: string; redirect_uris: string }>();
  return results.map((r) => {
    let where = '';
    try {
      const first = (JSON.parse(r.redirect_uris) as string[])[0];
      const u = new URL(first);
      where = u.protocol === 'https:' || u.protocol === 'http:' ? u.host : u.protocol.replace(/:$/, '');
    } catch { where = ''; }
    return { id: r.id, name: r.name, redirect_to: where, connected_at: r.created_at, last_used_at: r.last_used_at };
  });
}

// ---------------------------------------------------------------- the pages

const escHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));

/**
 * The approval page's shape: small, on its own, in the dashboard's colours, in
 * either theme. Its script only posts the owner's choice and follows the
 * answer; everything shown was escaped here.
 */
function page(title: string, body: string, script = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${escHtml(title)} · SolarLens</title><link rel="icon" href="/icon.svg">
<style>
  :root { --bg: #f4f5f1; --surface: #ffffff; --ink: #17191a; --muted: #5d6360; --line: #e2e4de; --accent: #2f6fde; --warn: #9a5b00; --warn-bg: #fdf1dd; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111413; --surface: #1a1e1c; --ink: #edeee9; --muted: #a2a8a4; --line: #2c322f; --accent: #6fa0f0; --warn: #f0b35a; --warn-bg: #2d2415; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; background: var(--bg); color: var(--ink);
         font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: 100%; max-width: 460px; background: var(--surface); border: 1px solid var(--line); border-radius: 16px; padding: 28px; }
  h1 { font-size: 20px; line-height: 1.3; margin: 0 0 14px; }
  p, li { color: var(--muted); } ul { padding-left: 20px; } strong { color: var(--ink); }
  .where { background: var(--warn-bg); color: var(--warn); border-radius: 10px; padding: 10px 12px; font-size: 14px; word-break: break-all; }
  .buttons { display: flex; gap: 10px; margin-top: 22px; flex-wrap: wrap; }
  button, a.button { font: inherit; font-weight: 700; border-radius: 10px; padding: 10px 18px; cursor: pointer; border: 1px solid var(--line);
         background: transparent; color: var(--ink); text-decoration: none; }
  button.primary, a.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .err { color: #c0392b; min-height: 1.5em; }
</style></head><body><main>${body}</main>${script}</body></html>`;
}

/** Something wrong with the link itself: said on the page, never sent anywhere. */
export const errorPage = (message: string) => page('Cannot connect', `<h1>This app cannot be connected</h1><p>${escHtml(message)}</p>`);

/** Not signed in as the owner: sign in on the dashboard, which brings you back here. */
export const signInPage = (next: string, viewer: boolean) => page('Sign in', `<h1>Sign in to SolarLens first</h1>
  <p>${viewer ? 'This browser is signed in with a share link, which can only view. Only the owner can connect an app.' : 'Connecting an app needs the owner, signed in on this browser.'}</p>
  <div class="buttons"><a class="button primary" href="/?next=${encodeURIComponent(next)}#/settings">Sign in</a></div>
  <p>You come back here once you are signed in.</p>`);

/** The approval itself: which app, where its answer goes, and what it may do. */
export function consentPage(r: AuthRequest, params: Record<string, string | undefined>): string {
  const target = new URL(r.redirectUri);
  const where = target.protocol === 'https:' || target.protocol === 'http:' ? target.origin : `${target.protocol}//… (an app on this computer)`;
  const request = JSON.stringify(params).replace(/</g, '\\u003c');
  return page(`Connect ${r.client.name}`, `<h1>Connect <strong>${escHtml(r.client.name)}</strong> to SolarLens?</h1>
  <p>It will be able to read this dashboard's figures - energy, systems, faults, how a day went and whether a system is slowly making less - through the same read-only questions the Ask tab answers.</p>
  <ul><li>It cannot change anything, and never sees a password, a token, or where the systems are.</li>
  <li>It stays connected until you disconnect it in Settings, under Connected apps.</li></ul>
  <p class="where">Its answer is sent to <strong>${escHtml(where)}</strong>. The name above is the app's own; if you did not just start connecting it, press Deny.</p>
  <div class="buttons"><button class="primary" id="allow" type="button">Allow</button><button id="deny" type="button">Deny</button></div>
  <p class="err" id="err" role="alert"></p>`, `<script id="req" type="application/json">${request}</script>
<script>
  const req = JSON.parse(document.getElementById('req').textContent);
  async function decide(allow) {
    for (const b of document.querySelectorAll('button')) b.disabled = true;
    try {
      const res = await fetch('/oauth/authorize', { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...req, allow }) });
      const out = await res.json();
      if (!res.ok || !out.redirect) throw new Error(out.error || 'The server said ' + res.status);
      location.assign(out.redirect);
    } catch (e) {
      document.getElementById('err').textContent = e.message;
      for (const b of document.querySelectorAll('button')) b.disabled = false;
    }
  }
  document.getElementById('allow').onclick = () => decide(true);
  document.getElementById('deny').onclick = () => decide(false);
</script>`);
}
