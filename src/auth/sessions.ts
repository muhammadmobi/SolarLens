/**
 * Who is asking: sessions, refresh tokens, signed-in devices, share links and
 * the lockout. The routes that use these are in ./routes.ts; the middleware
 * that applies them to every request is in src/index.ts.
 *
 * The shape, and why:
 *
 * - **Sign in once per device.** A sign-in makes a device row and hands the
 *   browser two cookies: a short session (an hour) and a long refresh token (a
 *   year). Both are HttpOnly, so no script on the page can read them.
 * - **Never asked again.** When the session has run out, the next request that
 *   carries the refresh token is answered as normal and renews both cookies on
 *   the way - there is no separate "refresh" call for the page, the TV or the
 *   service worker to get wrong. Each renewal pushes the refresh token's end a
 *   year out again, so a device that opens SolarLens once a year stays in.
 * - **A copied token is caught.** Every renewal replaces the refresh token, and
 *   the one before is remembered. If that old one turns up again after the
 *   real browser has moved on, two copies exist, and the device is signed out.
 *   Two tabs renewing at the same moment are not a copy: the renewal is one
 *   atomic update, the loser sees that it lost, and for two minutes the token
 *   just replaced is still accepted - without renewing again.
 * - **Only hashes are stored.** A copy of the database signs nobody in.
 * - **The session is signed**, with a key derived from API_TOKEN, and is also
 *   checked against its device row on every request, so signing a device out
 *   takes effect at once rather than when its hour runs out.
 */
import { hashToken, hmac, randomToken, timingSafeEqual } from './crypto';

export type Role = 'owner' | 'viewer';

/** Who a request comes from, once identified. */
export interface Caller {
  role: Role | null;
  /** The device row behind a cookie sign-in; null for a token or nobody. */
  deviceId: string | null;
  /** How it was identified: a session, a refresh just now, the API token, or not at all. */
  via: 'session' | 'refresh' | 'token' | 'none';
}

export const SESSION_COOKIE = 'sl_session';
export const REFRESH_COOKIE = 'sl_refresh';
/** How long a session lasts before the refresh token is asked to renew it. */
export const SESSION_S = 3600;
/** How long a refresh token lasts without being used. Each use renews it. */
export const REFRESH_S = 365 * 86400;
/** How long the refresh token just replaced is still accepted, for a second tab mid-flight. */
export const GRACE_S = 120;

/** A cookie to set on the response: its name, value and lifetime in seconds (0 clears it). */
export interface CookieOut {
  name: string;
  value: string;
  maxAge: number;
}

// ---------------------------------------------------------------- the session cookie

const SESSION_LABEL = 'solarlens session v1';

/** "v1.<device>.<role>.<ends>.<signature>" */
export async function makeSession(secret: string, deviceId: string, role: Role, now: number): Promise<string> {
  const body = `v1.${deviceId}.${role}.${now + SESSION_S}`;
  return `${body}.${await hmac(secret, SESSION_LABEL, body)}`;
}

/** The device and role a session names, if its signature holds and it has not run out. */
export async function readSession(secret: string, cookie: string | undefined, now: number): Promise<{ deviceId: string; role: Role } | null> {
  if (!cookie) return null;
  const parts = cookie.split('.');
  if (parts.length !== 5 || parts[0] !== 'v1') return null;
  const [, deviceId, role, endsText, sig] = parts;
  if (role !== 'owner' && role !== 'viewer') return null;
  const body = parts.slice(0, 4).join('.');
  if (!timingSafeEqual(await hmac(secret, SESSION_LABEL, body), sig)) return null;
  if (!(Number(endsText) > now)) return null;
  return { deviceId, role };
}

// ---------------------------------------------------------------- devices

export interface DeviceRow {
  id: string;
  role: Role;
  share_id: string | null;
  label: string | null;
  refresh_hash: string;
  prev_hash: string | null;
  rotated_at: number;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
}

/**
 * A short, human name for a browser from its User-Agent - "Chrome on
 * Android", "Safari on iPhone" - so the owner can tell their devices apart in
 * Settings. The full string is not kept: it is a fingerprint, and a name is all
 * the list needs.
 */
export function deviceLabel(ua: string | undefined): string {
  const s = ua ?? '';
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\/|Opera/.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox'
    : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'A browser';
  const os = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android'
    : /Windows/.test(s) ? 'Windows' : /Mac OS X|Macintosh/.test(s) ? 'Mac' : /CrOS/.test(s) ? 'ChromeOS'
    : /Linux/.test(s) ? 'Linux' : null;
  return os ? `${browser} on ${os}` : browser;
}

