import { describe, expect, it, vi } from 'vitest';
import { coordsFromRaw, envCoords, fetchWeather, siteWeather, stampWeather } from '../../src/weather';
import { emptyMetrics, type Reading } from '../../src/providers/types';
import type { Env } from '../../src/db';

/**
 * The weather lookup is optional, billed per call, and sits in the middle of
 * the poll - so what matters is that it reads the vendor's coordinates
 * correctly, caches, and never takes the poll down with it when Google is slow
 * or unhappy.
 */

const KEY = 'test-key';
const AT = { lat: 51.4779, lon: -0.0015 };

const ok = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;
const fail = (status = 500) => ({ ok: false, status, json: async () => ({}) }) as unknown as Response;

const CURRENT = {
  weatherCondition: { description: { text: 'Clear' } },
  temperature: { degrees: 29.4, unit: 'CELSIUS' },
  timeZone: { id: 'Asia/Karachi' },
};
const FORECAST = {
  timeZone: { id: 'Asia/Karachi' },
  forecastDays: [{
    maxTemperature: { degrees: 31 },
    minTemperature: { degrees: 24 },
    // Google answers in UTC; Karachi is +05:00, so these are 05:45 and 18:25.
    sunEvents: { sunriseTime: '2026-09-08T00:45:00Z', sunsetTime: '2026-09-08T13:25:00Z' },
  }],
};

