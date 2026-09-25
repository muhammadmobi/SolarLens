/**
 * A pretend authenticator, for testing passkeys without a browser.
 *
 * It does what a phone or a security key does: makes a key pair, reports the
 * public half as COSE inside CBOR attestation, and signs challenges - with a
 * real P-256 or RSA key from WebCrypto, so the server's verification is tested
 * against genuine signatures rather than stubs. The CBOR encoder is the
 * mirror of the server's decoder, and only as complete as WebAuthn needs.
 */
import { b64url, sha256 } from '../../src/auth/crypto';

type Cbor = number | string | Uint8Array | boolean | null | Cbor[] | Map<Cbor, Cbor>;

/** Encode a value as CBOR. */
export function encodeCbor(v: Cbor): Uint8Array {
  const out: number[] = [];
  const head = (major: number, n: number) => {
    if (n < 24) out.push((major << 5) | n);
    else if (n < 256) out.push((major << 5) | 24, n);
    else if (n < 65536) out.push((major << 5) | 25, n >> 8, n & 255);
    else out.push((major << 5) | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255);
  };
  const item = (x: Cbor) => {
    if (x === false) out.push(0xf4);
    else if (x === true) out.push(0xf5);
    else if (x === null) out.push(0xf6);
    else if (typeof x === 'number') (x >= 0 ? head(0, x) : head(1, -1 - x));
    else if (typeof x === 'string') { const b = new TextEncoder().encode(x); head(3, b.length); out.push(...b); }
    else if (x instanceof Uint8Array) { head(2, x.length); out.push(...x); }
    else if (Array.isArray(x)) { head(4, x.length); x.forEach(item); }
    else { head(5, x.size); for (const [k, val] of x) { item(k); item(val); } }
  };
  item(v);
  return new Uint8Array(out);
}

/** WebCrypto's P1363 signature (r || s) as the DER a browser sends. */
export function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let v = b;
    while (v.length > 1 && v[0] === 0 && !(v[1] & 0x80)) v = v.slice(1);
    if (v[0] & 0x80) v = new Uint8Array([0, ...v]);
    return [0x02, v.length, ...v];
  };
  const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}

const b64json = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

export interface Authenticator {
  id: Uint8Array;
  /** navigator.credentials.create(), answered. */
  register(challenge: string, origin: string, rpId: string, over?: { flags?: number; type?: string }): Promise<{ clientDataJSON: string; attestationObject: string }>;
  /** navigator.credentials.get(), answered. */
  sign(challenge: string, origin: string, rpId: string, over?: { flags?: number; counter?: number; type?: string }): Promise<{ clientDataJSON: string; authenticatorData: string; signature: string }>;
}

/** A new authenticator holding one key, ES256 unless asked for RS256. */
export async function authenticator(alg: 'ES256' | 'RS256' = 'ES256'): Promise<Authenticator> {
  const pair = alg === 'ES256'
    ? await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair
    : await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const bytes = (s: string | undefined) => Uint8Array.from(atob((s ?? '').replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - ((s ?? '').length % 4)) % 4)), (c) => c.charCodeAt(0));
  const cose = alg === 'ES256'
    ? new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, bytes(jwk.x)], [-3, bytes(jwk.y)]])
    : new Map<Cbor, Cbor>([[1, 3], [3, -257], [-1, bytes(jwk.n)], [-2, bytes(jwk.e)]]);
  const id = crypto.getRandomValues(new Uint8Array(16));
  let counter = 0;

  const authData = async (rpId: string, flags: number, count: number, withKey: boolean) => {
    const parts = [...(await sha256(rpId)), flags, (count >>> 24) & 255, (count >> 16) & 255, (count >> 8) & 255, count & 255];
    if (withKey) parts.push(...new Uint8Array(16), 0, id.length, ...id, ...encodeCbor(cose));
    return new Uint8Array(parts);
  };

  return {
    id,
    async register(challenge, origin, rpId, over = {}) {
      const clientDataJSON = b64json({ type: over.type ?? 'webauthn.create', challenge, origin });
      const data = await authData(rpId, over.flags ?? 0x45, 0, true);
      const attestationObject = b64url(encodeCbor(new Map<Cbor, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', data]])));
      return { clientDataJSON, attestationObject };
    },
    async sign(challenge, origin, rpId, over = {}) {
      counter = over.counter ?? counter + 1;
      const clientDataJSON = b64json({ type: over.type ?? 'webauthn.get', challenge, origin });
      const data = await authData(rpId, over.flags ?? 0x05, counter, false);
      const signed = new Uint8Array([...data, ...(await sha256(Uint8Array.from(atob(clientDataJSON.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (clientDataJSON.length % 4)) % 4)), (c) => c.charCodeAt(0))))]);
      const sig = alg === 'ES256'
        ? rawToDer(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, signed)))
        : new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, signed));
      return { clientDataJSON, authenticatorData: b64url(data), signature: b64url(sig) };
    },
  };
}
