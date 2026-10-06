// Stylelink Orders service worker. Scope: this folder only (registered with scope './').
const VERSION = '0.2.0-step2';
const PREFIX = 'sl-orders-test-';
const CACHE = PREFIX + VERSION;
const PRECACHE = ['./', './index.html', './app.css', './main.js', './views.js', './files.js', './swclient.js', './db.js', './repo.js', './domain.js', './commands.js', './backup.js', './version.js', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

// Downloads every missing file straight from the network (bypassing the host's own cache).
async function fillCache(cache) {
  for (const u of PRECACHE) {
    if (await cache.match(u)) continue;
    const r = await fetch(new Request(u, { cache: 'reload' }));
    if (!r.ok) throw new Error(u + ': HTTP ' + r.status);
    await cache.put(u, r);
  }
}

// No skipWaiting here: a new version waits until the user taps "Update now".
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    try { await fillCache(cache); } catch (err) { await caches.delete(CACHE); throw err; }
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith(PREFIX) && k !== CACHE) await caches.delete(k); // only our own old caches
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  const t = e.data && e.data.type;
  if (t === 'SKIP_WAITING') self.skipWaiting();
  if (t === 'ENSURE_CACHE') e.waitUntil(caches.open(CACHE).then(fillCache).catch(() => {}));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try { return await fetch(req); } catch (err) {
      if (req.mode === 'navigate') { const idx = await cache.match('./index.html'); if (idx) return idx; }
      return Response.error();
    }
  })());
});
