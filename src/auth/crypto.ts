/**
 * The small pieces of cryptography the owner login is built from.
 *
 * Everything here is WebCrypto, which the Workers runtime provides natively,
 * so the login adds no dependency. Three jobs:
 *
 * - random tokens, and their SHA-256 hashes: a refresh token, a share link and
 *   a WebAuthn challenge are random, and only a hash of a token is ever stored,
 *   so a copy of the database signs nobody in;
 * - signing: the one-hour session cookie is an HMAC over who it is for and when
 *   it ends, keyed from API_TOKEN, so it cannot be forged or stretched;
 * - the password: PBKDF2, then an HMAC with a key the database never sees.
 */

const enc = new TextEncoder();

/** Bytes as base64url with no padding: what cookies, URLs and WebAuthn use. */
export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url (or plain base64) back to bytes. Throws on something that is neither. */
export function fromB64url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** `n` random bytes as base64url: 32 bytes is 256 bits, far past guessing. */
export function randomToken(n = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(n)));
}

/** SHA-256 of bytes. */
export async function sha256(data: BufferSource | string): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/** SHA-256 of a token, as hex - the form every stored token takes. */
export async function hashToken(token: string): Promise<string> {
  return [...(await sha256(token))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Compare two strings in time that does not depend on where they first differ,
 * so response timing cannot be used to guess a token one character at a time.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** An HMAC-SHA256 key, derived from a secret and a label so each use gets its own. */
async function hmacKey(secret: string, label: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const derived = await crypto.subtle.sign('HMAC', base, enc.encode(label));
  return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

/** HMAC-SHA256 of text under a key derived from `secret` for `label`, as base64url. */
export async function hmac(secret: string, label: string, text: string | BufferSource): Promise<string> {
  const key = await hmacKey(secret, label);
  return b64url(await crypto.subtle.sign('HMAC', key, typeof text === 'string' ? enc.encode(text) : text));
}

/**
 * How many PBKDF2 rounds a password gets.
 *
 * Lower than a password stored on its own would want, on purpose. A Worker on
 * the free plan has about 10 ms of CPU per request, and a hundred thousand
 * rounds is several times that. What makes the lower count safe is the pepper
 * below: the stored hash is keyed with a secret that lives in the Worker, not
 * the database, so a copy of the database cannot be attacked offline at all,
 * and an attack online meets the lockout in ./sessions long before the round
 * count matters. The count is stored with each hash, so it can be raised later
 * without anyone setting their password again.
 */
export const PASSWORD_ROUNDS = 10_000;

/** The fewest characters a password may have. Length is what makes a password strong. */
export const PASSWORD_MIN = 12;

/**
 * A password's stored form: PBKDF2-SHA256 with a random salt, then an HMAC of
 * that under a key derived from API_TOKEN (the "pepper"). Returned as
 * "pbkdf2$<rounds>$<salt>$<hash>".
 */
export async function hashPassword(password: string, pepper: string, rounds = PASSWORD_ROUNDS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${rounds}$${b64url(salt)}$${await derive(password, salt, rounds, pepper)}`;
}

/** Whether `password` matches a stored form made by hashPassword. */
export async function verifyPassword(password: string, stored: string, pepper: string): Promise<boolean> {
  const [scheme, roundsText, saltText, hash] = stored.split('$');
  const rounds = Number(roundsText);
  if (scheme !== 'pbkdf2' || !Number.isInteger(rounds) || rounds < 1 || !saltText || !hash) return false;
  return timingSafeEqual(await derive(password, fromB64url(saltText), rounds, pepper), hash);
}

async function derive(password: string, salt: BufferSource, rounds: number, pepper: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: rounds }, key, 256));
  return hmac(pepper, 'solarlens password v1', bits);
}
