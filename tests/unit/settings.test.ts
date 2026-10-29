/**
 * The owner's tariff: what a kWh costs and earns, and the grid's CO2.
 *
 * The page turns it into money saved and carbon avoided, so what is held to
 * account here is the part the Worker owns: only sensible numbers are kept,
 * only the owner may set or clear it, and anyone who may read the dashboard
 * may read it back. The same for the groups the owner sorts the systems into,
 * which are kept against real ids and served by alias.
 */
import { describe, expect, it } from 'vitest';
import { GROUP_NAME_MAX, MAX_GROUPS, getGroups, getTariff, parseGroups, parseTariff, setTariff, type Tariff } from '../../src/settings';
import { createTestD1 } from '../helpers/d1';
import { bearer, createHarness } from '../helpers/worker';

// Invented prices, in an invented shape of tariff.
const TARIFF: Tariff = { currency: 'EUR', importPrice: 0.3, exportPrice: 0.08, netMetering: false, co2KgPerKwh: 0.35 };

const send = (method: string, body?: unknown, auth = true): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', ...(auth ? bearer('api-token-for-tests') : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describe('a tariff, from what the Settings form sent', () => {
  it('keeps the numbers, the currency in capitals, and net metering only when it is true', () => {
    expect(parseTariff({ ...TARIFF, currency: ' eur ' })).toEqual({ tariff: TARIFF });
    expect(parseTariff({ ...TARIFF, importPrice: '0.3', netMetering: 'yes' })).toEqual({ tariff: TARIFF });
    expect(parseTariff({ ...TARIFF, netMetering: true })).toEqual({ tariff: { ...TARIFF, netMetering: true } });
  });

  it('refuses a currency that is not a three-letter code', () => {
    for (const currency of ['', 'EU', 'EURO', '€', 12, undefined]) {
      expect(parseTariff({ ...TARIFF, currency })).toEqual({ error: expect.stringContaining('three-letter') });
    }
  });

  it('refuses a price or a CO2 figure that is not a number within reason', () => {
    expect(parseTariff({ ...TARIFF, importPrice: -1 })).toEqual({ error: expect.stringContaining('bought') });
    expect(parseTariff({ ...TARIFF, importPrice: '' })).toEqual({ error: expect.stringContaining('bought') });
    expect(parseTariff({ ...TARIFF, importPrice: 1001 })).toEqual({ error: expect.stringContaining('bought') });
    expect(parseTariff({ ...TARIFF, exportPrice: Number.NaN })).toEqual({ error: expect.stringContaining('sold') });
    expect(parseTariff({ ...TARIFF, exportPrice: null })).toEqual({ error: expect.stringContaining('sold') });
    expect(parseTariff({ ...TARIFF, co2KgPerKwh: 2.5 })).toEqual({ error: expect.stringContaining('CO₂') });
    expect(parseTariff(null)).toEqual({ error: expect.stringContaining('currency') });
  });
});

describe('the stored tariff', () => {
  it('is nothing until set, replaced when set again, and gone when cleared', async () => {
    const d = createTestD1();
    expect(await getTariff(d.db)).toBeNull();
    await setTariff(d.db, TARIFF, 100);
    expect(await getTariff(d.db)).toEqual(TARIFF);
    await setTariff(d.db, { ...TARIFF, importPrice: 0.32 }, 200);
    expect(await getTariff(d.db)).toEqual({ ...TARIFF, importPrice: 0.32 });
    await setTariff(d.db, null);
    expect(await getTariff(d.db)).toBeNull();
    d.close();
  });

  it('reads as nothing if what is stored is not JSON', async () => {
    const d = createTestD1();
    await d.db.prepare("INSERT INTO app_settings (k, v, updated_at) VALUES ('tariff', 'not json', 1)").run();
    expect(await getTariff(d.db)).toBeNull();
    d.close();
  });
});

describe('/api/settings/tariff', () => {
  it('is read by anyone who may read the dashboard, and never cached', async () => {
    const h = createHarness();
    const first = await h.fetch('/api/settings/tariff');
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ tariff: null });
    expect(first.headers.get('cache-control')).toBe('no-store');
    await setTariff(h.env.DB, TARIFF);
    expect(await (await h.fetch('/api/settings/tariff')).json()).toEqual({ tariff: TARIFF });
    h.close();
  });

  it('is set and cleared by the owner only', async () => {
    const h = createHarness();
    expect((await h.fetch('/api/settings/tariff', send('PUT', TARIFF, false))).status).toBe(401);
    expect((await h.fetch('/api/settings/tariff', send('DELETE', undefined, false))).status).toBe(401);
    expect(await getTariff(h.env.DB)).toBeNull();

    const set = await h.fetch('/api/settings/tariff', send('PUT', { ...TARIFF, currency: 'eur' }));
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ tariff: TARIFF });
    expect(await getTariff(h.env.DB)).toEqual(TARIFF);

    const cleared = await h.fetch('/api/settings/tariff', send('DELETE'));
    expect(await cleared.json()).toEqual({ tariff: null });
    expect(await getTariff(h.env.DB)).toBeNull();
    h.close();
  });

  it('says what is wrong with a tariff it will not keep, and keeps the old one', async () => {
    const h = createHarness();
    await setTariff(h.env.DB, TARIFF);
    const bad = await h.fetch('/api/settings/tariff', send('PUT', { ...TARIFF, importPrice: -2 }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain('bought');
    const garbled = await h.fetch('/api/settings/tariff', { ...send('PUT'), body: '{not json' });
    expect(garbled.status).toBe(400);
    expect(await getTariff(h.env.DB)).toEqual(TARIFF);
    h.close();
  });
});

