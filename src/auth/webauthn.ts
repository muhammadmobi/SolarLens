/**
 * Passkeys: registering one, and signing in with one (WebAuthn level 2).
 *
 * A passkey is a key pair made by the owner's phone, laptop or security key.
 * The private half never leaves that device, which unlocks it with a
 * fingerprint, a face or a PIN; SolarLens keeps only the public half. Signing
 * in is the device signing a fresh random challenge, which this checks against
 * the stored public key - so there is no shared secret to steal, phish or
 * reuse, and nothing in the database would sign anyone in.
 *
 * Written out here rather than taken from a library, to keep the Worker free of
 * dependencies, and because the part a server needs is small: read the CBOR the
 * browser sends, check the challenge, the origin, the relying party and the
 * flags, and verify one signature. Attestation - proof of what make of
 * authenticator it is - is not asked for ("none"): an owner's own device is
 * trusted to be theirs.
 *
 * Two signature schemes are accepted: ES256 (P-256), which nearly everything
 * uses, and RS256, which older Windows Hello still does.
 */
import { b64url, fromB64url, sha256 } from './crypto';

/** COSE algorithm ids, as WebAuthn names them. */
export const ES256 = -7;
export const RS256 = -257;

// ---------------------------------------------------------------- CBOR

/**
 * Just enough CBOR (RFC 8949) for WebAuthn: integers, byte and text strings,
 * arrays, maps, and the simple values. Returns the value and where it ended,
 * since authenticator data carries a CBOR key followed by more bytes.
 */
export function decodeCbor(bytes: Uint8Array, start = 0): { value: unknown; end: number } {
  let pos = start;
  const byte = () => {
    if (pos >= bytes.length) throw new Error('CBOR: ran out of bytes');
    return bytes[pos++];
  };
  const length = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) return byte();
    if (info === 25) return (byte() << 8) | byte();
    if (info === 26) return ((byte() << 24) >>> 0) + ((byte() << 16) | (byte() << 8) | byte());
    if (info === 27) {
      let n = 0;
      for (let i = 0; i < 8; i++) n = n * 256 + byte();
      return n;
    }
    throw new Error('CBOR: indefinite lengths are not used by WebAuthn');
  };
  const item = (): unknown => {
    const head = byte();
    const major = head >> 5;
    const info = head & 31;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22 || info === 23) return null;
      throw new Error('CBOR: floats are not used by WebAuthn');
    }
    const n = length(info);
    switch (major) {
      case 0: return n;
      case 1: return -1 - n;
      case 2: {
        if (pos + n > bytes.length) throw new Error('CBOR: ran out of bytes');
        const out = bytes.slice(pos, pos + n);
        pos += n;
        return out;
      }
      case 3: {
        if (pos + n > bytes.length) throw new Error('CBOR: ran out of bytes');
        const out = new TextDecoder().decode(bytes.slice(pos, pos + n));
        pos += n;
        return out;
      }
      case 4: return Array.from({ length: n }, item);
      case 5: {
        const map = new Map<unknown, unknown>();
        for (let i = 0; i < n; i++) map.set(item(), item());
        return map;
      }
      default: throw new Error('CBOR: tags are not used by WebAuthn');
    }
  };
  const value = item();
  return { value, end: pos };
}

// ---------------------------------------------------------------- authenticator data

/** The parts of authenticator data this reads. */
export interface AuthData {
  rpIdHash: Uint8Array;
  userPresent: boolean;
  userVerified: boolean;
  signCount: number;
  /** Present when a credential was just made. */
  credential?: { id: Uint8Array; publicKey: Map<unknown, unknown> };
}

/**
 * Authenticator data: 32 bytes of relying-party hash, a flags byte, a 4-byte
 * signature counter, then - when the AT flag is set - the new credential's
 * AAGUID, its id and its public key as a CBOR map.
 */
export function parseAuthData(data: Uint8Array): AuthData {
  if (data.length < 37) throw new Error('authenticator data is too short');
  const flags = data[32];
  const out: AuthData = {
    rpIdHash: data.slice(0, 32),
    userPresent: (flags & 0x01) !== 0,
    userVerified: (flags & 0x04) !== 0,
    signCount: ((data[33] << 24) >>> 0) + ((data[34] << 16) | (data[35] << 8) | data[36]),
  };
  if (flags & 0x40) {
    let pos = 37 + 16; // after the AAGUID
    const idLen = (data[pos] << 8) | data[pos + 1];
    pos += 2;
    const id = data.slice(pos, pos + idLen);
    pos += idLen;
    const { value } = decodeCbor(data, pos);
    if (!(value instanceof Map)) throw new Error('the credential public key is not a CBOR map');
    out.credential = { id, publicKey: value };
  }
  return out;
}

// ---------------------------------------------------------------- keys

/** A stored public key: a JWK, and the COSE algorithm it signs with. */
export interface StoredKey {
  alg: number;
  jwk: JsonWebKey;
}

