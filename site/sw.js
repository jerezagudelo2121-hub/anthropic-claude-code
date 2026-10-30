"use strict";

/* Service worker: permite instalar la web como app (Android) y abrirla sin internet.
 * Estrategia "red primero": si hay conexión se usa siempre la versión nueva y se guarda una
 * copia; sin conexión se sirve la copia guardada. Así nunca se mezclan versiones antiguas. */

const CACHE = "gbaweb-v1";
const CORE = [
  "./",
  "index.html",
  "app.css",
  "app.js",
  "engine.js",
  "renderer.js",
  "gpsp/gpsp.wasm",
  "vendor/peerjs/peerjs.min.js",
  "vendor/fflate/fflate.min.js",
  "manifest.webmanifest",
  "icon.svg",
  "icon-192.png",
  "icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Solo archivos de esta web; el multijugador (PeerJS) y lo demás va directo a la red.
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
