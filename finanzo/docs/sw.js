// Sorgt dafür, dass Finanzo auch ohne Internet startet.
// Mit Internet wird immer die neueste Version geladen, ohne Internet die gespeicherte.
const CACHE = 'finanzo-42';
const OCR_CACHE = 'finanzo-ocr-1';   // bleibt bei Updates erhalten
const FILES = [
  './',
  './index.html',
  './lang.js',
  './manifest.webmanifest',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== OCR_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // Texterkennung (groß, ändert sich nie): einmal laden, dann vom Gerät
  if (new URL(req.url).pathname.includes('/ocr/')) {
    event.respondWith(caches.open(OCR_CACHE).then((c) => c.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) c.put(req, res.clone());
      return res;
    }))));
    return;
  }
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  );
});

// Mitteilungen (kommen auch, wenn Finanzo zu ist)
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) {
    try { d = { body: event.data.text() }; } catch (e2) { d = {}; }
  }
  event.waitUntil(self.registration.showNotification(d.title || 'Finanzo', {
    body: d.body || '',
    tag: d.tag || undefined,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    data: { url: './' },
  }));
});

// Tippen auf die Mitteilung öffnet Finanzo
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      return self.clients.openWindow ? self.clients.openWindow('./') : undefined;
    })
  );
});