/** Enough of a D1 stub for the one cache row this module reads and writes. */
function fakeDb(seed: Record<string, { v: string; expires_at: number }> = {}) {
  const rows = { ...seed };
  const db = {
    writes: 0,
    prepare(sql: string) {
      const bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) { bound.push(...args); return stmt; },
        async first<T>() {
          const [k, now] = bound as [string, number];
          const hit = rows[k];
          return hit && hit.expires_at > now ? ({ v: hit.v } as T) : null;
        },
        async run() {
          db.writes++;
          const [k, v, exp] = bound as [string, string, number];
          if (sql.includes('INSERT')) rows[k] = { v, expires_at: exp };
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return db as unknown as D1Database & { writes: number };
}

describe('coordsFromRaw', () => {
  it('reads the strings SolisCloud ships with a station snapshot', () => {
    expect(coordsFromRaw({ latitude: '51.4779', longitude: '-0.0015' })).toEqual(AT);
  });

  it('accepts the shorter spellings other payloads use', () => {
    expect(coordsFromRaw({ lat: 51.5, lng: -0.12 })).toEqual({ lat: 51.5, lon: -0.12 });
  });

  it('returns nothing for a payload that carries none - SolarMan ships no coordinates', () => {
    expect(coordsFromRaw({ generationPower: 278 })).toBeNull();
    expect(coordsFromRaw(null)).toBeNull();
    expect(coordsFromRaw('not an object')).toBeNull();
  });

  it('treats 0,0 as the vendor\'s "unset" rather than a site in the Atlantic', () => {
    expect(coordsFromRaw({ latitude: '0', longitude: '0' })).toBeNull();
  });
});

describe('envCoords', () => {
  it('reads the fallback pair, for a provider that reports none', () => {
    expect(envCoords({ SITE_LAT: '33.5', SITE_LON: '73.2' } as Env)).toEqual({ lat: 33.5, lon: 73.2 });
  });

  it('needs both halves, and both to be numbers', () => {
    expect(envCoords({ SITE_LAT: '33.5' } as Env)).toBeNull();
    expect(envCoords({ SITE_LAT: 'north', SITE_LON: '73.2' } as Env)).toBeNull();
    expect(envCoords({} as Env)).toBeNull();
  });
});

describe('fetchWeather', () => {
  it('maps the two Google responses onto one shape, in the site\'s own timezone', async () => {
    const f = vi.fn(async (url: string) => ok(String(url).includes('forecast') ? FORECAST : CURRENT));
    const w = await fetchWeather(KEY, AT, f as unknown as typeof fetch);
    expect(w).toEqual({
      text: 'Clear', tempC: 29.4, tempMinC: 24, tempMaxC: 31,
      // The useful form of a sunrise is the clock at the array, not UTC.
      sunrise: '05:45', sunset: '18:25',
    });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('sends the key and the coordinates, and asks for metric units', async () => {
    const urls: string[] = [];
    const f = vi.fn(async (url: string) => { urls.push(String(url)); return ok(CURRENT); });
    await fetchWeather(KEY, AT, f as unknown as typeof fetch);
    for (const u of urls) {
      expect(u).toContain(`key=${KEY}`);
      expect(u).toContain(`location.latitude=${AT.lat}`);
      expect(u).toContain('unitsSystem=METRIC');
    }
  });

  it('still answers when only one of the two calls succeeds', async () => {
    const f = vi.fn(async (url: string) => (String(url).includes('forecast') ? fail() : ok(CURRENT)));
    const w = await fetchWeather(KEY, AT, f as unknown as typeof fetch);
    expect(w?.text).toBe('Clear');
    expect(w?.tempMaxC).toBeNull();
  });

  it('returns nothing when both calls fail, rather than an object full of nulls', async () => {
    const f = vi.fn(async () => fail(403));
    expect(await fetchWeather(KEY, AT, f as unknown as typeof fetch)).toBeNull();
  });
});

describe('siteWeather', () => {
  it('does nothing at all without a key - the lookup is opt-in', async () => {
    const db = fakeDb();
    expect(await siteWeather(db, undefined, AT)).toBeNull();
    expect(db.writes).toBe(0);
  });

  it('does nothing without coordinates to look up', async () => {
    expect(await siteWeather(fakeDb(), KEY, null)).toBeNull();
  });

  it('serves a cached answer rather than paying for another call', async () => {
    const cached = { text: 'Cached', tempC: 20, tempMinC: null, tempMaxC: null, sunrise: null, sunset: null };
    const db = fakeDb({
      [`weather:${AT.lat.toFixed(3)},${AT.lon.toFixed(3)}`]: { v: JSON.stringify(cached), expires_at: 2000 },
    });
    expect(await siteWeather(db, KEY, AT, 1000)).toEqual(cached);
    expect(db.writes).toBe(0);
  });

  it('never fails the poll when the lookup throws', async () => {
    const boom = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    try {
      // A weather outage must not stop a reading being stored.
      expect(await siteWeather(fakeDb(), KEY, AT, 1000)).toBeNull();
    } finally {
      boom.mockRestore();
    }
  });
});

describe('stampWeather', () => {
  const reading = (): Reading => ({
    inverterId: 'soliscloud:station:1', ts: 1788793199, source: 'soliscloud-relay',
    acPowerW: 20, dcPowerW: null, todayKwh: 48.4, totalKwh: 48901,
    batterySoc: null, batteryPowerW: null, gridPowerW: -20, loadPowerW: 0,
    tempC: null, status: 'online', metrics: emptyMetrics(),
    raw: { latitude: '51.4779', longitude: '-0.0015' },
  });

  it('leaves the vendor\'s own weather standing when no key is configured', async () => {
    const r = reading();
    r.metrics!.weatherText = 'Sunny, per SolisCloud';
    await stampWeather({ DB: fakeDb() } as unknown as Env, r);
    expect(r.metrics!.weatherText).toBe('Sunny, per SolisCloud');
  });

  it('stamps the lookup onto the reading, taking coordinates from the payload', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (async (url: string) => ok(String(url).includes('forecast') ? FORECAST : CURRENT)) as unknown as typeof fetch);
    try {
      const r = reading();
      await stampWeather({ DB: fakeDb(), GOOGLE_WEATHER_KEY: KEY } as unknown as Env, r);
      expect(r.metrics!.weatherText).toBe('Clear');
      expect(r.metrics!.tempNowC).toBe(29.4);
      expect(r.metrics!.tempMinC).toBe(24);
      expect(r.metrics!.sunrise).toBe('05:45');
    } finally {
      f.mockRestore();
    }
  });

  it('falls back to the configured site when the payload has no coordinates', async () => {
    const urls: string[] = [];
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string) => {
      urls.push(String(url));
      return ok(String(url).includes('forecast') ? FORECAST : CURRENT);
    }) as unknown as typeof fetch);
    try {
      const r = reading();
      r.raw = { generationPower: 278 }; // SolarMan ships no coordinates
      await stampWeather(
        { DB: fakeDb(), GOOGLE_WEATHER_KEY: KEY, SITE_LAT: '51.5', SITE_LON: '-0.12' } as unknown as Env, r);
      expect(urls[0]).toContain('location.latitude=51.5');
      expect(r.metrics!.weatherText).toBe('Clear');
    } finally {
      f.mockRestore();
    }
  });

  it('builds a metrics bag for a reading that arrived without one', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (async (url: string) => ok(String(url).includes('forecast') ? FORECAST : CURRENT)) as unknown as typeof fetch);
    try {
      const r = reading();
      r.metrics = null;
      await stampWeather({ DB: fakeDb(), GOOGLE_WEATHER_KEY: KEY } as unknown as Env, r);
      expect(r.metrics).not.toBeNull();
      expect(r.metrics!.weatherText).toBe('Clear');
    } finally {
      f.mockRestore();
    }
  });
});
