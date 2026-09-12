import { describe, expect, it } from 'vitest';
import { tzOffsetSec } from '../../src/providers/units';
import { dayStartSec } from '../../src/db';

describe('tzOffsetSec', () => {
  it('reads SolisCloud whole hours', () => {
    expect(tzOffsetSec({ timeZone: 5 })).toBe(5 * 3600);
    expect(tzOffsetSec({ timeZone: -8 })).toBe(-8 * 3600);
  });

  it('reads a seconds offset, and prefers it over the hours field', () => {
    expect(tzOffsetSec({ timeZoneOffset: 18000 })).toBe(18000);
    // Both present and disagreeing: seconds are the more precise statement,
    // and a half-hour zone cannot be expressed in the whole-hours field at all.
    expect(tzOffsetSec({ timeZoneOffset: 19800, timeZone: 5 })).toBe(19800);
  });

  it('resolves an IANA name', () => {
    // Karachi has no daylight saving, so this is stable whenever it runs.
    expect(tzOffsetSec({ timezone: 'Asia/Karachi' })).toBe(5 * 3600);
    expect(tzOffsetSec({ regionTimezone: 'Asia/Karachi' })).toBe(5 * 3600);
    expect(tzOffsetSec({ timezone: 'UTC' })).toBeNull(); // no slash: not a zone path
  });

  it('handles a half-hour zone through the name', () => {
    expect(tzOffsetSec({ timezone: 'Asia/Kolkata' })).toBe(5.5 * 3600);
  });

  it('reads a zone that sits on Greenwich, where the label carries no sign', () => {
    // Intl renders UTC+0 as a bare "GMT", with no "+00:00" to parse - the one
    // shape that would fall through the sign branch if it were not handled.
    expect(tzOffsetSec({ timezone: 'Africa/Abidjan' })).toBe(0);
  });

  it('reads a zone west of Greenwich', () => {
    // Los Angeles is -8 in winter and -7 under daylight saving, and this runs
    // in both, so the assertion is the sign and the magnitude, not the hour.
    const off = tzOffsetSec({ timezone: 'America/Los_Angeles' });
    expect(off).toBeLessThan(0);
    expect(Math.abs(off as number)).toBeGreaterThanOrEqual(7 * 3600);
    expect(Math.abs(off as number)).toBeLessThanOrEqual(8 * 3600);
  });

  it('says nothing rather than guessing', () => {
    expect(tzOffsetSec({})).toBeNull();
    expect(tzOffsetSec({ timeZone: '' })).toBeNull();
    expect(tzOffsetSec({ timezone: 'Not/AZone' })).toBeNull();
    // Out of range values are a parse error somewhere upstream, not a plant
    // sixty hours from Greenwich.
    expect(tzOffsetSec({ timeZone: 60 })).toBeNull();
    expect(tzOffsetSec({ timeZoneOffset: 999_999 })).toBeNull();
  });
});

describe('dayStartSec', () => {
  const noon = Date.UTC(2026, 8, 12, 12, 0, 0) / 1000; // 2026-09-12 12:00 UTC

  it('is midnight UTC at offset zero', () => {
    expect(dayStartSec(noon, 0)).toBe(Date.UTC(2026, 8, 12, 0, 0, 0) / 1000);
  });

  it('moves the boundary east with the plant', () => {
    // 12:00 UTC is 17:00 in +05:00, so the day began at 19:00 UTC yesterday.
    expect(dayStartSec(noon, 5 * 3600)).toBe(Date.UTC(2026, 8, 11, 19, 0, 0) / 1000);
  });

  it('moves it west too', () => {
    // 12:00 UTC is 04:00 in -08:00, so the day began at 08:00 UTC today.
    expect(dayStartSec(noon, -8 * 3600)).toBe(Date.UTC(2026, 8, 12, 8, 0, 0) / 1000);
  });

  it('never returns a start in the future', () => {
    for (const off of [-14, -5.5, 0, 5.5, 14].map((h) => h * 3600)) {
      const start = dayStartSec(noon, off);
      expect(start).toBeLessThanOrEqual(noon);
      expect(noon - start).toBeLessThan(86400);
    }
  });
});
