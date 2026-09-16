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
