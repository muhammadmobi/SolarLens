/**
 * The sign-in routes, under /auth, and the share-link opener at /s/<link>.
 *
 * Mounted by src/index.ts, after the middleware that has already worked out
 * who is asking (c.get('caller'); see ./sessions identify). Every route here
 * answers JSON, except /s/<link>, which sends a browser on to the dashboard.
 *
 * The owner's first way in is the setup code - API_TOKEN, which only the person
 * who deployed SolarLens has - entered once, on the sign-in page, to set a
 * password or to go on and add a passkey. The same code resets a forgotten
 * password, and doing so signs every other device out.
 */
import { Hono, type Context } from 'hono';
import { setCookie } from 'hono/cookie';
import type { Env } from '../db';
import { PASSWORD_MIN, b64url, fromB64url, hashPassword, keySecret, previousKeySecret, timingSafeEqual, verifyPassword } from './crypto';
import {
  type Caller, type CookieOut, callerKey, clearCookies, createShare, deviceLabel, forgiveCaller, listDevices, listShares,
  lockedUntil, loginChallenge, loginChallengeValid, newChallenge, openShare, owner, passkeyCount, recordFailure, revokeDevice,
  revokeOthers, revokeShare, setPassword, setRequired, spendChallenge, startDevice, takeChallenge,
} from './sessions';
import { ES256, RS256, type StoredKey, verifyAssertion, verifyRegistration } from './webauthn';

export type AuthVars = { caller: Caller };
type C = Context<{ Bindings: Env; Variables: AuthVars }>;

const now = () => Math.floor(Date.now() / 1000);

/** Hand the browser its cookies: HttpOnly, Secure, and never sent from another site. */
export function applyCookies(c: C | Context, cookies: CookieOut[]): void {
  for (const k of cookies) {
    setCookie(c, k.name, k.value, { httpOnly: true, secure: true, sameSite: 'Strict', path: '/', maxAge: k.maxAge });
  }
}

/** Where a passkey ceremony is happening: this host, and its origin exactly. */
function rpOf(c: C) {
  const url = new URL(c.req.url);
  return { id: url.hostname, origin: url.origin };
}

/** The challenge a browser signed, read from its client data, or null. */
function challengeIn(clientDataJSON: unknown): string | null {
  if (typeof clientDataJSON !== 'string') return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(fromB64url(clientDataJSON))) as { challenge?: unknown };
    return typeof data.challenge === 'string' ? data.challenge : null;
  } catch {
    return null;
  }
}

const body = async <T>(c: C): Promise<Partial<T>> => c.req.json<Partial<T>>().catch(() => ({}));
const isOwner = (c: C) => c.get('caller').role === 'owner';

/**
 * Whether `password` is the owner's. A hash made before SECRET_KEY was set is
 * peppered with API_TOKEN: it still matches, and is made again under the key
 * secret there and then, so the password moves over the first time it is used.
 */
async function passwordMatches(c: C, password: unknown, stored: string | null | undefined): Promise<boolean> {
  const key = keySecret(c.env);
  if (!key || !stored || typeof password !== 'string') return false;
  if (await verifyPassword(password, stored, key)) return true;
  const before = previousKeySecret(c.env);
  if (!before || !(await verifyPassword(password, stored, before))) return false;
  await setPassword(c.env.DB, await hashPassword(password, key), now());
  return true;
}

/** Refused, with the time the lock lifts, so the page can say how long to wait. */
const locked = (c: C, until: number) =>
  c.json({ error: 'Too many wrong tries. Wait, or sign in with a passkey.', until }, 429);

export const auth = new Hono<{ Bindings: Env; Variables: AuthVars }>();

// Nothing here may be cached anywhere: every answer is about this one browser.
auth.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});

/**
 * What the page needs to know to draw the sign-in page or Settings: whether
 * sign-in can work here at all, whether the owner has set up a way in, whether
 * reads need it, and who this browser is.
 */
auth.get('/status', async (c) => {
  const [o, keys] = await Promise.all([owner(c.env.DB), passkeyCount(c.env.DB)]);
  const caller = c.get('caller');
  return c.json({
    configured: !!c.env.API_TOKEN,
    password: !!o?.password,
    passkeys: keys,
    required: !!o?.require_sign_in,
    role: caller.role,
    device: caller.deviceId,
  });
});

/**
 * First-time setup, and a forgotten password: the setup code, and a new
 * password or none (for an owner who will sign in with passkeys only). Signs
 * this browser in as the owner, and every other device out.
 */
