import { describe, expect, it } from 'vitest';
import { safeDetail } from '../../src/db';

/**
 * `poll_log` is the one place a vendor error message is persisted: it is kept
 * for a week, returned by `/api/health`, and printed in the dashboard footer.
 * So it is also the one place an accidental credential would sit in plain
 * sight, and the reason it might get there is mundane - SolarMan's token
 * endpoint takes the account's `appId` in the URL, so any failure whose Error
 * message quotes the URL brings it along.
 */
describe('safeDetail', () => {
  it('keeps the origin and path of a URL but drops the query', () => {
    expect(safeDetail('fetch failed: https://globalapi.solarmanpv.com/account/v1.0/token?appId=1234567890&language=en'))
      .toBe('fetch failed: https://globalapi.solarmanpv.com/account/v1.0/token?<redacted>');
  });

  it('redacts a bare parameter but keeps its name, for a path without an origin', () => {
    // The two rules differ on purpose. A full URL loses its whole query,
    // because it may carry parameters nobody here has thought of. A named
    // parameter loses only its value, which leaves the message useful to debug
    // with while the credential still goes.
    expect(safeDetail('solarman: HTTP 500 on /account/v1.0/token?appId=1234567890'))
      .toBe('solarman: HTTP 500 on /account/v1.0/token?appId=<redacted>');
  });

  it('covers the other names a credential travels under', () => {
    for (const key of ['appSecret', 'key', 'keyId', 'token', 'secret', 'password', 'sign', 'email']) {
      const out = safeDetail(`/x?${key}=SUPERSECRETVALUE`);
      expect(out, key).toContain('<redacted>');
      expect(out, key).not.toContain('SUPERSECRETVALUE');
    }
  });

  it('is case-insensitive about the parameter name', () => {
    expect(safeDetail('/x?APPID=abc123def')).not.toContain('abc123def');
  });

  it('leaves an ordinary message completely alone', () => {
    // The overwhelming majority of what goes through here is this, and a log
    // that mangles its own routine lines is worse than useless.
    const plain = 'plants=1 inverters=1 new=1 via soliscloud-relay';
    expect(safeDetail(plain)).toBe(plain);
    expect(safeDetail('soliscloud: HTTP 408 - clock skew >15 min')).toBe('soliscloud: HTTP 408 - clock skew >15 min');
    expect(safeDetail('solarman: /device/v1.0/currentData -> code=1005 msg=token invalid'))
      .toBe('solarman: /device/v1.0/currentData -> code=1005 msg=token invalid');
  });

  it('does not mistake a question mark in prose for a query string', () => {
    expect(safeDetail('is the datalogger online? unknown')).toBe('is the datalogger online? unknown');
  });
});
