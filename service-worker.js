const CACHE_NAME = 'film-roll-cache-v2'; // ⚠️ Har baar jab index.html/style.css/script.js update karo, ye version number badhao (v2, v3, v4...)
const urlsToCache = ['./index.html', './manifest.json'];

// ── INSTALL: naya cache banao ──
self.addEventListener('install', (e) => {
  self.skipWaiting(); // naya service worker turant activate ho jaye, purane ka wait na kare
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(urlsToCache))
  );
});

// ── ACTIVATE: purani cache versions delete karo ──
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names.map((name) => {
          if (name !== CACHE_NAME) {
            return caches.delete(name); // purani v1, v2... wagera delete
          }
        })
      )
    ).then(() => self.clients.claim()) // turant control le lo, page reload ka wait na karo
  );
});

// ── FETCH: sirf apni static files cache se serve karo, baaki sab network se ──
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // 1) Sirf GET requests handle karo — POST/PUT/DELETE ko seedha network pe jaane do
  if (e.request.method !== 'GET') {
    return; // service worker isme interfere nahi karega — browser normal fetch karega
  }

  // 2) Google Apps Script / kisi bhi cross-origin API call ko bilkul touch mat karo
  if (url.origin !== self.location.origin) {
    return;
  }

  // 3) Apni static files ke liye: network-first, fail ho to cache se do (offline fallback)
  e.respondWith(
    fetch(e.request)
      .then((networkResponse) => {
        // fresh response mila — cache bhi update kar do taaki agli baar offline mein kaam aaye
        const clone = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        return networkResponse;
      })
      .catch(() => caches.match(e.request)) // network fail (offline) ho to cache se serve karo
  );
});
