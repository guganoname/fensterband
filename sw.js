/* Fensterband offline cache: the app keeps working on a train without signal. */
const CACHE = 'fensterband-2d8341d839';
const ASSETS = ["./", "index.html", "manifest.webmanifest", "vendor/mp4-muxer.js", "icons/apple-touch-icon.png", "icons/favicon-64.png", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "fonts/big-shoulders-display-latin-600-normal.woff2", "fonts/big-shoulders-display-latin-800-normal.woff2", "fonts/overpass-latin-400-normal.woff2", "fonts/overpass-latin-600-normal.woff2", "fonts/overpass-latin-700-normal.woff2", "fonts/overpass-mono-latin-400-normal.woff2", "fonts/overpass-mono-latin-600-normal.woff2"];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('fensterband-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    // fresh page when online, cached page when the network is slow or gone
    const net = fetch(req).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put('index.html', copy)); }
      return r;
    });
    const timeout = new Promise((res) => setTimeout(res, 2500));
    e.respondWith(
      Promise.race([net, timeout.then(() => caches.match('index.html'))])
        .then((r) => r || net)
        .catch(() => caches.match('index.html'))
    );
    return;
  }
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return r;
    }))
  );
});
