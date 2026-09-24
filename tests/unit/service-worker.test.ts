/**
 * The service worker's push half, run as it is shipped.
 *
 * `public/sw.js` is loaded into a stand-in for a worker's global scope - its
 * listeners captured, its caches and notifications recorded - so what it does
 * with a push can be asserted without a browser or a push service. The part
 * that matters most is the part that is easiest to get wrong: a second wake-up
 * must not bring back a notification the owner has already dismissed.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync('public/sw.js', 'utf8');
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/device-one';

type Listener = (event: unknown) => void;

function loadWorker(answers: Array<{ ok: boolean; messages?: unknown[] } | 'offline'>, opts: { subscribed?: boolean } = {}) {
  const listeners = new Map<string, Listener>();
  const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
  const asked: string[] = [];
  const store = new Map<string, Response>();
  const windows: Array<{ url: string; focused: boolean; navigatedTo?: string }> = [];
  const opened: string[] = [];

  const self = {
    location: { origin: 'https://dashboard.test' },
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    skipWaiting: async () => {},
    registration: {
      pushManager: { getSubscription: async () => (opts.subscribed === false ? null : { endpoint: ENDPOINT }) },
      showNotification: async (title: string, options: Record<string, unknown>) => { shown.push({ title, options }); },
    },
    clients: {
      claim: async () => {},
      matchAll: async () => windows.map((w) => ({
        url: w.url,
        focus: async () => { w.focused = true; return w; },
        navigate: async (u: string) => { w.navigatedTo = u; return w; },
      })),
      openWindow: async (u: string) => { opened.push(u); return null; },
    },
  };
  const caches = {
    open: async () => ({
      match: async (k: string) => store.get(k)?.clone(),
      put: async (k: string, r: Response) => { store.set(k, r); },
    }),
  };
  const fetch = async (url: string) => {
    asked.push(url);
    const a = answers.shift() ?? { ok: true, messages: [] };
    if (a === 'offline') throw new Error('offline');
    return { ok: a.ok, json: async () => ({ messages: a.messages ?? [] }) };
  };

  new Function('self', 'caches', 'fetch', 'crypto', 'TextEncoder', 'btoa', SOURCE)(self, caches, fetch, crypto, TextEncoder, btoa);

  async function push() {
    let done: Promise<unknown> = Promise.resolve();
    listeners.get('push')!({ waitUntil: (p: Promise<unknown>) => { done = p; } });
    await done;
  }
  async function click(data?: unknown) {
    let done: Promise<unknown> = Promise.resolve();
    let closed = false;
    listeners.get('notificationclick')!({
      notification: { data, close: () => { closed = true; } },
      waitUntil: (p: Promise<unknown>) => { done = p; },
    });
    await done;
    return closed;
  }
  return { shown, asked, windows, opened, push, click };
}

const msg = (id: string, ts = 1_790_000_000) => ({ id, ts, title: `Title ${id}`, body: `Body ${id}` });

describe('a push, as the service worker handles it', () => {
  it('asks what is new, addressed to this device by a hash of its endpoint, and shows it', async () => {
    const w = loadWorker([{ ok: true, messages: [msg('b', 2), msg('a', 1)] }]);
    await w.push();
    expect(w.asked).toHaveLength(1);
    expect(w.asked[0]).toMatch(/^\/api\/push\/recent\?for=[A-Za-z0-9_-]{16}$/);
    expect(w.asked[0]).not.toContain('device-one');
    // Oldest first, so they stack in the order they happened.
    expect(w.shown.map((s) => s.title)).toEqual(['Title a', 'Title b']);
    expect(w.shown[0].options).toMatchObject({ body: 'Body a', tag: 'a', timestamp: 1000, data: { url: '/#/alerts' } });
  });

  it('does not bring back a notification already shown on this device', async () => {
    const w = loadWorker([
      { ok: true, messages: [msg('a')] },
      { ok: true, messages: [msg('b'), msg('a')] },
    ]);
    await w.push();
    await w.push();
    expect(w.shown.map((s) => s.title)).toEqual(['Title a', 'Title b']);
  });

  it('still says something when woken with nothing to read, rather than leaving the browser to', async () => {
    const offline = loadWorker(['offline']);
    await offline.push();
    expect(offline.shown).toEqual([expect.objectContaining({ title: 'SolarLens' })]);

    const refused = loadWorker([{ ok: false }]);
    await refused.push();
    expect(refused.shown.map((s) => s.title)).toEqual(['SolarLens']);
  });

  it('shows nothing extra when everything it was woken for is already on screen', async () => {
    const w = loadWorker([{ ok: true, messages: [msg('a')] }, { ok: true, messages: [msg('a')] }]);
    await w.push();
    await w.push();
    expect(w.shown).toHaveLength(1);
  });

  it('asks for general messages only when the device has no subscription of its own', async () => {
    const w = loadWorker([{ ok: true, messages: [] }], { subscribed: false });
    await w.push();
    expect(w.asked[0]).toBe('/api/push/recent?for=');
  });
});

describe('a tap on a notification', () => {
  it('brings an open dashboard window forward, on the Alerts tab', async () => {
    const w = loadWorker([]);
    w.windows.push({ url: 'https://dashboard.test/#/power', focused: false });
    expect(await w.click({ url: '/#/alerts' })).toBe(true);
    expect(w.windows[0]).toMatchObject({ focused: true, navigatedTo: '/#/alerts' });
    expect(w.opened).toEqual([]);
  });

  it('opens one when none is open', async () => {
    const w = loadWorker([]);
    w.windows.push({ url: 'https://elsewhere.example/', focused: false });
    await w.click();
    expect(w.opened).toEqual(['/#/alerts']);
  });
});