auth.post('/setup', async (c) => {
  const secret = c.env.API_TOKEN;
  const keys = keySecret(c.env);
  if (!secret || !keys) return c.json({ error: 'Sign-in is not set up on this server: API_TOKEN is missing.' }, 503);
  const key = await callerKey(c.req.header('cf-connecting-ip'));
  // The caller's own lock only: see lockedUntil, on why the setup code is kept out of the pause for everyone.
  const until = await lockedUntil(c.env.DB, key, now(), false);
  if (until) return locked(c, until);
  const b = await body<{ code: string; password: string | null }>(c);
  if (typeof b.code !== 'string' || !timingSafeEqual(b.code.trim(), secret)) {
    await recordFailure(c.env.DB, key, now(), false);
    return c.json({ error: 'That setup code is not right.' }, 401);
  }
  if (b.password != null && (typeof b.password !== 'string' || b.password.length < PASSWORD_MIN)) {
    return c.json({ error: `A password needs at least ${PASSWORD_MIN} characters.` }, 400);
  }
  await forgiveCaller(c.env.DB, key);
  if (typeof b.password === 'string') await setPassword(c.env.DB, await hashPassword(b.password, keys), now());
  else if (!(await owner(c.env.DB))) await setPassword(c.env.DB, null, now());
  const cookies = await startDevice(c.env.DB, keys, 'owner', deviceLabel(c.req.header('user-agent')), now());
  const deviceId = cookies[1].value.split('.')[0];
  await revokeOthers(c.env.DB, deviceId, now());
  applyCookies(c, cookies);
  return c.json({ ok: true });
});

/** Sign in with the password. */
auth.post('/login', async (c) => {
  const keys = keySecret(c.env);
  if (!c.env.API_TOKEN || !keys) return c.json({ error: 'Sign-in is not set up on this server.' }, 503);
  const key = await callerKey(c.req.header('cf-connecting-ip'));
  const until = await lockedUntil(c.env.DB, key, now());
  if (until) return locked(c, until);
  const b = await body<{ password: string }>(c);
  const o = await owner(c.env.DB);
  if (!(await passwordMatches(c, b.password, o?.password))) {
    await recordFailure(c.env.DB, key, now());
    return c.json({ error: o?.password ? 'That password is not right.' : 'No password is set. Use a passkey, or the setup code.' }, 401);
  }
  await forgiveCaller(c.env.DB, key);
  applyCookies(c, await startDevice(c.env.DB, keys, 'owner', deviceLabel(c.req.header('user-agent')), now()));
  return c.json({ ok: true });
});

/** Sign this browser out. */
auth.post('/logout', async (c) => {
  const caller = c.get('caller');
  if (caller.deviceId) await revokeDevice(c.env.DB, caller.deviceId, now());
  applyCookies(c, clearCookies());
  return c.json({ ok: true });
});

/**
 * The options for navigator.credentials.create() or .get(), with a fresh
 * challenge. Making a passkey needs the owner signed in; using one does not.
 *
 * User verification is required both ways: the fingerprint, face or PIN that
 * unlocks the passkey, not just a touch. A passkey is the whole sign-in here,
 * with no password beside it, so a security key without a PIN - or one picked
 * up off a desk - must not be enough on its own. Phones, laptops and password
 * managers verify anyway; a security key with no PIN is asked to set one.
 */
