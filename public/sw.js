// Offline app shell: network first, the last good copy when the network is gone.
// ponytail: the cache name is bumped by hand when SHELL changes; build-time hashing if the file list ever grows.
const CACHE = 'hypernova-v1';
// "/index.html" is left out on purpose: the host redirects it to "/", and a cached redirect breaks navigations.
const SHELL = [
  '/', '/style.css', '/app.js', '/device.js', '/protocol.js',
  '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(request).then((response) => {
      // Errors and redirects are not cached, so they never replace a good copy.
      if (response.ok && !response.redirected) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
      }
      return response;
    }).catch(async () => (
      (await caches.match(request))
      || (request.mode === 'navigate' && await caches.match('/'))
      || Response.error()
    )),
  );
});
