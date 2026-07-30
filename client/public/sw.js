/* Nexora PWA service worker.
 *
 * Strategy matters here: the previous version was cache-first on every GET with
 * a hardcoded cache name that was never cleaned up, so a returning installed-PWA
 * user kept getting the previous build's index.html — which points at hashed
 * asset filenames that no longer exist. Result: a stale (or broken) app that
 * only a manual "clear site data" could fix.
 *
 * Now:
 *   navigations    → network-first (a new deploy is picked up immediately)
 *   hashed assets  → cache-first  (safe: the content hash IS the version)
 *   everything else→ network, falling back to cache when offline
 */
const VERSION = 'v2';
const SHELL_CACHE = `nexora-shell-${VERSION}`;
const ASSET_CACHE = `nexora-assets-${VERSION}`;
const CURRENT = [SHELL_CACHE, ASSET_CACHE];

const OFFLINE_URLS = ['/', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((c) => c.addAll(OFFLINE_URLS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !CURRENT.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Let the page hand control to a waiting worker without a second reload.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

function isHashedAsset(url) {
  return url.pathname.startsWith('/assets/') || /\.(woff2?|ttf|otf)$/i.test(url.pathname);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put('/', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('/').then((c) => c || Response.error()))
    );
    return;
  }

  if (isHashedAsset(url)) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((res) => {
            const copy = res.clone();
            caches.open(ASSET_CACHE).then((c) => c.put(request, copy)).catch(() => {});
            return res;
          })
      )
    );
    return;
  }

  event.respondWith(fetch(request).catch(() => caches.match(request)));
});
