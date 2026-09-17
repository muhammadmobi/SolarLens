import { describe, expect, it } from 'vitest';
import { parseRelayStatus } from '../../src/relays';
import { publicRelays } from '../../src/public-view';
import { loginExpiryFromCookies, onceExitCode, relayId, relayName, stateForError } from '../../agent/relay-status.mjs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOW = 1_790_000_000;
const DAY = 86400;
const ok = { provider: 'soliscloud', id: '0123456789abcdef', name: 'Office laptop', state: 'ok', loginExpiresAt: NOW + 6 * DAY };

describe('parseRelayStatus', () => {
  it('accepts a well-formed report', () => {
    expect(parseRelayStatus(ok, NOW)).toEqual({
      id: '0123456789abcdef', provider: 'soliscloud', name: 'Office laptop', state: 'ok', loginExpiresAt: NOW + 6 * DAY,
    });
  });

  it('accepts a report with no name and no expiry, as an expired login sends', () => {
    expect(parseRelayStatus({ ...ok, name: null, loginExpiresAt: null, state: 'login-expired' }, NOW))
      .toMatchObject({ name: null, loginExpiresAt: null, state: 'login-expired' });
  });

  it.each([
    ['a missing body', null],
    ['another provider', { ...ok, provider: 'solarman' }],
    ['an id that is not 16 hex characters', { ...ok, id: 'DESKTOP-ABC123' }],
    ['an unknown state', { ...ok, state: 'fine' }],
    ['a name that is not text', { ...ok, name: 42 }],
    ['an expiry a year and more ahead', { ...ok, loginExpiresAt: NOW + 401 * DAY }],
    ['an expiry long past', { ...ok, loginExpiresAt: NOW - 31 * DAY }],
    ['an expiry that is not a number', { ...ok, loginExpiresAt: 'soon' }],
  ])('refuses %s', (_label, body) => {
    expect(parseRelayStatus(body, NOW)).toHaveProperty('error');
  });

  it('cuts a nickname down to something safe to print', () => {
    const r = parseRelayStatus({ ...ok, name: '  <script>Home   PC</script>  ' }, NOW);
    expect(r).toMatchObject({ name: 'scriptHome PCscript' });
    const long = parseRelayStatus({ ...ok, name: 'x'.repeat(80) }, NOW);
    expect((long as { name: string }).name).toHaveLength(40);
    expect(parseRelayStatus({ ...ok, name: '<>' }, NOW)).toMatchObject({ name: null });
  });
});

describe('publicRelays', () => {
  const row = (id: string, name: string | null) => ({ id, name, state: 'ok', login_expires_at: NOW, first_seen: NOW, last_seen: NOW, last_ok_at: NOW });

  it('never lets a relay id out', () => {
    const out = publicRelays([row('0123456789abcdef', 'Home')]);
    expect(JSON.stringify(out)).not.toContain('0123456789abcdef');
    expect(out[0]).not.toHaveProperty('id');
  });

  it('names an unnamed relay by its order, and keeps a given nickname', () => {
    const out = publicRelays([row('a'.repeat(16), null), row('b'.repeat(16), 'Office laptop'), row('c'.repeat(16), null)]);
    expect(out.map((r) => r.name)).toEqual(['Relay 1', 'Office laptop', 'Relay 3']);
  });
});

describe('onceExitCode', () => {
  it('exits 3 when a person has to log in, so the scripts know to open a window', () => {
    expect(onceExitCode(new Error('session expired - run headed once to log in again'))).toBe(3);
    expect(onceExitCode(new Error('gave up waiting for login'))).toBe(3);
  });

  it('exits 1 for every other failure, including none given', () => {
    expect(onceExitCode(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe(1);
    expect(onceExitCode(new Error('browserType.launchPersistentContext: Target page, context or browser has been closed'))).toBe(1);
    expect(onceExitCode(undefined)).toBe(1);
  });
});

describe('relay-status helpers', () => {
  const cookie = (over: Record<string, unknown> = {}) => ({ name: 'token', domain: '.soliscloud.com', expires: NOW + 7 * DAY + 0.5, ...over });

  it('reads the login expiry from the portal\'s token cookie', () => {
    expect(loginExpiryFromCookies([{ name: '_ga', domain: '.soliscloud.com', expires: NOW + 400 * DAY }, cookie()]))
      .toBe(NOW + 7 * DAY);
  });

  it('ignores a token cookie from anywhere else, a session-only cookie, and no cookies', () => {
    expect(loginExpiryFromCookies([cookie({ domain: '.soliscloud.com.example.net' })])).toBeNull();
    expect(loginExpiryFromCookies([cookie({ expires: -1 })])).toBeNull();
    expect(loginExpiryFromCookies([])).toBeNull();
    expect(loginExpiryFromCookies(undefined)).toBeNull();
  });

  it('tells an expired login apart from any other failure', () => {
    expect(stateForError(new Error('session expired - run headed once to log in again'))).toBe('login-expired');
    expect(stateForError(new Error('gave up waiting for login'))).toBe('login-expired');
    expect(stateForError(new Error('detailMix for 1: no data'))).toBe('error');
    expect(stateForError(undefined)).toBe('error');
  });

  it('keeps one random id per relay, never the computer name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-id-'));
    try {
      const first = relayId(dir);
      expect(first).toMatch(/^[a-f0-9]{16}$/);
      expect(relayId(dir)).toBe(first);
      expect(readFileSync(join(dir, 'solarlens-relay-id'), 'utf8')).toBe(first);
      // A damaged id file is replaced rather than sent.
      writeFileSync(join(dir, 'solarlens-relay-id'), 'not-an-id');
      expect(relayId(dir)).toMatch(/^[a-f0-9]{16}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cleans a nickname the same way the Worker does', () => {
    expect(relayName('  Home   laptop ')).toBe('Home laptop');
    expect(relayName('')).toBeNull();
    expect(relayName(undefined)).toBeNull();
  });
});