describe('groups, from what the Settings form sent', () => {
  // Aliases stand for real ids; the Worker turns one into the other.
  const ids: Record<string, string> = { s1: 'solarman:station:alpha', s2: 'solarman:station:beta' };
  const idOf = (a: string) => ids[a] ?? null;

  it('keeps each system against its real id, tidied, and leaves a blank one out', () => {
    expect(parseGroups({ groups: { s1: '  Home\u0007  sweet   home ', s2: '' } }, idOf))
      .toEqual({ groups: { 'solarman:station:alpha': 'Home sweet home' } });
    expect(parseGroups({ groups: { s1: null, s2: 'Farm' } }, idOf)).toEqual({ groups: { 'solarman:station:beta': 'Farm' } });
    expect(parseGroups({ groups: {} }, idOf)).toEqual({ groups: {} });
  });

  it('refuses a system that does not exist, a name that is not text or is too long, and too many groups', () => {
    expect(parseGroups({ groups: { s9: 'Home' } }, idOf)).toEqual({ error: 'There is no system s9.' });
    expect(parseGroups({ groups: { s1: 7 } }, idOf)).toEqual({ error: 'A group name is text.' });
    expect(parseGroups({ groups: { s1: 'x'.repeat(GROUP_NAME_MAX + 1) } }, idOf)).toEqual({ error: expect.stringContaining('at most') });
    const many = Object.fromEntries(Array.from({ length: MAX_GROUPS + 1 }, (_, i) => [`s${i + 1}`, `Group ${i}`]));
    expect(parseGroups({ groups: many }, (a) => a)).toEqual({ error: expect.stringContaining(`at most ${MAX_GROUPS} groups`) });
    for (const body of [null, {}, { groups: [] }, { groups: 'Home' }]) {
      expect(parseGroups(body, idOf)).toEqual({ error: expect.stringContaining('Send the groups') });
    }
  });

  it('reads as none when nothing, or something unreadable, is stored', async () => {
    const d = createTestD1();
    expect(await getGroups(d.db)).toEqual({});
    await d.db.prepare("INSERT INTO app_settings (k, v, updated_at) VALUES ('groups', '[1]', 1)").run();
    expect(await getGroups(d.db)).toEqual({});
    await d.db.prepare("UPDATE app_settings SET v = 'nope' WHERE k = 'groups'").run();
    expect(await getGroups(d.db)).toEqual({});
    d.close();
  });
});

describe('/api/settings/groups', () => {
  /** Two systems, s1 and s2 by their ids' order. */
  async function withSystems() {
    const h = createHarness();
    for (const vendorId of ['beta', 'alpha']) {
      await h.env.DB.prepare(`INSERT INTO inverters (id, provider, vendor_id, name, first_seen, last_seen) VALUES (?1, 'solarman', ?2, ?2, 1, 1)`)
        .bind(`solarman:station:${vendorId}`, vendorId).run();
    }
    return h;
  }

  it('is set by the owner by alias, kept by real id, and read back by alias by anyone', async () => {
    const h = await withSystems();
    expect((await h.fetch('/api/settings/groups', send('PUT', { groups: { s1: 'Home' } }, false))).status).toBe(401);
    const set = await h.fetch('/api/settings/groups', send('PUT', { groups: { s1: 'Home', s2: 'Farm' } }));
    expect(await set.json()).toEqual({ groups: { s1: 'Home', s2: 'Farm' } });
    // Kept against the ids, so a system added later cannot inherit a group.
    expect(await getGroups(h.env.DB)).toEqual({ 'solarman:station:alpha': 'Home', 'solarman:station:beta': 'Farm' });
    const read = await h.fetch('/api/settings/groups');
    expect(await read.json()).toEqual({ groups: { s1: 'Home', s2: 'Farm' } });
    expect(read.headers.get('cache-control')).toBe('no-store');
    h.close();
  });

  it('follows a system when a new one moves its alias, and drops one that has gone', async () => {
    const h = await withSystems();
    await h.fetch('/api/settings/groups', send('PUT', { groups: { s1: 'Home', s2: 'Farm' } }));
    // "aardvark" sorts first, so alpha becomes s2 and beta s3.
    await h.env.DB.prepare(`INSERT INTO inverters (id, provider, vendor_id, name, first_seen, last_seen) VALUES ('solarman:station:aardvark', 'solarman', 'aardvark', 'aardvark', 1, 1)`).run();
    expect(await (await h.fetch('/api/settings/groups')).json()).toEqual({ groups: { s2: 'Home', s3: 'Farm' } });
    await h.env.DB.prepare(`DELETE FROM inverters WHERE id = 'solarman:station:beta'`).run();
    expect(await (await h.fetch('/api/settings/groups')).json()).toEqual({ groups: { s2: 'Home' } });
    h.close();
  });

  it('says what is wrong with groups it will not keep', async () => {
    const h = await withSystems();
    const bad = await h.fetch('/api/settings/groups', send('PUT', { groups: { s7: 'Home' } }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'There is no system s7.' });
    h.close();
  });
});
