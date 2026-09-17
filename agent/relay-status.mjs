/**
 * What a relay tells the Worker about itself: whether its SolisCloud login
 * still works, and exactly when that login runs out.
 *
 * A SolisCloud web login lasts seven days from the moment it is made, and
 * using it does not extend it. Measured on 2026-09-17: a login made at 14:53
 * UTC carried a `token` cookie expiring at 14:53 UTC seven days later, after a
 * relay had used it every five minutes in between. The login page carries
 * hCaptcha, so the relay cannot renew it on its own - a person has to. What
 * the relay can do is say when, early enough to matter: a hidden, headless
 * relay whose login has expired otherwise fails every cycle where nobody sees
 * it, and on the dashboard that looked exactly like the plant being down.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The login's own expiry, in epoch seconds, from the portal's `token` cookie; null when there is none. */
export function loginExpiryFromCookies(cookies) {
  const token = (cookies ?? []).find((c) =>
    c && c.name === 'token' && /(^|\.)soliscloud\.com$/i.test(String(c.domain ?? '')));
  return token && Number(token.expires) > 0 ? Math.floor(Number(token.expires)) : null;
}

/** 'login-expired' when the cycle failed for want of a login, otherwise 'error'. */
export function stateForError(err) {
  return /session expired|gave up waiting for login/i.test(String(err?.message ?? err ?? ''))
    ? 'login-expired'
    : 'error';
}

/**
 * A random id for this relay, kept beside its browser profile.
 *
 * Deliberately not the computer's name: a Windows hostname often carries a
 * company prefix and a person's user name, and the relay list is shown on a
 * public page. The id itself never leaves the Worker's database either; the
 * page names each relay by the nickname in RELAY_NAME, or "Relay 1", "Relay 2".
 */
export function relayId(profileDir) {
  const file = join(profileDir, 'solarlens-relay-id');
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (/^[a-f0-9]{16}$/.test(existing)) return existing;
  } catch { /* first run: no id yet */ }
  const id = randomBytes(8).toString('hex');
  try {
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(file, id);
  } catch { /* an id that cannot be saved still works for this run */ }
  return id;
}

/** RELAY_NAME, trimmed to something safe to print: letters, digits, spaces and a little punctuation. */
export function relayName(raw) {
  const name = String(raw ?? '').replace(/[^\p{L}\p{N} ._'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return name || null;
}
