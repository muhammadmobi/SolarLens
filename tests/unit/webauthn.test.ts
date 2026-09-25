/**
 * Passkey verification, against real signatures.
 *
 * tests/helpers/passkey.ts plays the authenticator with genuine P-256 and RSA
 * keys, so each check below is the server refusing or accepting what a real
 * device would send - and each refusal is one an attacker would try: a
 * challenge replayed, a page on another origin, a passkey made for another
 * site, a signature that is not the key's, a counter that went backwards.
 */
import { describe, expect, it } from 'vitest';
import { b64url, fromB64url } from '../../src/auth/crypto';
import { coseToJwk, decodeCbor, derToRaw, parseAuthData, verifyAssertion, verifyRegistration } from '../../src/auth/webauthn';
import { authenticator, encodeCbor, rawToDer } from '../helpers/passkey';

const rp = { id: 'dashboard.test', origin: 'https://dashboard.test' };
const challenge = b64url(crypto.getRandomValues(new Uint8Array(32)));

describe('CBOR', () => {
  it('reads every kind of item WebAuthn uses', () => {
    const value = new Map<unknown, unknown>([
      [1, 2], [-1, 'text'], ['b', new Uint8Array([1, 2, 3])], ['list', [true, false, null]], ['big', 70000],
    ]);
    const { value: back } = decodeCbor(encodeCbor(value as never));
    expect(back).toEqual(value);
  });

  it('refuses what WebAuthn never sends, and truncated input', () => {
    expect(() => decodeCbor(new Uint8Array([0xf9, 0, 0]))).toThrow(/floats/);
    expect(() => decodeCbor(new Uint8Array([0x5f]))).toThrow(/indefinite/);
    expect(() => decodeCbor(new Uint8Array([0xc0, 0]))).toThrow(/tags/);
    expect(() => decodeCbor(new Uint8Array([0x43, 1]))).toThrow(/ran out/);
    expect(() => decodeCbor(new Uint8Array([0x63, 0x61]))).toThrow(/ran out/);
    expect(() => decodeCbor(new Uint8Array([]))).toThrow(/ran out/);
  });

  it('reads the long length forms', () => {
    expect(decodeCbor(new Uint8Array([0x1b, 0, 0, 0, 1, 0, 0, 0, 0])).value).toBe(2 ** 32);
    expect(decodeCbor(new Uint8Array([0x19, 1, 0])).value).toBe(256);
  });
});

describe('ES256 signatures', () => {
  it('turns DER into the r || s WebCrypto wants, whatever the padding', () => {
    for (let i = 0; i < 50; i++) {
      const raw = crypto.getRandomValues(new Uint8Array(64));
      if (i % 5 === 0) raw[0] = 0;          // a short r
      if (i % 7 === 0) raw[32] = 0x80;      // an s that needs a leading zero
      expect(derToRaw(rawToDer(raw))).toEqual(raw);
    }
  });
  it('refuses what is not DER', () => {
    expect(() => derToRaw(new Uint8Array([0x31, 0]))).toThrow(/DER/);
    expect(() => derToRaw(new Uint8Array([0x30, 4, 0x03, 0]))).toThrow(/integer/);
  });
});

describe('public keys', () => {
  it('refuses a key type this server does not accept', () => {
    expect(() => coseToJwk(new Map([[1, 1], [3, -8]]))).toThrow(/ES256 and RS256/);
    expect(() => coseToJwk(new Map<unknown, unknown>([[1, 2], [3, -7], [-1, 1]]))).toThrow(/coordinates/);
    expect(() => coseToJwk(new Map<unknown, unknown>([[1, 3], [3, -257]]))).toThrow(/modulus/);
  });
  it('refuses authenticator data too short to be real', () => {
    expect(() => parseAuthData(new Uint8Array(10))).toThrow(/short/);
  });
});

for (const alg of ['ES256', 'RS256'] as const) {
  describe(`a ${alg} passkey`, () => {
    it('registers, then signs in', async () => {
      const a = await authenticator(alg);
      const made = await verifyRegistration(await a.register(challenge, rp.origin, rp.id), challenge, rp);
      expect(made.id).toBe(b64url(a.id));
      const { signCount } = await verifyAssertion(await a.sign(challenge, rp.origin, rp.id), challenge, rp, made.key, made.signCount);
      expect(signCount).toBe(1);
    });

    it('refuses a signature from a different key', async () => {
      const a = await authenticator(alg);
      const other = await authenticator(alg);
      const made = await verifyRegistration(await a.register(challenge, rp.origin, rp.id), challenge, rp);
      await expect(verifyAssertion(await other.sign(challenge, rp.origin, rp.id), challenge, rp, made.key, 0)).rejects.toThrow(/does not verify/);
    });
  });
}

