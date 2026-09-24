/**
 * Service worker: offline fallback, never a stale-first cache.
 *
 * The one rule this file exists to keep is that a cached reading must never be
 * mistaken for a live one. So every request goes to the network first and the
 * cache answers only when the network could not. A dashboard that quietly
 * served yesterday's watts from disk would be worse than one that failed
 * honestly - and the page already labels a stale reading, because staleness is
 * judged from the sample's own timestamp rather than from how it arrived.
 *
 * Its other job is to exist at all: an installable web app needs a worker with
 * a fetch handler, which is what turns the dashboard into something that can
 * live on a phone's home screen instead of inside a browser tab.
 */
const VERSION = 'solarlens-v1';
const SHELL = ['/', '/icon.svg', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  // Take over as soon as the new worker is ready: a dashboard left open on a
  // wall display should not keep an old shell until every tab is closed.
  event.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Only same-origin reads. A POST is an instruction, not a page, and replaying
  // one from a cache would be a bug with consequences.
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((res) => {
        // Opaque and error responses are not worth keeping; a 200 is.
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(request);
        if (hit) return hit;
        // A navigation with nothing cached for that exact URL still deserves the
        // app shell rather than the browser's offline page: every route in this
        // dashboard is a hash, so "/" is the document for all of them.
        if (request.mode === 'navigate') {
          const shell = await caches.match('/');
          if (shell) return shell;
        }
        return new Response('offline', { status: 503, statusText: 'offline' });
      }),
  );
});

// ---------------------------------------------------------------- push
//
// The push itself is empty: the server only wakes this worker, and this asks
// what there is to say. That keeps the words out of the push services, and
// needs no encryption. Messages already shown on this device are remembered,
// so a second wake-up does not bring back a notification you dismissed.

const SEEN = 'solarlens-push-seen';

/** This device's own address for messages meant only for it: a hash of its endpoint. */
async function audience() {
  const sub = await self.registration.pushManager.getSubscription();
  if (!sub) return '';
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sub.endpoint)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 16);
}

/** The ids of the messages this device has already shown, kept in the service worker's cache. */
async function seenIds() {
  try {
    const hit = await (await caches.open(SEEN)).match('/__push-seen');
    return hit ? await hit.json() : [];
  } catch {
    return [];
  }
}

/** Save the shown ids, keeping the newest hundred. */
async function remember(ids) {
  const keep = ids.slice(-100);
  await (await caches.open(SEEN)).put('/__push-seen', new Response(JSON.stringify(keep)));
}

/**
 * What a push does: ask the server for this device's recent messages, and show
 * the ones not shown before, oldest first.
 */
async function showWhatIsNew() {
  let messages = [];
  let more = false;
  try {
    const res = await fetch(`/api/push/recent?for=${encodeURIComponent(await audience())}`, { cache: 'no-store' });
    if (res.ok) {
      const body = await res.json();
      messages = body.messages ?? [];
      more = !!body.more;
    }
  } catch {
    // Offline in the instant it was woken: say so rather than nothing, because
    // a browser that is woken and shows nothing warns the user about the site.
  }
  const seen = await seenIds();
  const fresh = messages.filter((m) => !seen.includes(m.id)).reverse();
  // More happened than one wake-up shows: say so, rather than let the rest go
  // unmentioned.
  if (more) {
    await self.registration.showNotification('SolarLens: more than this', {
      body: 'Several things changed at once. Open the Alerts tab for the rest.',
      tag: 'solarlens-more',
      icon: '/icon-192.png',
      data: { url: '/#/alerts' },
    });
  }
  if (!fresh.length) {
    if (!messages.length && !more) {
      await self.registration.showNotification('SolarLens', {
        body: 'Something changed. Open the dashboard to see what.',
        tag: 'solarlens-generic',
        icon: '/icon-192.png',
      });
    }
    return;
  }
  for (const m of fresh) {
    await self.registration.showNotification(m.title, {
      body: m.body,
      tag: m.id,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      timestamp: m.ts * 1000,
      data: { url: '/#/alerts' },
    });
  }
  await remember([...seen, ...fresh.map((m) => m.id)]);
}

self.addEventListener('push', (event) => {
  event.waitUntil(showWhatIsNew());
});

// A tap opens the Alerts tab: in a dashboard window that is already open if
// there is one, rather than stacking another.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/#/alerts';
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of open) {
      if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
        if ('navigate' in client) await client.navigate(url).catch(() => {});
        return client.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
