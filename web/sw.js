// Service worker: permite instalar la app y abrirla sin conexión.
// - Archivos de la app: se sirven desde caché (y se actualizan en segundo plano).
// - Datos del tiempo: primero red; si no hay conexión, último dato guardado.
const VERSION = "tiempo-smn-v1";
const SHELL = ["./", "index.html", "styles.css", "config.js", "api.js", "app.js", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Archivos propios de la app: caché primero, actualizo en segundo plano
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(req).then((hit) => {
        const net = fetch(req).then((res) => {
          if (res.ok) caches.open(VERSION).then((c) => c.put(req, res.clone()));
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
    return;
  }

  // Datos (proxy o API del SMN): red primero, caché si no hay conexión
  const isData = url.hostname.endsWith("workers.dev") || url.hostname === "ws1.smn.gob.ar" || url.pathname.match(/^\/(weather|forecast|search|coord)/);
  if (isData) {
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION + "-data").then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req).then((hit) => hit || Response.error()))
    );
  }
});
