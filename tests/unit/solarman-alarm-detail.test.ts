/**
 * SolarMan alarm detail: when a fault cleared, and what SolarMan advises.
 *
 * The alert list names a fault and the day it was raised, and nothing else. The
 * portal's own detail panel makes two more calls - one for the advice, one for
 * the moments that day the fault was active - and these tests hold SolarLens to
 * reading them the way the portal does. Every id and time here is made up; the
 * shapes are the ones the portal returns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { solarmanAdvice, solarmanOccurrences } from '../../src/providers/events';
import { SolarmanWebProvider, queue as webQueue } from '../../src/providers/solarman-web';
import type { TokenStore } from '../../src/providers/solarman';

/** Midnight on 10 March 2026 in Asia/Tokyo, which has no daylight saving. */
const DAY = Math.floor(Date.UTC(2026, 2, 9, 15, 0, 0) / 1000);
const at = (h: number, m = 0) => DAY + h * 3600 + m * 60;
/** SolarMan's alertDay, YYYYMMDD, built rather than written out as one long number. */
const ymd = (y: number, m: number, d: number) => `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;

const listed = (alertTime: number, over: Record<string, unknown> = {}) => ({
  code: '7', level: 2, showName: 'F56DC_VoltLow_Fault', alertTime,
  deviceId: 111, ruleId: 222, timezone: 'Asia/Tokyo', ...over,
});

describe('what SolarMan advises', () => {
  it('is every solution line, one per line, as the portal shows them', () => {
    const advice = solarmanAdvice({
      customAlertConfigDisplayReason: [
        { id: 1, solution: 'Check the DC connectors.\nMeasure the string voltage.' },
        { id: 2, solution: '  Call the installer if it persists.  ' },
      ],
    });
    expect(advice).toBe('Check the DC connectors.\nMeasure the string voltage.\nCall the installer if it persists.');
  });

  it('falls back to the rule description, and says nothing when there is none', () => {
    expect(solarmanAdvice({ customAlertConfigDisplayReason: [], customAlertConfigDisplay: { description: 'PV input too low.' } }))
      .toBe('PV input too low.');
    // The shape SolarMan actually returned for a DC under-voltage fault: nothing.
    expect(solarmanAdvice({ customAlertConfigDisplayReason: [], customAlertConfigDisplay: { description: null } })).toBeNull();
    expect(solarmanAdvice(null)).toBeNull();
  });
});

describe('when a SolarMan fault was active', () => {
  const later = at(23);

  it('turns each run of five-minute samples into one occurrence, with an end', () => {
    const points = [at(10), at(10, 5), at(10, 10), at(14)];
    const out = solarmanOccurrences('4242', listed(at(14)), points, null, DAY + 86400, later);

    expect(out).toHaveLength(2);
    // The earlier run is one the list folded away.
    expect(out[0]).toMatchObject({
      id: `solarman:4242:7:${at(10)}`, beginTs: at(10), endTs: at(10, 15), state: 'recovered',
    });
    // The listed alert keeps the id it was already stored under, and gains an end.
    expect(out[1]).toMatchObject({
      id: `solarman:4242:7:${at(14)}`, beginTs: at(14), endTs: at(14, 5), state: 'recovered',
    });
  });

  it('does not call a fault over while its last sample is recent', () => {
    const [a] = solarmanOccurrences('4242', listed(at(14)), [at(14)], null, DAY + 86400, at(14, 6));
    expect(a).toMatchObject({ state: 'active', endTs: null });
  });

  it('does not guess an end for a run that reaches midnight, which may carry on tomorrow', () => {
    const [a] = solarmanOccurrences('4242', listed(at(23, 58)), [at(23, 58)], null, DAY + 86400, DAY + 2 * 86400);
    expect(a).toMatchObject({ state: 'unknown', endTs: null });
  });

  it('keeps the listed alert as it was when the timeline is empty or disagrees', () => {
    const [empty] = solarmanOccurrences('4242', listed(at(14)), [], 'advice', DAY + 86400, later);
    expect(empty).toMatchObject({ id: `solarman:4242:7:${at(14)}`, endTs: null, state: 'unknown', advice: 'advice' });

    const disagree = solarmanOccurrences('4242', listed(at(14)), [at(9)], null, DAY + 86400, later);
    expect(disagree.map((a) => a.beginTs)).toEqual([at(9), at(14)]);
  });

  it('reads timestamps in milliseconds as well as seconds, and ignores junk', () => {
    const out = solarmanOccurrences('4242', listed(at(14)), [at(14) * 1000, 'x', null, at(14)], null, DAY + 86400, later);
    expect(out).toHaveLength(1);
    expect(out[0].beginTs).toBe(at(14));
  });

  it('gives nothing for an alert the list itself could not read', () => {
    expect(solarmanOccurrences('4242', { code: null }, [at(1)], null, DAY + 86400, later)).toEqual([]);
  });
});

// ------------------------------------------------------------------ provider

type Route = (url: string, init?: RequestInit) => unknown;
function stubFetch(routes: Array<[string, Route]>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
    const hit = routes.find(([frag]) => url.includes(frag));
    if (!hit) throw new Error('unstubbed request: ' + url);
    const out = hit[1](url, init);
    return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200 });
  }));
  return calls;
}

/** A token store in memory, already holding a valid portal token, so no refresh is attempted. */
function tokens(): TokenStore {
  const shelf = new Map([['solarman-web', { accessToken: 'T', expiresAt: Math.floor(Date.now() / 1000) + 3600 }]]);
  return {
    async get(p) { return shelf.get(p) ?? null; },
    async set(p, accessToken, expiresAt) { shelf.set(p, { accessToken, expiresAt }); },
  };
}

describe('SolarmanWebProvider.listAlarms with detail', () => {
  beforeEach(() => { webQueue.minGapMs = 0; });
  afterEach(() => { vi.unstubAllGlobals(); });

  const provider = () => new SolarmanWebProvider({ refreshToken: 'R' }, tokens());

  it('asks the detail and timeline calls the portal asks, for the plant\'s own day', async () => {
    const calls = stubFetch([
      ['/alert/search', () => ({ total: 1, data: [listed(at(14))] })],
      ['/alert/detail', () => ({ customAlertConfigDisplayReason: [{ id: 1, solution: 'Check the DC connectors.' }] })],
      ['/alert/timeline', () => [at(10), at(10, 5), at(14)]],
    ]);
    const alarms = await provider().listAlarms('4242', at(23));

    const detail = calls.find((c) => c.url.includes('/alert/detail'))!;
    const timeline = calls.find((c) => c.url.includes('/alert/timeline'))!;
    expect(detail.body).toEqual({ deviceId: 111, ruleId: 222, language: 'en' });
    // 14:00 in Tokyo on the 10th is 05:00 UTC on the 10th - but the day asked
    // for has to be the plant's, which is what this checks at the edge below.
    expect(timeline.body).toEqual({ deviceId: 111, ruleId: 222, alertDay: ymd(2026, 3, 10) });

    expect(alarms).toHaveLength(2);
    expect(alarms.every((a) => a.advice === 'Check the DC connectors.')).toBe(true);
    expect(alarms.find((a) => a.beginTs === at(14))).toMatchObject({ endTs: at(14, 5), state: 'recovered' });
  });

  it('asks for the plant\'s day even when that is not the UTC day', async () => {
    // 01:00 in Tokyo on the 10th is still the 9th in UTC.
    const calls = stubFetch([
      ['/alert/search', () => ({ total: 1, data: [listed(at(1))] })],
      ['/alert/detail', () => ({ customAlertConfigDisplayReason: [] })],
      ['/alert/timeline', () => [at(1)]],
    ]);
    await provider().listAlarms('4242', at(23));
    expect(calls.find((c) => c.url.includes('/alert/timeline'))!.body.alertDay).toBe(ymd(2026, 3, 10));
  });

  it('asks the advice once per rule, and details only the newest few', async () => {
    const seven = Array.from({ length: 7 }, (_, i) => listed(at(14) - i * 86400));
    const calls = stubFetch([
      ['/alert/search', () => ({ total: 7, data: seven })],
      ['/alert/detail', () => ({ customAlertConfigDisplayReason: [] })],
      ['/alert/timeline', (_u, init) => {
        const day = JSON.parse(String(init?.body)).alertDay as string;
        const i = seven.findIndex((r) => new Date((r.alertTime + 9 * 3600) * 1000).toISOString().slice(0, 10).replace(/-/g, '') === day);
        return [seven[i].alertTime];
      }],
    ]);
    const alarms = await provider().listAlarms('4242', at(23));

    expect(calls.filter((c) => c.url.includes('/alert/detail'))).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes('/alert/timeline'))).toHaveLength(5);
    // All seven are still stored; the two oldest simply as the list gave them.
    expect(alarms).toHaveLength(7);
    expect(alarms.filter((a) => a.state === 'recovered')).toHaveLength(5);
    expect(alarms.filter((a) => a.state === 'unknown')).toHaveLength(2);
  });

  it('stores an alert as the list gave it when its detail cannot be read', async () => {
    stubFetch([
      ['/alert/search', () => ({ total: 1, data: [listed(at(14))] })],
      ['/alert/detail', () => new Response('', { status: 500 })],
      ['/alert/timeline', () => [at(14)]],
    ]);
    const alarms = await provider().listAlarms('4242', at(23));
    expect(alarms).toEqual([expect.objectContaining({ id: `solarman:4242:7:${at(14)}`, endTs: null, state: 'unknown', advice: null })]);
  });

  it('skips the detail for an alert with no device or rule to ask about', async () => {
    const calls = stubFetch([
      ['/alert/search', () => ({ total: 1, data: [listed(at(14), { deviceId: null })] })],
    ]);
    const alarms = await provider().listAlarms('4242', at(23));
    expect(calls).toHaveLength(1);
    expect(alarms).toHaveLength(1);
  });
});

describe('the shapes SolarMan could send instead', () => {
  beforeEach(() => { webQueue.minGapMs = 0; });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('reads advice from a detail with no reason list, or reasons with no solution', () => {
    expect(solarmanAdvice({})).toBeNull();
    expect(solarmanAdvice({ customAlertConfigDisplayReason: [{ id: 1 }, { id: 2, solution: 'Reset the inverter.' }] })).toBe('Reset the inverter.');
  });

  it('treats a timeline that is not a list as an empty one', () => {
    const [a] = solarmanOccurrences('4242', listed(at(14)), { data: [at(14)] }, null, DAY + 86400, at(23));
    expect(a).toMatchObject({ beginTs: at(14), endTs: null, state: 'unknown' });
  });

  it('copes with an alert list that has no rows', async () => {
    stubFetch([['/alert/search', () => ({ total: 0 })]]);
    expect(await new SolarmanWebProvider({ refreshToken: 'R' }, tokens()).listAlarms('4242')).toEqual([]);
  });

  it('asks for the plant\'s day from the plant\'s offset when the alert names no zone, and UTC when nothing does', async () => {
    const calls = stubFetch([
      ['/station/search', () => ({ data: [{ id: 4242, name: 'Demo', installedCapacity: 3.5, timeZoneOffset: 9 * 3600 }] })],
      ['/alert/search', () => ({ total: 1, data: [listed(at(1), { timezone: null })] })],
      ['/alert/detail', () => ({})],
      ['/alert/timeline', () => [at(1)]],
    ]);
    const p = new SolarmanWebProvider({ refreshToken: 'R' }, tokens());
    await p.listAlarms('4242', at(23));
    expect(calls.filter((c) => c.url.includes('/alert/timeline')).pop()!.body.alertDay).toBe(ymd(2026, 3, 9));

    await p.listPlants();
    await p.listAlarms('4242', at(23));
    expect(calls.filter((c) => c.url.includes('/alert/timeline')).pop()!.body.alertDay).toBe(ymd(2026, 3, 10));
  });
});
