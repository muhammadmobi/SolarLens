import { describe, expect, it } from 'vitest';
import { num, pick, toEpochSeconds, toKwh, toWatts } from '../../src/providers/units';

describe('toWatts', () => {
  it('scales by the vendor unit string', () => {
    expect(toWatts(1.01, 'kW')).toBe(1010);
    expect(toWatts(3.5, 'MW')).toBe(3_500_000);
    expect(toWatts(278, 'W')).toBe(278);
  });
  it('treats kWp / Wp capacity units like kW / W', () => {
    expect(toWatts(12, 'kWp')).toBe(12_000);
    expect(toWatts(400, 'Wp')).toBe(400);
  });
  it('is case- and whitespace-insensitive and accepts numeric strings', () => {
    expect(toWatts('1.5', ' KW ')).toBe(1500);
  });
  it('assumes watts when no unit is given rather than inventing a factor', () => {
    expect(toWatts(91)).toBe(91);
    expect(toWatts(91, 'bananas')).toBe(91);
  });
  it('returns null for empty or non-numeric input', () => {
    expect(toWatts(null, 'kW')).toBeNull();
    expect(toWatts('', 'kW')).toBeNull();
    expect(toWatts('n/a', 'kW')).toBeNull();
  });
});

describe('toKwh', () => {
  it('normalises Wh / kWh / MWh to kWh', () => {
    expect(toKwh(13.677, 'MWh')).toBeCloseTo(13677, 6);
    expect(toKwh(49, 'kWh')).toBe(49);
    expect(toKwh(500, 'Wh')).toBeCloseTo(0.5, 6);
  });
  it('passes through when no unit is given', () => {
    expect(toKwh(13.7)).toBe(13.7);
  });
});

describe('toEpochSeconds', () => {
  it('converts millisecond timestamps (SolisCloud) to seconds', () => {
    expect(toEpochSeconds('1788611283674')).toBe(1788611283);
    expect(toEpochSeconds(1788611283674)).toBe(1788611283);
  });
  it('keeps second timestamps (SolarMan) as they are', () => {
    expect(toEpochSeconds(1788610914)).toBe(1788610914);
  });
  it('falls back to now for missing or zero values', () => {
    const before = Math.floor(Date.now() / 1000);
    const got = toEpochSeconds(null);
    expect(got).toBeGreaterThanOrEqual(before);
    expect(toEpochSeconds(0)).toBeGreaterThanOrEqual(before);
  });
});

describe('num / pick', () => {
  it('num parses numbers and numeric strings, rejects the rest', () => {
    expect(num('12.5')).toBe(12.5);
    expect(num(7)).toBe(7);
    expect(num('')).toBeNull();
    expect(num(undefined)).toBeNull();
    expect(num('abc')).toBeNull();
  });
  it('pick returns the first key that is present and non-empty', () => {
    const o = { a: null, b: '', c: 0, d: 'x' };
    expect(pick(o, 'a', 'b', 'c', 'd')).toBe(0);
    expect(pick(o, 'a', 'b')).toBeNull();
    expect(pick(o, 'zzz', 'd')).toBe('x');
  });
});