/**
 * Sign a new device in: a row with a fresh refresh token, and the two cookies
 * to hand it. A viewer through a share link is held to that link's end.
 */
export async function startDevice(
  db: D1Database, secret: string, role: Role, label: string, now: number,
  share?: { id: string; expiresAt: number | null },
): Promise<CookieOut[]> {
  const id = randomToken(16);
  const refresh = randomToken(32);
  const expires = Math.min(now + REFRESH_S, share?.expiresAt ?? Infinity);
  await db
    .prepare(
      `INSERT INTO auth_devices (id, role, share_id, label, refresh_hash, prev_hash, rotated_at, created_at, last_seen_at, expires_at, revoked_at)
       VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?6, ?6, ?7, NULL)`,
    )
    .bind(id, role, share?.id ?? null, label, await hashToken(refresh), now, expires)
    .run();
  return [
    { name: SESSION_COOKIE, value: await makeSession(secret, id, role, now), maxAge: SESSION_S },
    { name: REFRESH_COOKIE, value: `${id}.${refresh}`, maxAge: expires - now },
  ];
}

/** Both cookies, cleared - and the token cookie 2.x left, should one remain. */
export const clearCookies = (): CookieOut[] => [
  { name: SESSION_COOKIE, value: '', maxAge: 0 },
  { name: REFRESH_COOKIE, value: '', maxAge: 0 },
  { name: 'sl_token', value: '', maxAge: 0 },
];

/** A device row that may still sign in: not revoked, not run out. */
const live = (d: DeviceRow | null, now: number): d is DeviceRow => !!d && d.revoked_at == null && d.expires_at > now;

async function device(db: D1Database, id: string): Promise<DeviceRow | null> {
  return db.prepare('SELECT * FROM auth_devices WHERE id = ?1').bind(id).first<DeviceRow>();
}

/** Sign one device out. */
export async function revokeDevice(db: D1Database, id: string, now: number): Promise<boolean> {
  const res = await db.prepare('UPDATE auth_devices SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL').bind(id, now).run();
  return (res.meta.changes ?? 0) > 0;
}

/** Sign out every device but one (or every device, when `keep` is null). */
export async function revokeOthers(db: D1Database, keep: string | null, now: number): Promise<number> {
  const res = await db
    .prepare('UPDATE auth_devices SET revoked_at = ?2 WHERE revoked_at IS NULL AND (?1 IS NULL OR id <> ?1)')
    .bind(keep, now)
    .run();
  return res.meta.changes ?? 0;
}

/** The devices still signed in, newest use first. */
export async function listDevices(db: D1Database, now: number): Promise<DeviceRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM auth_devices WHERE revoked_at IS NULL AND expires_at > ?1 ORDER BY last_seen_at DESC')
    .bind(now)
    .all<DeviceRow>();
  return results;
}

/**
 * Identify a request from its cookies, renewing them if the session has run
 * out. Returns who it is and the cookies to set (none, new ones, or cleared).
 */
export async function identify(
  db: D1Database, secret: string, cookies: { session?: string; refresh?: string }, now: number,
): Promise<{ caller: Caller; set: CookieOut[] }> {
  const nobody = { role: null, deviceId: null, via: 'none' as const };

  // 1. A session that is signed and in date, for a device still signed in.
  const session = await readSession(secret, cookies.session, now);
  if (session) {
    const d = await device(db, session.deviceId);
    if (live(d, now)) return { caller: { role: d.role, deviceId: d.id, via: 'session' }, set: [] };
    // Signed out elsewhere: the session is void, and so is the refresh token.
    return { caller: nobody, set: clearCookies() };
  }

  // 2. No usable session: try the refresh token.
  const [id, token] = (cookies.refresh ?? '').split('.');
  if (!id || !token) return { caller: nobody, set: [] };
  const d = await device(db, id);
  if (!live(d, now)) return { caller: nobody, set: clearCookies() };
  const presented = await hashToken(token);

  if (timingSafeEqual(presented, d.refresh_hash)) {
    // Renew: one atomic update, which only one of two racing requests can win.
    const next = randomToken(32);
    const expires = d.share_id ? Math.min(now + REFRESH_S, d.expires_at) : now + REFRESH_S;
    const res = await db
      .prepare(
        `UPDATE auth_devices SET refresh_hash = ?3, prev_hash = refresh_hash, rotated_at = ?4, last_seen_at = ?4, expires_at = ?5
         WHERE id = ?1 AND refresh_hash = ?2 AND revoked_at IS NULL`,
      )
      .bind(d.id, presented, await hashToken(next), now, expires)
      .run();
    if ((res.meta.changes ?? 0) > 0) {
      return {
        caller: { role: d.role, deviceId: d.id, via: 'refresh' },
        set: [
          { name: SESSION_COOKIE, value: await makeSession(secret, d.id, d.role, now), maxAge: SESSION_S },
          { name: REFRESH_COOKIE, value: `${d.id}.${next}`, maxAge: expires - now },
        ],
      };
    }
    // Another request renewed it a moment ago; the check below lets this one in.
  }

  const fresh = await device(db, id);
  if (!live(fresh, now)) return { caller: nobody, set: clearCookies() };
  if (fresh.prev_hash && timingSafeEqual(presented, fresh.prev_hash)) {
    if (now - fresh.rotated_at <= GRACE_S) {
      // The other tab's renewal has set the new refresh token; this one only
      // needs a session, and must not overwrite the refresh cookie.
      return {
        caller: { role: fresh.role, deviceId: fresh.id, via: 'refresh' },
        set: [{ name: SESSION_COOKIE, value: await makeSession(secret, fresh.id, fresh.role, now), maxAge: SESSION_S }],
      };
    }
    // The token the real browser gave up long ago, back again: a copy.
    await revokeDevice(db, fresh.id, now);
    console.warn(JSON.stringify({ auth: 'refresh-token-reused', device: fresh.id.slice(0, 6) }));
    return { caller: nobody, set: clearCookies() };
  }
  // Neither token: an old cookie from before some other renewal. Not proof of a
  // copy (a browser restored from a backup does this), so it is only refused.
  return { caller: nobody, set: clearCookies() };
}

