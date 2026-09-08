import { describe, expect, it } from 'vitest';
import { stripPii } from '../../src/providers/soliscloud';

/**
 * The vendor payloads carry the account holder's name and email, the site's
 * postal address and its coordinates. None of that is needed to monitor an
 * inverter, and all of it would otherwise sit in the raw telemetry table.
 *
 * The risk runs both ways, which is what these tests are for: too loose a
 * pattern and someone's email is on screen, too greedy a one and it silently
 * eats real measurements.
 */
describe('stripPii', () => {
  it('drops the account holder and the site location', () => {
    const clean = stripPii({
      stationName: 'Demo Plant',
      userId: '0000000000000000000',
      userName: 'someone',
      userEmail: 'someone@example.com',
      mobile: '+10000000000',
      installerMobile: '+10000000001',
      installerEmail: 'installer@example.com',
      latitude: '51.4779',
      longitude: '-0.0015',
      addr: '1 Example Street',
      addrDetail: 'Flat 2',
      picUrl: 'https://example.com/a.png',
      country: 'ZZ', countryStr: 'Exampleland',
      region: '1', regionStr: 'Example Region', regionShortName: 'ER',
      city: '2', cityStr: 'Somewhere', compatibleCityStr: 'Somewhere',
      county: '3', countyStr: 'Somewhere else',
    });
    expect(Object.keys(clean)).toEqual(['stationName']);
  });

  it('catches the camelCase spellings too', () => {
    // "oldUserId" slipped through a pattern that only knew "userId": the same
    // field, one capital letter later.
    expect(stripPii({ oldUserId: '1', UserName: 'x', installerEmail: 'a@b.c', ok: 1 })).toEqual({ ok: 1 });
  });

  it('keeps capacity, which merely contains the letters of "city"', () => {
    // A case-insensitive /city/ also matches "capaCITY". The old pattern was
    // deleting every capacity field from the payload it stored.
    const clean = stripPii({
      capacity: 12,
      capacityStr: 'kWp',
      capacityPercent: 73,
      capacityError: 0,
      batteryCapacityEnergy: 0,
      batteryCapacitySoc2: 0,
      inverterBatteryCapacityStr: 'kWh',
      isShowBatteryCapacity: false,
    });
    expect(Object.keys(clean)).toHaveLength(8);
    expect(clean.capacity).toBe(12);
  });

  it('keeps the diagnostics whose names merely start like an address', () => {
    // addrDataError is a fault flag, not a street - but it is genuinely
    // prefixed "addr", so this one is a deliberate accepted loss rather than
    // an accident. Documented here so the next person does not re-litigate it.
    expect(stripPii({ addrDataError: 0, dayEnergy: 39.6 })).toEqual({ dayEnergy: 39.6 });
  });

  it('reaches into nested objects and arrays', () => {
    const clean = stripPii({
      list: [{ sn: 'ABC', userEmail: 'a@b.c' }, { sn: 'DEF', latitude: '1' }],
      nested: { deep: { userName: 'x', power: 100 } },
    });
    expect(clean).toEqual({
      list: [{ sn: 'ABC' }, { sn: 'DEF' }],
      nested: { deep: { power: 100 } },
    });
  });

  it('leaves values alone - only key names decide', () => {
    // A plant legitimately named after a city keeps its name.
    expect(stripPii({ stationName: 'Lahore Rooftop' })).toEqual({ stationName: 'Lahore Rooftop' });
  });

  it('passes through primitives and null unchanged', () => {
    expect(stripPii(null)).toBeNull();
    expect(stripPii(42)).toBe(42);
    expect(stripPii('text')).toBe('text');
  });
});
