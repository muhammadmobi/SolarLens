/**
 * A relay's report about itself, checked before anything is stored.
 *
 * The body comes from a script on somebody's laptop, so every field is
 * validated to a narrow shape: a random hex id, an optional short nickname, one
 * of three states, and a login expiry that is a plausible date. Nothing free
 * text reaches the public page except the nickname, and that is cut down to
 * letters, digits and a little punctuation.
 */
export type RelayState = 'ok' | 'login-expired' | 'error';

export interface RelayStatus {
  id: string;
  provider: 'soliscloud';
  name: string | null;
  state: RelayState;
  loginExpiresAt: number | null;
}

const STATES: readonly RelayState[] = ['ok', 'login-expired', 'error'];
const DAY = 86400;

export function parseRelayStatus(body: unknown, now: number): RelayStatus | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  if (b.provider !== 'soliscloud') return { error: 'provider must be soliscloud' };
  if (typeof b.id !== 'string' || !/^[a-f0-9]{16}$/.test(b.id)) return { error: 'id must be 16 hex characters' };
  if (typeof b.state !== 'string' || !STATES.includes(b.state as RelayState)) {
    return { error: `state must be one of ${STATES.join(', ')}` };
  }

  let name: string | null = null;
  if (b.name != null) {
    if (typeof b.name !== 'string') return { error: 'name must be text' };
    name = b.name.replace(/[^\p{L}\p{N} ._'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40) || null;
  }

  let loginExpiresAt: number | null = null;
  if (b.loginExpiresAt != null) {
    const t = Number(b.loginExpiresAt);
    // A SolisCloud login lasts a week. Anything a month past or more than a
    // year ahead is not a login expiry, whatever sent it.
    if (!Number.isFinite(t) || t < now - 30 * DAY || t > now + 400 * DAY) {
      return { error: 'loginExpiresAt is not a plausible login expiry' };
    }
    loginExpiresAt = Math.floor(t);
  }

  return { id: b.id, provider: 'soliscloud', name, state: b.state as RelayState, loginExpiresAt };
}