auth.post('/passkey/options', async (c) => {
  const b = await body<{ purpose: 'register' | 'login' }>(c);
  const rp = rpOf(c);
  if (b.purpose === 'register') {
    if (!isOwner(c)) return c.json({ error: 'Sign in first to add a passkey.' }, 401);
    const { results } = await c.env.DB.prepare('SELECT id FROM auth_passkeys').all<{ id: string }>();
    return c.json({
      challenge: await newChallenge(c.env.DB, 'register', now()),
      rp: { id: rp.id, name: 'SolarLens' },
      // One owner, so one fixed user handle: every passkey here is the owner's.
      user: { id: b64url(new TextEncoder().encode('solarlens-owner')), name: 'owner', displayName: 'SolarLens owner' },
      pubKeyCredParams: [{ type: 'public-key', alg: ES256 }, { type: 'public-key', alg: RS256 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      excludeCredentials: results.map((r) => ({ type: 'public-key', id: r.id })),
      attestation: 'none',
      timeout: 120_000,
    });
  }
  const keys = keySecret(c.env);
  if (!keys) return c.json({ error: 'Sign-in is not set up on this server.' }, 503);
  // A passkey made here is discoverable, so the browser offers it without
  // being told which one: no list of credential ids is handed to a stranger.
  // Its challenge is signed rather than stored (loginChallenge), so a stranger
  // asking writes nothing.
  return c.json({ challenge: await loginChallenge(keys, now()), rpId: rp.id, userVerification: 'required', timeout: 120_000 });
});

/** Keep a new passkey. */
auth.post('/passkey/register', async (c) => {
  if (!isOwner(c)) return c.json({ error: 'Sign in first to add a passkey.' }, 401);
  const b = await body<{ response: { clientDataJSON: string; attestationObject: string }; name: string }>(c);
  const challenge = challengeIn(b.response?.clientDataJSON);
  if (!challenge || !(await takeChallenge(c.env.DB, challenge, 'register', now()))) {
    return c.json({ error: 'That request ran out. Try again.' }, 400);
  }
  try {
    const made = await verifyRegistration(b.response as never, challenge, rpOf(c));
    const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 60) : deviceLabel(c.req.header('user-agent'));
    await c.env.DB
      .prepare('INSERT INTO auth_passkeys (id, public_key, sign_count, name, created_at, last_used_at) VALUES (?1, ?2, ?3, ?4, ?5, NULL)')
      .bind(made.id, JSON.stringify(made.key), made.signCount, name, now())
      .run();
    return c.json({ ok: true, id: made.id });
  } catch (e) {
    return c.json({ error: `That passkey was not accepted: ${(e as Error).message}.` }, 400);
  }
});

/** Sign in with a passkey. */
auth.post('/passkey/login', async (c) => {
  const keys = keySecret(c.env);
  if (!c.env.API_TOKEN || !keys) return c.json({ error: 'Sign-in is not set up on this server.' }, 503);
  const b = await body<{ id: string; response: { clientDataJSON: string; authenticatorData: string; signature: string } }>(c);
  const challenge = challengeIn(b.response?.clientDataJSON);
  if (!challenge || !(await loginChallengeValid(keys, challenge, now()))) {
    return c.json({ error: 'That request ran out. Try again.' }, 400);
  }
  const row = typeof b.id === 'string'
    ? await c.env.DB.prepare('SELECT public_key, sign_count FROM auth_passkeys WHERE id = ?1').bind(b.id).first<{ public_key: string; sign_count: number }>()
    : null;
  if (!row) return c.json({ error: 'This passkey is not one of this dashboard\'s. It may have been removed.' }, 401);
  try {
    const { signCount } = await verifyAssertion(b.response as never, challenge, rpOf(c), JSON.parse(row.public_key) as StoredKey, row.sign_count);
    // Verified: the challenge is spent now, so the same signed answer sent again is refused.
    if (!(await spendChallenge(c.env.DB, challenge, now()))) throw new Error('that sign-in was already used');
    // The counter moves only from the value this check read. Two sign-ins
    // racing with the same counter - which is what a copied key used at the
    // same moment looks like - cannot both succeed: the second finds the count
    // already moved, and is refused. A synced passkey that always reports zero
    // has no counter to race on, and stays at zero.
    const res = await c.env.DB
      .prepare('UPDATE auth_passkeys SET sign_count = ?2, last_used_at = ?3 WHERE id = ?1 AND sign_count = ?4')
      .bind(b.id, signCount, now(), row.sign_count)
      .run();
    if ((res.meta.changes ?? 0) === 0) throw new Error('it was used somewhere else at the same moment');
  } catch (e) {
    return c.json({ error: `That passkey did not verify: ${(e as Error).message}.` }, 401);
  }
  applyCookies(c, await startDevice(c.env.DB, keys, 'owner', deviceLabel(c.req.header('user-agent')), now()));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- Settings, owner only

auth.use('/settings', async (c, next) => (isOwner(c) ? next() : c.json({ error: 'Sign in as the owner.' }, 401)));
auth.use('/settings/*', async (c, next) => (isOwner(c) ? next() : c.json({ error: 'Sign in as the owner.' }, 401)));

/** Everything the Security part of Settings shows. */
auth.get('/settings', async (c) => {
  const t = now();
  const [o, devices, shares, keys] = await Promise.all([
    owner(c.env.DB),
    listDevices(c.env.DB, t),
    listShares(c.env.DB, t),
    c.env.DB.prepare('SELECT id, name, created_at, last_used_at FROM auth_passkeys ORDER BY created_at').all(),
  ]);
  const me = c.get('caller').deviceId;
  return c.json({
    password: !!o?.password,
    required: !!o?.require_sign_in,
    passkeys: keys.results,
    devices: devices.map((d) => ({
      id: d.id, role: d.role, label: d.label, created_at: d.created_at, last_seen_at: d.last_seen_at,
      expires_at: d.expires_at, shared: !!d.share_id, this: d.id === me,
    })),
    shares,
  });
});

/** "Require sign-in to view": on only once there is a way to sign in. */
auth.post('/settings/required', async (c) => {
  const b = await body<{ on: boolean }>(c);
  const [o, keys] = await Promise.all([owner(c.env.DB), passkeyCount(c.env.DB)]);
  if (b.on && !o?.password && keys === 0) {
    return c.json({ error: 'Set a password or add a passkey first, or you would be locked out.' }, 409);
  }
  await setRequired(c.env.DB, !!b.on, now());
  return c.json({ ok: true, required: !!b.on });
});

/** Change the password, or set one, or remove it when a passkey remains. */
auth.post('/settings/password', async (c) => {
  const keys = keySecret(c.env) as string;
  const b = await body<{ current: string; next: string | null }>(c);
  const o = await owner(c.env.DB);
  if (o?.password) {
    const key = await callerKey(c.req.header('cf-connecting-ip'));
    const until = await lockedUntil(c.env.DB, key, now());
    if (until) return locked(c, until);
    if (!(await passwordMatches(c, b.current, o.password))) {
      await recordFailure(c.env.DB, key, now());
      return c.json({ error: 'The current password is not right.' }, 401);
    }
  }
  if (b.next === null) {
    if ((await passkeyCount(c.env.DB)) === 0) return c.json({ error: 'Add a passkey before removing the password.' }, 409);
    await setPassword(c.env.DB, null, now());
    return c.json({ ok: true, password: false });
  }
  if (typeof b.next !== 'string' || b.next.length < PASSWORD_MIN) {
    return c.json({ error: `A password needs at least ${PASSWORD_MIN} characters.` }, 400);
  }
  await setPassword(c.env.DB, await hashPassword(b.next, keys), now());
  return c.json({ ok: true, password: true });
});

/** Remove a passkey - unless it is the last way in while sign-in is required. */
auth.post('/settings/passkeys/remove', async (c) => {
  const b = await body<{ id: string }>(c);
  const [o, keys] = await Promise.all([owner(c.env.DB), passkeyCount(c.env.DB)]);
  if (o?.require_sign_in && !o.password && keys <= 1) {
    return c.json({ error: 'This is your only way to sign in. Set a password first.' }, 409);
  }
  const res = await c.env.DB.prepare('DELETE FROM auth_passkeys WHERE id = ?1').bind(String(b.id ?? '')).run();
  return c.json({ ok: (res.meta.changes ?? 0) > 0 });
});

/** Sign one device out, or every device but this one. */
auth.post('/settings/devices/revoke', async (c) => {
  const b = await body<{ id: string; others: boolean }>(c);
  if (b.others) return c.json({ ok: true, signedOut: await revokeOthers(c.env.DB, c.get('caller').deviceId, now()) });
  return c.json({ ok: await revokeDevice(c.env.DB, String(b.id ?? ''), now()) });
});

/** Make a view-only link. The whole link is in this answer and nowhere else. */
auth.post('/settings/shares', async (c) => {
  const b = await body<{ name: string; days: number | null }>(c);
  const days = typeof b.days === 'number' && b.days > 0 ? Math.min(3650, Math.round(b.days)) : null;
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 60) : null;
  const { id, token } = await createShare(c.env.DB, name, days, now());
  return c.json({ ok: true, id, url: `${new URL(c.req.url).origin}/s/${token}` });
});

auth.post('/settings/shares/revoke', async (c) => {
  const b = await body<{ id: string }>(c);
  return c.json({ ok: await revokeShare(c.env.DB, String(b.id ?? ''), now()) });
});

/**
 * Opening a share link: sign this browser in as a viewer and go to the
 * dashboard. A link that is wrong, revoked or out of date lands on the
 * dashboard too, which then asks for a sign-in if one is needed.
 */
export async function openShareLink(c: Context<{ Bindings: Env; Variables: AuthVars }>): Promise<Response> {
  const secret = c.env.API_TOKEN;
  const keys = keySecret(c.env);
  const link = c.req.param('link') ?? '';
  const share = secret && keys ? await openShare(c.env.DB, link, now()) : null;
  c.header('Cache-Control', 'no-store');
  if (!share || !keys) return c.redirect('/?link=expired');
  applyCookies(c, await startDevice(c.env.DB, keys, 'viewer', deviceLabel(c.req.header('user-agent')), now(), { id: share.id, expiresAt: share.expires_at }));
  return c.redirect('/');
}
