// Service worker : met en cache l'interface, les fichiers du site (dont data/obstacles)
// et les tuiles de carte déjà vues. Le moteur d'itinéraire, la recherche et Overpass
// passent directement par le réseau.
// En production, changer VERSION à chaque mise en ligne pour forcer la mise à jour.
const VERSION = "gabarit-shell-v1";
const TILES = "gabarit-tiles-v1";
const MAX_TILES = 4000;
const SHELL = [
  "./", "index.html", "legal.html", "css/app.css", "js/config.js", "js/services.js", "js/app.js",
  "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png",
  "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js",
  "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css",
];
// En local, réseau d'abord : les modifications se voient sans vider le cache.
const DEV = ["localhost", "127.0.0.1"].includes(self.location.hostname);

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== TILES).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function staleWhileRevalidate(cacheName, req) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, { ignoreSearch: req.mode === "navigate" });
  const net = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => hit);
  return hit || net;
}
async function networkFirst(cacheName, req) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req, { ignoreSearch: req.mode === "navigate" })) || Response.error();
  }
}
let puts = 0;
async function cacheFirstTile(req) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    cache.put(req, res.clone());
    if (++puts % 200 === 0) trim(cache);
  }
  return res;
}
async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin || url.host === "unpkg.com") {
    e.respondWith(DEV && url.origin === self.location.origin ? networkFirst(VERSION, req) : staleWhileRevalidate(VERSION, req));
  } else if (url.host === "tiles.openfreemap.org") {
    e.respondWith(url.pathname.startsWith("/styles/") ? staleWhileRevalidate(TILES, req) : cacheFirstTile(req));
  }
  // Autres origines (moteur, recherche, Overpass) : pas d'interception.
});