/** A COSE public key (RFC 9053) as a JWK WebCrypto can import. */
export function coseToJwk(cose: Map<unknown, unknown>): StoredKey {
  const kty = cose.get(1);
  const alg = cose.get(3);
  if (kty === 2 && alg === ES256 && cose.get(-1) === 1) {
    const x = cose.get(-2), y = cose.get(-3);
    if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array)) throw new Error('an EC key without coordinates');
    return { alg: ES256, jwk: { kty: 'EC', crv: 'P-256', x: b64url(x), y: b64url(y) } };
  }
  if (kty === 3 && alg === RS256) {
    const n = cose.get(-1), e = cose.get(-2);
    if (!(n instanceof Uint8Array) || !(e instanceof Uint8Array)) throw new Error('an RSA key without modulus');
    return { alg: RS256, jwk: { kty: 'RSA', n: b64url(n), e: b64url(e), alg: 'RS256' } };
  }
  throw new Error('a passkey type this server does not accept; ES256 and RS256 are');
}

/**
 * WebAuthn's ES256 signatures are DER, and WebCrypto wants the two 32-byte
 * halves side by side. Each half may carry a leading zero (to keep it positive)
 * or be short, so each is trimmed or padded to 32 bytes.
 */
export function derToRaw(der: Uint8Array): Uint8Array<ArrayBuffer> {
  if (der[0] !== 0x30) throw new Error('not a DER signature');
  let pos = 2;
  const part = () => {
    if (der[pos] !== 0x02) throw new Error('not a DER integer');
    const len = der[pos + 1];
    let v = der.slice(pos + 2, pos + 2 + len);
    pos += 2 + len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const r = part(), s = part();
  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
}

async function verifySignature(key: StoredKey, signature: Uint8Array<ArrayBuffer>, data: BufferSource): Promise<boolean> {
  if (key.alg === ES256) {
    const k = await crypto.subtle.importKey('jwk', key.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, derToRaw(signature), data);
  }
  if (key.alg === RS256) {
    const k = await crypto.subtle.importKey('jwk', key.jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return crypto.subtle.verify('RSASSA-PKCS1-v1_5', k, signature, data);
  }
  return false;
}

// ---------------------------------------------------------------- the two ceremonies

/** Where the ceremony is happening: this Worker's hostname and origin. */
export interface RelyingParty {
  id: string;
  origin: string;
}

/** What the browser's clientDataJSON says, checked against what was asked. */
function checkClientData(json: Uint8Array, type: string, challenge: string, rp: RelyingParty): void {
  let data: { type?: unknown; challenge?: unknown; origin?: unknown };
  try { data = JSON.parse(new TextDecoder().decode(json)); } catch { throw new Error('client data is not JSON'); }
  if (data.type !== type) throw new Error(`expected ${type}`);
  if (data.challenge !== challenge) throw new Error('the challenge does not match');
  // A passkey made for this site cannot be used from another: the browser
  // writes the real origin here, and a page elsewhere cannot change it.
  if (data.origin !== rp.origin) throw new Error('the origin does not match');
}

async function checkRp(auth: AuthData, rp: RelyingParty): Promise<void> {
  const want = await sha256(rp.id);
  if (auth.rpIdHash.length !== want.length || auth.rpIdHash.some((b, i) => b !== want[i])) {
    throw new Error('the passkey is for a different site');
  }
  if (!auth.userPresent) throw new Error('nobody touched the authenticator');
}

/** What the browser sends back from navigator.credentials.create(). */
export interface RegistrationResponse {
  clientDataJSON: string;
  attestationObject: string;
}

/**
 * Check a new passkey and return what to store: its id and public key. Throws,
 * with the reason, on anything that does not hold.
 */
export async function verifyRegistration(res: RegistrationResponse, challenge: string, rp: RelyingParty): Promise<{ id: string; key: StoredKey; signCount: number }> {
  checkClientData(fromB64url(res.clientDataJSON), 'webauthn.create', challenge, rp);
  const { value } = decodeCbor(fromB64url(res.attestationObject));
  if (!(value instanceof Map)) throw new Error('the attestation is not a CBOR map');
  const authData = value.get('authData');
  if (!(authData instanceof Uint8Array)) throw new Error('the attestation has no authenticator data');
  const auth = parseAuthData(authData);
  await checkRp(auth, rp);
  if (!auth.credential) throw new Error('no credential was made');
  return { id: b64url(auth.credential.id), key: coseToJwk(auth.credential.publicKey), signCount: auth.signCount };
}

/** What the browser sends back from navigator.credentials.get(). */
export interface AssertionResponse {
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}

/**
 * Check a sign-in: the challenge and origin, the site, the signature over the
 * authenticator data and the hash of the client data, and the counter.
 *
 * The counter only means something when the authenticator keeps one: many
 * passkeys synced between devices always report zero. Where both the stored
 * and the new count are above zero, the new one must be higher - otherwise
 * two copies of the key exist, and this one is refused.
 */
export async function verifyAssertion(res: AssertionResponse, challenge: string, rp: RelyingParty, key: StoredKey, storedCount: number): Promise<{ signCount: number }> {
  const clientData = fromB64url(res.clientDataJSON);
  checkClientData(clientData, 'webauthn.get', challenge, rp);
  const authData = fromB64url(res.authenticatorData);
  const auth = parseAuthData(authData);
  await checkRp(auth, rp);
  const signed = new Uint8Array(authData.length + 32);
  signed.set(authData, 0);
  signed.set(await sha256(clientData), authData.length);
  if (!(await verifySignature(key, fromB64url(res.signature), signed))) throw new Error('the signature does not verify');
  if (storedCount > 0 && auth.signCount > 0 && auth.signCount <= storedCount) {
    throw new Error('the signature counter went backwards: this passkey may have been copied');
  }
  return { signCount: auth.signCount };
}