// ---------------------------------------------------------------- the owner

export interface OwnerRow {
  password: string | null;
  require_sign_in: number;
  updated_at: number;
}

export async function owner(db: D1Database): Promise<OwnerRow | null> {
  return db.prepare('SELECT password, require_sign_in, updated_at FROM auth_owner WHERE id = 1').first<OwnerRow>();
}

export async function passkeyCount(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM auth_passkeys').first<{ n: number }>();
  return row?.n ?? 0;
}

/** Set or replace the owner's password (already hashed). */
export async function setPassword(db: D1Database, stored: string | null, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO auth_owner (id, password, require_sign_in, updated_at) VALUES (1, ?1, 0, ?2)
       ON CONFLICT(id) DO UPDATE SET password = excluded.password, updated_at = excluded.updated_at`,
    )
    .bind(stored, now)
    .run();
}

/** Turn "require sign-in to view" on or off. */
export async function setRequired(db: D1Database, on: boolean, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO auth_owner (id, password, require_sign_in, updated_at) VALUES (1, NULL, ?1, ?2)
       ON CONFLICT(id) DO UPDATE SET require_sign_in = excluded.require_sign_in, updated_at = excluded.updated_at`,
    )
    .bind(on ? 1 : 0, now)
    .run();
}

// ---------------------------------------------------------------- share links

export interface ShareRow {
  id: string;
  name: string | null;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
}

/** Make a view-only link. Returns its id and the secret half, which is shown once. */
export async function createShare(db: D1Database, name: string | null, days: number | null, now: number): Promise<{ id: string; token: string }> {
  const id = randomToken(9);
  const secret = randomToken(24);
  await db
    .prepare('INSERT INTO auth_shares (id, token_hash, name, created_at, expires_at, revoked_at) VALUES (?1, ?2, ?3, ?4, ?5, NULL)')
    .bind(id, await hashToken(secret), name, now, days ? now + days * 86400 : null)
    .run();
  return { id, token: `${id}.${secret}` };
}

/** The share a link names, if it is real, in date and not revoked. */
export async function openShare(db: D1Database, link: string, now: number): Promise<ShareRow | null> {
  const [id, secret] = link.split('.');
  if (!id || !secret) return null;
  const row = await db.prepare('SELECT * FROM auth_shares WHERE id = ?1').bind(id).first<ShareRow & { token_hash: string }>();
  if (!row || row.revoked_at != null || (row.expires_at != null && row.expires_at <= now)) return null;
  if (!timingSafeEqual(await hashToken(secret), row.token_hash)) return null;
  return row;
}

/** Revoke a link, and sign out everyone who came in through it. */
export async function revokeShare(db: D1Database, id: string, now: number): Promise<boolean> {
  const res = await db.prepare('UPDATE auth_shares SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL').bind(id, now).run();
  await db.prepare('UPDATE auth_devices SET revoked_at = ?2 WHERE share_id = ?1 AND revoked_at IS NULL').bind(id, now).run();
  return (res.meta.changes ?? 0) > 0;
}