describe('what a sign-in is checked for', () => {
  async function setUp() {
    const a = await authenticator();
    const made = await verifyRegistration(await a.register(challenge, rp.origin, rp.id), challenge, rp);
    return { a, key: made.key };
  }

  it('the challenge this server issued', async () => {
    const { a, key } = await setUp();
    await expect(verifyAssertion(await a.sign('another', rp.origin, rp.id), challenge, rp, key, 0)).rejects.toThrow(/challenge/);
  });

  it('this origin, so a look-alike site cannot use it', async () => {
    const { a, key } = await setUp();
    await expect(verifyAssertion(await a.sign(challenge, 'https://dashboard.test.evil.example', rp.id), challenge, rp, key, 0)).rejects.toThrow(/origin/);
  });

  it('this site, in the authenticator data', async () => {
    const { a, key } = await setUp();
    await expect(verifyAssertion(await a.sign(challenge, rp.origin, 'elsewhere.test'), challenge, rp, key, 0)).rejects.toThrow(/different site/);
  });

  it('a person touching the authenticator', async () => {
    const { a, key } = await setUp();
    await expect(verifyAssertion(await a.sign(challenge, rp.origin, rp.id, { flags: 0 }), challenge, rp, key, 0)).rejects.toThrow(/touched/);
  });

  it('a sign-in, not a registration replayed', async () => {
    const { a, key } = await setUp();
    await expect(verifyAssertion(await a.sign(challenge, rp.origin, rp.id, { type: 'webauthn.create' }), challenge, rp, key, 0)).rejects.toThrow(/webauthn.get/);
  });

  it('a counter that moved forward, when the authenticator keeps one', async () => {
    const { a, key } = await setUp();
    await expect(verifyAssertion(await a.sign(challenge, rp.origin, rp.id, { counter: 5 }), challenge, rp, key, 9)).rejects.toThrow(/copied/);
    // A synced passkey reports zero every time, and that is fine.
    await expect(verifyAssertion(await a.sign(challenge, rp.origin, rp.id, { counter: 0 }), challenge, rp, key, 9)).resolves.toEqual({ signCount: 0 });
  });

  it('client data that is JSON', async () => {
    const { a, key } = await setUp();
    const res = await a.sign(challenge, rp.origin, rp.id);
    await expect(verifyAssertion({ ...res, clientDataJSON: b64url(new TextEncoder().encode('not json')) }, challenge, rp, key, 0)).rejects.toThrow(/JSON/);
  });
});

describe('what a registration is checked for', () => {
  it('that a credential was made at all', async () => {
    const a = await authenticator();
    await expect(verifyRegistration(await a.register(challenge, rp.origin, rp.id, { flags: 0x05 }), challenge, rp)).rejects.toThrow(/no credential/);
  });

  it('an attestation that is a map with authenticator data', async () => {
    const a = await authenticator();
    const res = await a.register(challenge, rp.origin, rp.id);
    await expect(verifyRegistration({ ...res, attestationObject: b64url(encodeCbor([1, 2])) }, challenge, rp)).rejects.toThrow(/CBOR map/);
    await expect(verifyRegistration({ ...res, attestationObject: b64url(encodeCbor(new Map([['fmt', 'none']]))) }, challenge, rp)).rejects.toThrow(/authenticator data/);
  });

  it('a public key that is a map', async () => {
    const a = await authenticator();
    const res = await a.register(challenge, rp.origin, rp.id);
    const att = decodeCbor(fromB64url(res.attestationObject)).value as Map<string, Uint8Array>;
    const data = att.get('authData') as Uint8Array;
    // Replace the COSE map after the credential id with a CBOR array.
    const bad = new Uint8Array([...data.slice(0, 37 + 16 + 2 + 16), ...encodeCbor([1])]);
    const tampered = b64url(encodeCbor(new Map<never, never>([['fmt', 'none'], ['attStmt', new Map()], ['authData', bad]] as never)));
    await expect(verifyRegistration({ ...res, attestationObject: tampered }, challenge, rp)).rejects.toThrow(/not a CBOR map/);
  });
});