export async function listShares(db: D1Database, now: number): Promise<(ShareRow & { devices: number })[]> {
  const { results } = await db
    .prepare(
      `SELECT s.id, s.name, s.created_at, s.expires_at, s.revoked_at,
              (SELECT COUNT(*) FROM auth_devices d WHERE d.share_id = s.id AND d.revoked_at IS NULL AND d.expires_at > ?1) AS devices
       FROM auth_shares s
       WHERE s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?1)
       ORDER BY s.created_at DESC`,
    )
    .bind(now)
    .all<ShareRow & { devices: number }>();
  return results;
}

// ---------------------------------------------------------------- the lockout

/** Failures from one caller before it is locked out, and for how long. */
export const CALLER_FAILS = 5;
export const CALLER_LOCK_S = 15 * 60;
/** Failures from everyone together in an hour before password sign-in pauses for all. */
export const GLOBAL_FAILS = 30;
export const GLOBAL_LOCK_S = 3600;

/**
 * Whether a caller may try a password or a setup code right now. Checked
 * before the attempt, so a locked-out caller spends no hashing on the Worker.
 *
 * Two limits: five wrong tries from one address lock that address out for a
 * quarter of an hour, and thirty from all addresses together in an hour pause
 * password sign-in for everyone for an hour - which is what stops a guesser
 * with many addresses. A passkey is not a guess and is never locked out, so
 * the owner can always get in with one while a lock is on.
 */
export async function lockedUntil(db: D1Database, ipKey: string, now: number): Promise<number | null> {
  const { results } = await db
    .prepare('SELECT key, locked_until FROM auth_attempts WHERE key IN (?1, ?2)')
    .bind(ipKey, 'all')
    .all<{ key: string; locked_until: number | null }>();
  const until = Math.max(0, ...results.map((r) => r.locked_until ?? 0));
  return until > now ? until : null;
}

/** Count one failure against the caller and against everyone, locking when a limit is reached. */
export async function recordFailure(db: D1Database, ipKey: string, now: number): Promise<void> {
  for (const [key, max, window, lock] of [[ipKey, CALLER_FAILS, CALLER_LOCK_S, CALLER_LOCK_S], ['all', GLOBAL_FAILS, 3600, GLOBAL_LOCK_S]] as const) {
    await db
      .prepare(
        `INSERT INTO auth_attempts (key, fails, window_start, locked_until) VALUES (?1, 1, ?2, NULL)
         ON CONFLICT(key) DO UPDATE SET
           fails        = CASE WHEN auth_attempts.window_start < ?2 - ?4 THEN 1 ELSE auth_attempts.fails + 1 END,
           window_start = CASE WHEN auth_attempts.window_start < ?2 - ?4 THEN ?2 ELSE auth_attempts.window_start END,
           locked_until = CASE WHEN (CASE WHEN auth_attempts.window_start < ?2 - ?4 THEN 1 ELSE auth_attempts.fails + 1 END) >= ?3
                               THEN ?2 + ?5 ELSE auth_attempts.locked_until END`,
      )
      .bind(key, now, max, window, lock)
      .run();
  }
}

/** A success forgives the caller's earlier failures. */
export async function forgiveCaller(db: D1Database, ipKey: string): Promise<void> {
  await db.prepare('DELETE FROM auth_attempts WHERE key = ?1').bind(ipKey).run();
}

/** The key a caller is counted under: a hash of its address, never the address. */
export async function callerKey(ip: string | undefined): Promise<string> {
  return `ip:${(await hashToken(ip ?? 'unknown')).slice(0, 24)}`;
}

// ---------------------------------------------------------------- passkey challenges

export const CHALLENGE_S = 300;

export async function newChallenge(db: D1Database, kind: 'register' | 'login', now: number): Promise<string> {
  const challenge = randomToken(32);
  // Challenges nobody finished are cleared as new ones are made.
  await db.prepare('DELETE FROM auth_challenges WHERE created_at < ?1').bind(now - CHALLENGE_S).run();
  await db.prepare('INSERT INTO auth_challenges (challenge, kind, created_at) VALUES (?1, ?2, ?3)').bind(challenge, kind, now).run();
  return challenge;
}

/** Use a challenge up: true if it was issued for this kind of ceremony, in the last five minutes. */
export async function takeChallenge(db: D1Database, challenge: string, kind: 'register' | 'login', now: number): Promise<boolean> {
  const res = await db
    .prepare('DELETE FROM auth_challenges WHERE challenge = ?1 AND kind = ?2 AND created_at >= ?3')
    .bind(challenge, kind, now - CHALLENGE_S)
    .run();
  return (res.meta.changes ?? 0) > 0;
}
