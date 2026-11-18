// Couche données de Gabarit : hauteurs, recherche, itinéraires et planificateur.
// Aucun accès au DOM ici ; l'interface est dans app.js.
"use strict";

// Les adresses des services viennent de js/config.js.
const CFG = {
  tileZ: 13,                 // tuiles de 3 à 5 km : même grille que tools/build_obstacles.py
  tileTTL: 7 * 864e5,        // durée de vie du cache Overpass (IndexedDB)
  maxTilesPerQuery: 16,
  hedgeAfterMs: 3500,        // au-delà, on interroge aussi le serveur Overpass suivant
  minZoomObstacles: 12,
  routeMinIntervalMs: 1100,  // limite du serveur public FOSSGIS (1 req/s) ; 0 avec votre serveur
  ...(self.GABARIT_CONFIG || {}),
};

const Fmt = {
  m: (x) => x.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " m",
  mShort: (x) => x.toLocaleString("fr-FR", { maximumFractionDigits: 2 }) + " m",
  km(km) {
    if (km < 1) return Math.max(10, Math.round(km * 100) * 10) + " m";
    return km.toLocaleString("fr-FR", { maximumFractionDigits: km < 10 ? 1 : 0 }) + " km";
  },
  dur(sec) {
    const m = Math.max(1, Math.round(sec / 60));
    if (m < 60) return m + " min";
    const h = Math.floor(m / 60), r = m % 60;
    return h + " h" + (r ? " " + String(r).padStart(2, "0") : "");
  },
  esc: (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
  coords: (lat, lon) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
};

const Vehicle = {
  PRESETS: {
    car:    { label: "Voiture",     icon: "🚗", height: 1.6, width: 1.9,  length: 4.6,  weight: 1.8 },
    van:    { label: "Fourgon",     icon: "🚐", height: 2.7, width: 2.1,  length: 6.0,  weight: 3.5 },
    camper: { label: "Camping-car", icon: "🚌", height: 3.2, width: 2.35, length: 7.5,  weight: 3.5 },
    truck:  { label: "Camion",      icon: "🚚", height: 4.0, width: 2.55, length: 12.0, weight: 19 },
  },
  load() {
    try {
      const v = JSON.parse(localStorage.getItem("gabarit.vehicle"));
      if (v && typeof v.height === "number") return { margin: 0.1, ...v };
    } catch {}
    return { preset: "van", ...this.PRESETS.van, margin: 0.1 };
  },
  save(v) { localStorage.setItem("gabarit.vehicle", JSON.stringify(v)); },
  label(v) { return this.PRESETS[v.preset]?.label || "Véhicule personnalisé"; },
  icon(v) { return this.PRESETS[v.preset]?.icon || "🚐"; },
};

// Petit stockage clé/valeur sur IndexedDB. Si IndexedDB est indisponible (navigation
// privée), tout continue de fonctionner, simplement sans cache persistant.
const KV = (() => {
  let dbp;
  const db = () => (dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open("gabarit", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }).catch(() => null));
  return {
    async getMany(keys) {
      const d = await db();
      if (!d || !keys.length) return keys.map(() => undefined);
      return new Promise((res) => {
        const out = new Array(keys.length);
        const tx = d.transaction("kv", "readonly"), st = tx.objectStore("kv");
        keys.forEach((k, i) => { st.get(k).onsuccess = (e) => (out[i] = e.target.result); });
        tx.oncomplete = tx.onerror = () => res(out);
      });
    },
    async setMany(entries) {
      const d = await db();
      if (!d || !entries.length) return;
      const st = d.transaction("kv", "readwrite").objectStore("kv");
      for (const [k, v] of entries) st.put(v, k);
    },
  };
})();

// Grille fixe (Web Mercator) : les mêmes tuiles servent au cache, aux fichiers locaux et à Overpass.
const Tiles = {
  z: CFG.tileZ,
  x(lon) { return Math.floor(((lon + 180) / 360) * 2 ** this.z); },
  y(lat) {
    const r = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** this.z);
  },
  key(x, y) { return `v2/t${this.z}/${x}/${y}`; }, // « v2 » : version du format en cache
  keyOf(lon, lat) { return this.key(this.x(lon), this.y(lat)); },
  make(x, y) {
    const n = 2 ** this.z;
    const lat = (yy) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * yy) / n))) * 180) / Math.PI;
    return { x, y, k: this.key(x, y), b: { w: (x / n) * 360 - 180, e: ((x + 1) / n) * 360 - 180, n: lat(y), s: lat(y + 1) } };
  },
  cover(w, s, e, n) {
    const out = [];
    const x0 = this.x(w), x1 = this.x(e), y0 = this.y(n), y1 = this.y(s);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(this.make(x, y));
    return out;
  },
  // Tuiles traversées par un tracé, plus leurs voisines : un pont proche d'une limite
  // de tuile peut être rangé dans la tuile d'à côté.
  corridor(coords, max = 800) {
    const out = new Map();
    const add = (x, y) => { const k = this.key(x, y); if (!out.has(k)) out.set(k, this.make(x, y)); };
    for (let i = 0; i < coords.length && out.size < max; i++) {
      const a = coords[i], b = coords[i + 1] || a;
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.005)); // pas de ~400 m
      for (let s = 0; s < n; s++) {
        const x = this.x(a[0] + ((b[0] - a[0]) * s) / n), y = this.y(a[1] + ((b[1] - a[1]) * s) / n);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) add(x + dx, y + dy);
      }
    }
    return [...out.values()];
  },
};

// Géométrie plane locale (en mètres) : suffisant à l'échelle d'un trajet.
const Geom = {
  proj(lat0) {
    const kx = Math.cos((lat0 * Math.PI) / 180) * 111320, ky = 110540;
    return (p) => [p[0] * kx, p[1] * ky];
  },
  segDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
    let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
  },
  // Douglas-Peucker, tolérance en mètres
  simplify(coords, tol) {
    if (coords.length < 3) return coords.slice();
    const P = this.proj(coords[0][1]), pts = coords.map(P);
    const keep = new Uint8Array(coords.length);
    keep[0] = keep[coords.length - 1] = 1;
    const stack = [[0, coords.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let max = 0, idx = -1;
      for (let i = a + 1; i < b; i++) {
        const d = this.segDist(pts[i], pts[a], pts[b]);
        if (d > max) { max = d; idx = i; }
      }
      if (max > tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
    }
    return coords.filter((_, i) => keep[i]);
  },
  midAlong(g) {
    if (g.length === 1) return g[0];
    const P = this.proj(g[0][1]), pts = g.map(P);
    const seg = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
    let half = seg.reduce((a, b) => a + b, 0) / 2;
    for (let i = 0; i < seg.length; i++) {
      if (half <= seg[i] || i === seg.length - 1) {
        const t = seg[i] ? Math.min(1, half / seg[i]) : 0;
        return [g[i][0] + (g[i + 1][0] - g[i][0]) * t, g[i][1] + (g[i + 1][1] - g[i][1]) * t];
      }
      half -= seg[i];
    }
    return g[0];
  },
};

// Lecture des hauteurs OSM. Garder en phase avec tools/build_obstacles.py.
// Renvoie des mètres, "unknown" (restriction sans valeur) ou null (pas de restriction).
function parseHeight(raw) {
  if (!raw) return null;
  const v = String(raw).trim().toLowerCase().replace(",", ".");
  if (["none", "default", "no_sign", "no_indications", "unsigned", "no"].includes(v)) return null;
  if (v === "below_default") return "unknown";
  let m;
  if ((m = v.match(/^(\d+(?:\.\d+)?)\s*(?:m|meters?|mètres?)?$/))) return +m[1];
  if ((m = v.match(/^(\d+(?:\.\d+)?)\s*cm$/))) return +m[1] / 100;
  if ((m = v.match(/^(\d+)\s*'\s*(?:(\d+(?:\.\d+)?)\s*(?:"|''))?$/))) return (+m[1] * 12 + +(m[2] || 0)) * 0.0254;
  if ((m = v.match(/^(\d+(?:\.\d+)?)\s*ft$/))) return +m[1] * 0.3048;
  return null;
}

function heightLimit(t) {
  const vals = [t.maxheight, t["maxheight:physical"]].map(parseHeight);
  const nums = vals.filter((x) => typeof x === "number" && x > 0.8 && x < 10);
  if (nums.length) return Math.min(...nums);
  if (vals.includes("unknown")) return "unknown";
  // Un tunnel ou un portique sans hauteur indiquée compte comme « hauteur inconnue ».
  const untagged = !t.maxheight && !t["maxheight:physical"];
  const risky = (t.tunnel && t.tunnel !== "no") || t.covered === "yes" || t.barrier === "height_restrictor";
  return untagged && risky ? "unknown" : null;
}

function obstacleKind(t) {
  if (t.barrier === "height_restrictor") return "Portique";
  if (t.tunnel && t.tunnel !== "no") return "Tunnel";
  if (t.covered === "yes") return "Passage couvert";
  if (t.amenity === "parking" || t.parking) return "Parking";
  if (t.highway) return "Passage sous un pont";
  return "Hauteur limitée";
}

// Élément Overpass -> passage. Les voies gardent leur géométrie complète (`g`)
// quand elle est fournie : le contrôle du trajet en a besoin.
function elementToItem(el) {
  const t = el.tags || {};
  const lim = heightLimit(t);
  if (lim === null) return null;
  let lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon, g = null;
  if (el.geometry?.length) {
    g = el.geometry.map((p) => [+p.lon.toFixed(6), +p.lat.toFixed(6)]);
    [lon, lat] = Geom.midAlong(g);
  }
  if (lat == null || lon == null) return null;
  return {
    id: `${el.type}/${el.id}`, lat, lon, g,
    lim: typeof lim === "number" ? Math.round(lim * 100) / 100 : null,
    k: obstacleKind(t), n: t.name || t["bridge:name"] || "",
  };
}

// Hauteurs extraites par tools/build_obstacles.py. meta.json liste les tuiles couvertes
// par le fichier OSM : une tuile couverte sans fichier n'a aucun obstacle, une tuile
// non couverte est simplement inconnue.
const LocalData = (() => {
  let metaP = null;
  const tiles = new Map();
  function meta() {
    if (!CFG.obstacleTiles) return Promise.resolve(null);
    return (metaP ??= fetch(`${CFG.obstacleTiles}/meta.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => (m ? { ...m, set: new Set(m.covered) } : null))
      .catch(() => null));
  }
  const covers = (m, t) => !!m && m.set.has(`${t.x}/${t.y}`);
  function tile(t) {
    if (!tiles.has(t.k)) {
      tiles.set(t.k, fetch(`${CFG.obstacleTiles}/${CFG.tileZ}/${t.x}/${t.y}.json`)
        .then((r) => (r.ok ? r.json() : r.status === 404 ? [] : Promise.reject(new Error("HTTP " + r.status))))
        .catch((e) => { tiles.delete(t.k); throw e; }));
    }
    return tiles.get(t.k);
  }
  return { meta, covers, tile };
})();

// Interroge le premier serveur Overpass, puis le suivant s'il échoue ou s'il traîne.
// La première réponse valide gagne, les autres requêtes sont annulées.
function hedgedOverpass(query) {
  const urls = CFG.overpass || [];
  return new Promise((resolve, reject) => {
    if (!urls.length) return reject(new Error("aucun serveur Overpass configuré"));
    let done = false, started = 0, failures = 0;
    const ctrls = [];
    const finish = () => { clearTimeout(hedge); ctrls.forEach((c) => c.abort()); };
    const start = () => {
      if (done || started >= urls.length) return;
      const c = new AbortController();
      ctrls.push(c);
      const timeout = setTimeout(() => c.abort(), 25000);
      fetch(urls[started++], {
        method: "POST", signal: c.signal,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query),
      })
        .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then((j) => { if (!done) { done = true; finish(); resolve(j); } })
        .catch((e) => {
          if (done) return;
          if (++failures >= urls.length) { done = true; finish(); reject(e); }
          else start();
        })
        .finally(() => clearTimeout(timeout));
    };
    const hedge = setTimeout(start, CFG.hedgeAfterMs);
    start();
  });
}

// Passages affichés sur la carte, chargés par tuile : fichiers locaux d'abord,
// Overpass seulement hors de la zone téléchargée.
const Obstacles = (() => {
  const items = new Map();      // id -> { id, lat, lon, g?, lim, k, n }
  const fresh = new Set();      // tuiles à jour
  const hydrated = new Set();   // tuiles déjà relues depuis IndexedDB
  const inflight = new Set();
  const retryAt = new Map();
  const on = { change: [], status: [] };
  let wanted = [], running = false, fails = 0, retryTimer = null, emitQueued = false;

  const emit = () => {
    if (emitQueued) return;
    emitQueued = true;
    requestAnimationFrame(() => { emitQueued = false; on.change.forEach((f) => f()); });
  };
  const status = (s) => on.status.forEach((f) => f(s));
  // Ne jamais remplacer une version avec géométrie par une version « point seul ».
  const store = (it) => { const old = items.get(it.id); if (!old || it.g || !old.g) items.set(it.id, it); };

  function overpassQuery(batch) {
    const xs = batch.map((t) => t.x), ys = batch.map((t) => t.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const isRect = (x1 - x0 + 1) * (y1 - y0 + 1) === batch.length;
    const boxes = isRect
      ? [{ w: Tiles.make(x0, y0).b.w, n: Tiles.make(x0, y0).b.n, e: Tiles.make(x1, y1).b.e, s: Tiles.make(x1, y1).b.s }]
      : batch.map((t) => t.b);
    const parts = boxes.map((b) => {
      const bb = [b.s, b.w, b.n, b.e].map((v) => v.toFixed(5)).join(",");
      return `nwr["maxheight"](${bb});nwr["maxheight:physical"](${bb});`;
    }).join("");
    return `[out:json][timeout:20];(${parts});out tags center qt;`;
  }

  async function loadLocal(tiles) {
    tiles.forEach((t) => inflight.add(t.k));
    try {
      const lists = await Promise.all(tiles.map((t) => LocalData.tile(t)));
      lists.flat().forEach(store);
      tiles.forEach((t) => fresh.add(t.k));
      emit();
    } catch {
      tiles.forEach((t) => retryAt.set(t.k, Date.now() + 5000));
    } finally {
      tiles.forEach((t) => inflight.delete(t.k));
    }
  }

  // Renvoie false si on doit s'arrêter (serveurs saturés : nouvel essai programmé).
  async function loadRemote(batch) {
    batch.forEach((t) => inflight.add(t.k));
    status("loading");
    try {
      const json = await hedgedOverpass(overpassQuery(batch));
      const perTile = new Map(batch.map((t) => [t.k, []]));
      for (const el of json.elements || []) {
        const it = elementToItem(el);
        if (!it) continue;
        store(it);
        perTile.get(Tiles.keyOf(it.lon, it.lat))?.push(it);
      }
      const t = Date.now();
      KV.setMany([...perTile].map(([k, list]) => [k, { t, items: list }]));
      batch.forEach((b) => { fresh.add(b.k); retryAt.delete(b.k); });
      fails = 0;
      emit();
      return true;
    } catch {
      fails++;
      const delay = Math.min(30000, 3000 * 2 ** (fails - 1));
      batch.forEach((b) => retryAt.set(b.k, Date.now() + delay));
      status("error");
      clearTimeout(retryTimer);
      retryTimer = setTimeout(pump, delay + 50);
      return false;
    } finally {
      batch.forEach((b) => inflight.delete(b.k));
    }
  }

  async function pump() {
    if (running) return;
    running = true;
    try {
      for (;;) {
        const now = Date.now();
        const todo = wanted.filter((t) => !fresh.has(t.k) && !inflight.has(t.k) && !((retryAt.get(t.k) || 0) > now));
        if (!todo.length) break;
        const m = await LocalData.meta();
        const local = todo.filter((t) => LocalData.covers(m, t));
        if (local.length) { await loadLocal(local); continue; }
        if (!CFG.overpassFallback) { todo.forEach((t) => fresh.add(t.k)); continue; }
        if (!(await loadRemote(todo.slice(0, CFG.maxTilesPerQuery)))) break;
      }
    } finally {
      running = false;
      if (!wanted.some((t) => !fresh.has(t.k))) status("idle");
    }
  }

  async function request(tiles) {
    wanted = tiles;
    // Affichage immédiat depuis le cache Overpass (même périmé), mise à jour ensuite.
    const todo = tiles.filter((t) => !fresh.has(t.k) && !hydrated.has(t.k));
    if (todo.length) {
      todo.forEach((t) => hydrated.add(t.k));
      const vals = await KV.getMany(todo.map((t) => t.k));
      let any = false;
      vals.forEach((v, i) => {
        if (!v) return;
        v.items.forEach(store);
        any = any || v.items.length > 0;
        if (Date.now() - v.t < CFG.tileTTL) fresh.add(todo[i].k);
      });
      if (any) emit();
    }
    pump();
  }

  return {
    items, request,
    add(list) { list.forEach(store); emit(); },
    on: (ev, f) => on[ev].push(f),
    get: (id) => items.get(id),
  };
})();

// Recherche d'adresses (Photon)
const Geo = (() => {
  const cache = new Map();
  const RECENT_KEY = "gabarit.recent";
  let ctrl;
  function toPlace(f) {
    const p = f.properties, [lon, lat] = f.geometry.coordinates;
    const street = [p.housenumber, p.street].filter(Boolean).join(" ");
    const name = p.name || street || p.city || "Lieu";
    const sub = [p.name ? street : "", p.postcode, p.city || p.county, p.country].filter((x) => x && x !== name).join(", ");
    return { lat, lon, name, sub };
  }
  async function search(q, near) {
    const key = q.trim().toLowerCase() + "|" + (near ? near.lat.toFixed(1) + "," + near.lon.toFixed(1) : "");
    if (cache.has(key)) return cache.get(key);
    ctrl?.abort();
    ctrl = new AbortController();
    let url = `${CFG.photon}/api/?q=${encodeURIComponent(q)}&lang=fr&limit=7`;
    if (near) url += `&lat=${near.lat.toFixed(3)}&lon=${near.lon.toFixed(3)}`;
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const seen = new Set();
    const list = (await r.json()).features.map(toPlace).filter((p) => {
      const k = p.name + "|" + p.sub;
      return !seen.has(k) && seen.add(k);
    });
    cache.set(key, list);
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return list;
  }
  async function reverse(lat, lon) {
    try {
      const r = await fetch(`${CFG.photon}/reverse?lat=${lat}&lon=${lon}&lang=fr`);
      const f = (await r.json()).features?.[0];
      return f ? toPlace(f) : null;
    } catch { return null; }
  }
  function recents() { try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; } }
  function addRecent(p) {
    const list = recents().filter((r) => !(r.name === p.name && r.sub === p.sub));
    list.unshift({ lat: p.lat, lon: p.lon, name: p.name, sub: p.sub });
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8)));
  }
  return { search, reverse, recents, addRecent };
})();

// Itinéraires (Valhalla)
class RouteError extends Error {
  constructor(msg, code) { super(msg); this.code = code; }
}
const NO_ROUTE_CODES = new Set([171, 442]); // codes Valhalla « aucun chemin possible »

const Router = (() => {
  const cache = new Map();
  const key = (a, b, v, o) => [a.lat, a.lon, b.lat, b.lon].map((x) => x.toFixed(5))
    .concat([v.ref ? "ref" : [v.height, v.width, v.length, v.weight, v.margin].join(","), o.alternates,
      (o.exclude || []).map((e) => e.lat.toFixed(6) + "," + e.lon.toFixed(6) + "," + (e.heading ?? "")).join(";")]).join("|");

  function decodePolyline6(str) {
    let i = 0, lat = 0, lon = 0;
    const out = [];
    const next = () => { let r = 0, s = 0, b; do { b = str.charCodeAt(i++) - 63; r |= (b & 0x1f) << s; s += 5; } while (b >= 0x20); return r & 1 ? ~(r >> 1) : r >> 1; };
    while (i < str.length) { lat += next(); lon += next(); out.push([lon / 1e6, lat / 1e6]); }
    return out;
  }
  // Les requêtes partent une par une, espacées de routeMinIntervalMs.
  let nextSlot = 0;
  async function slot() {
    const now = Date.now(), wait = Math.max(0, nextSlot - now);
    nextSlot = Math.max(now, nextSlot) + CFG.routeMinIntervalMs;
    if (wait) await new Promise((r) => setTimeout(r, wait));
  }
  function parseTrip(trip) {
    const maneuvers = trip.legs.flatMap((l) => l.maneuvers);
    const longest = maneuvers.filter((m) => m.street_names?.length).sort((a, b) => b.length - a.length)[0];
    return {
      coords: trip.legs.flatMap((l) => decodePolyline6(l.shape)),
      time: trip.summary.time, length: trip.summary.length,
      via: longest ? longest.street_names[0] : "",
      maneuvers: maneuvers.map((m) => ({ type: m.type, text: m.instruction, len: m.length })),
    };
  }
  // v.ref : trajet « voiture » sans contrainte, qui sert de référence pour expliquer les détours.
  async function fetchRoute(from, to, v, o) {
    const heavy = !v.ref && v.weight > 3.5;
    const costing = heavy ? "truck" : "auto";
    // La marge de sécurité est ajoutée à la hauteur envoyée au moteur.
    const opts = v.ref ? {} : { height: +(v.height + v.margin).toFixed(2), width: v.width };
    if (heavy) Object.assign(opts, { length: v.length, weight: v.weight });
    const body = {
      locations: [{ lat: from.lat, lon: from.lon }, { lat: to.lat, lon: to.lon }],
      costing, costing_options: { [costing]: opts },
      directions_options: { language: "fr-FR", units: "kilometers" },
    };
    if (o.alternates) body.alternates = o.alternates;
    if (o.exclude?.length) body.exclude_locations = o.exclude;
    await slot();
    const r = await fetch(CFG.valhalla + "?json=" + encodeURIComponent(JSON.stringify(body)));
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.trip) throw new RouteError(j.error || "HTTP " + r.status, j.error_code);
    return [j.trip, ...(j.alternates || []).map((a) => a.trip)].map(parseTrip);
  }
  // La promesse est partagée : le précalcul du temps de trajet et le clic sur
  // « Itinéraire » réutilisent la même requête.
  function route(from, to, v, o = {}) {
    o = { alternates: 2, ...o };
    const k = key(from, to, v, o);
    if (!cache.has(k)) {
      cache.set(k, fetchRoute(from, to, v, o).catch((e) => { cache.delete(k); throw e; }));
      if (cache.size > 50) cache.delete(cache.keys().next().value);
    }
    return cache.get(k);
  }
  return { route };
})();

async function loadMapStyle() {
  const r = await fetch(CFG.style);
  if (!r.ok) throw new Error("style " + r.status);
  const s = await r.json();
  // Sans bâtiments 3D : rendu nettement plus fluide sur téléphone.
  s.layers = s.layers.filter((l) => l.type !== "fill-extrusion");
  return s;
}

// Passages situés le long d'un ou plusieurs tracés.
const Corridor = (() => {
  const cache = new Map();

  async function fromLocal(lines) {
    const m = await LocalData.meta();
    if (!m) return null;
    const tiles = new Map();
    for (const c of lines) for (const t of Tiles.corridor(c)) tiles.set(t.k, t);
    const all = [...tiles.values()];
    const inside = all.filter((t) => LocalData.covers(m, t));
    const list = (await Promise.all(inside.map((t) => LocalData.tile(t)))).flat();
    Obstacles.add(list);
    return { list, complete: inside.length === all.length };
  }

  function polyline(coords) {
    let tol = 8, s = Geom.simplify(coords, tol);
    while (s.length > 2500) { tol *= 2; s = Geom.simplify(coords, tol); }
    return s.map(([lon, lat]) => `${lat.toFixed(6)},${lon.toFixed(6)}`).join(",");
  }

  // Une seule requête Overpass pour tout le couloir (around: sur une polyligne).
  function fromOverpass(lines) {
    const polys = lines.map(polyline);
    const k = polys.join("|");
    if (cache.has(k)) return cache.get(k);
    const body = polys.map((p) =>
      `nw["maxheight"](around:20,${p});nw["maxheight:physical"](around:20,${p});` +
      `way["highway"]["tunnel"~"^(yes|building_passage)$"][!"maxheight"](around:12,${p});` +
      `way["highway"]["covered"="yes"][!"maxheight"](around:12,${p});` +
      `node["barrier"="height_restrictor"][!"maxheight"](around:10,${p});`).join("");
    const pr = hedgedOverpass(`[out:json][timeout:30];(${body});out tags geom qt;`).then((j) => {
      const list = (j.elements || []).map(elementToItem).filter(Boolean);
      Obstacles.add(list);
      return list;
    });
    cache.set(k, pr.catch((e) => { cache.delete(k); throw e; }));
    if (cache.size > 30) cache.delete(cache.keys().next().value);
    return cache.get(k);
  }

  // Résultat marqué `partial` quand une partie du trajet sort de la zone téléchargée
  // et qu'Overpass n'est pas utilisé en secours.
  async function fetch(lines) {
    const local = await fromLocal(lines);
    if (local && (local.complete || !CFG.overpassFallback)) {
      local.list.partial = !local.complete;
      return local.list;
    }
    return fromOverpass(lines);
  }
  return { fetch };
})();

// Quels passages le tracé EMPRUNTE-t-il vraiment ?
// - nœud (portique…) : le tracé passe à moins de 8 m ;
// - voie (dessous de pont, tunnel) : le tracé la longe à moins de 7 m, dans la même
//   direction, sur au moins 12 m. Un pont franchi par-dessus croise la voie à angle
//   et n'est donc pas compté.
function checkRoute(coords, items, v) {
  const P = Geom.proj(coords[coords.length >> 1][1]);
  const pts = coords.map(P);
  // Index spatial des segments du tracé (cases de 50 m).
  const CELL = 50, grid = new Map();
  const put = (cx, cy, i) => { const k = cx + "," + cy; (grid.get(k) || grid.set(k, []).get(k)).push(i); };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / CELL));
    for (let s = 0; s <= n; s++) put(Math.floor((a[0] + ((b[0] - a[0]) * s) / n) / CELL), Math.floor((a[1] + ((b[1] - a[1]) * s) / n) / CELL), i);
  }
  const nearest = (p) => {
    const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL);
    let best = Infinity, bi = -1;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const list = grid.get(cx + dx + "," + (cy + dy));
      if (list) for (const i of list) { const d = Geom.segDist(p, pts[i], pts[i + 1]); if (d < best) { best = d; bi = i; } }
    }
    return [best, bi];
  };

  const res = { blocked: [], unknown: [], ok: [] };
  for (const it of items) {
    let hit = null;
    if (!it.g) {
      const [d] = nearest(P([it.lon, it.lat]));
      if (d <= 8) hit = { lat: it.lat, lon: it.lon, heading: null };
    } else {
      const g = it.g.map(P);
      let aligned = 0, total = 0, best = null;
      for (let j = 0; j < g.length - 1; j++) {
        const a = g[j], b = g[j + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        total += L;
        if (!L) continue;
        const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
        const n = Math.max(1, Math.ceil(L / 4)), step = L / n;
        for (let s = 0; s <= n; s++) {
          const f = s / n, p = [a[0] + ux * L * f, a[1] + uy * L * f];
          const [d, i] = nearest(p);
          if (i < 0 || d > 7) continue;
          const r0 = pts[i], r1 = pts[i + 1], rl = Math.hypot(r1[0] - r0[0], r1[1] - r0[1]) || 1;
          if (Math.abs((ux * (r1[0] - r0[0]) + uy * (r1[1] - r0[1])) / rl) < 0.85) continue; // croisement
          aligned += step;
          if (!best || d < best.d) {
            best = {
              d, lon: it.g[j][0] + (it.g[j + 1][0] - it.g[j][0]) * f, lat: it.g[j][1] + (it.g[j + 1][1] - it.g[j][1]) * f,
              heading: Math.round(((Math.atan2(ux, uy) * 180) / Math.PI + 360) % 360),
            };
          }
        }
      }
      if (best && aligned >= Math.min(12, total * 0.5)) hit = best;
    }
    if (!hit) continue;
    const entry = { item: it, at: hit };
    if (it.lim == null) res.unknown.push(entry);
    else if (it.lim < v.height + v.margin) res.blocked.push(entry);
    else res.ok.push(entry);
  }
  return res;
}

// OSM découpe souvent un même pont en plusieurs tronçons : on les regroupe pour l'affichage.
function groupObstacles(list) {
  const out = [];
  for (const it of list) {
    const dup = out.find((o) => o.lim === it.lim && (o.n || o.k) === (it.n || it.k) &&
      Math.abs(o.lat - it.lat) < 0.0008 && Math.abs(o.lon - it.lon) < 0.0012);
    if (!dup) out.push(it);
  }
  return out;
}

// Planificateur : Valhalla calcule avec hauteur + marge, puis chaque trajet est contrôlé
// passage par passage. Si un passage trop bas reste sur le plus rapide (donnée que le
// moteur n'a pas, ou tronçon mal relié), il est exclu et on recalcule, jusqu'à 3 fois.
//
// Résultat : { status: "ok" | "unverified" | "none", routes, avoided, partial?, sameAsCar?, blockedBy? }
const Planner = (() => {
  const REF = { ref: true };
  const same = (a, b) => Math.abs(a.length - b.length) < 0.02 * a.length && Math.abs(a.time - b.time) < 0.02 * a.time + 15;

  function addExclusion(list, at) {
    if (list.some((e) => Math.abs(e.lat - at.lat) < 1e-5 && Math.abs(e.lon - at.lon) < 1e-5)) return;
    if (at.heading == null) { list.push({ lat: at.lat, lon: at.lon, radius: 4 }); return; }
    // Un cap par sens de circulation, pour ne pas exclure le pont qui passe au-dessus.
    list.push({ lat: at.lat, lon: at.lon, heading: at.heading, heading_tolerance: 35, radius: 4 });
    list.push({ lat: at.lat, lon: at.lon, heading: (at.heading + 180) % 360, heading_tolerance: 35, radius: 4 });
  }

  // onDraft(routes) est appelé dès la première réponse du moteur, pour afficher le tracé
  // pendant le contrôle.
  async function plan(from, to, v, onDraft) {
    const mainP = Router.route(from, to, v);
    const refP = Router.route(from, to, REF, { alternates: 0 }).catch(() => null);
    let routes;
    try { routes = await mainP; }
    catch (e) {
      if (e instanceof RouteError && NO_ROUTE_CODES.has(e.code)) return { status: "none", routes: [], avoided: [], blockedBy: [] };
      throw e;
    }
    onDraft?.(routes);

    const items = new Map();
    let partial = false;
    const fetchFor = async (lines) => {
      try {
        const list = await Corridor.fetch(lines);
        if (list.partial) partial = true;
        list.forEach((it) => items.set(it.id, it));
        return true;
      } catch { return false; }
    };
    let verified = await fetchFor(routes.map((r) => r.coords));
    if (!verified) return { status: "unverified", routes, avoided: [] };

    // Les trajets sortent du cache du Router : on ne les modifie pas, le contrôle est stocké à côté.
    const pool = [];
    const entryOf = (r) => pool.find((p) => p.r === r || same(p.r, r));
    const check = (list) => list.forEach((r) => {
      if (!entryOf(r)) pool.push({ r, check: checkRoute(r.coords, [...items.values()], v) });
    });
    check(routes);

    const exclude = [];
    for (let round = 0; round < 3; round++) {
      const blocked = entryOf(routes[0]).check.blocked;
      if (!blocked.length) break;
      blocked.forEach((b) => addExclusion(exclude, b.at));
      try { routes = await Router.route(from, to, v, { exclude }); }
      catch (e) { if (e instanceof RouteError) break; throw e; }
      if (!(await fetchFor(routes.map((r) => r.coords)))) { verified = false; break; }
      check(routes);
    }

    const compatible = pool.filter((p) => p.check.blocked.length === 0)
      .sort((a, b) => a.r.time - b.r.time).slice(0, 3)
      .map((p) => ({ ...p.r, check: p.check }));
    if (!compatible.length) {
      const blocked = new Map();
      pool.forEach((p) => p.check.blocked.forEach((b) => blocked.set(b.item.id, b.item)));
      return { status: "none", routes: [], avoided: [], blockedBy: groupObstacles([...blocked.values()]) };
    }

    // Passages trop bas qu'aurait empruntés le trajet voiture : ils expliquent le détour.
    let avoided = [], sameAsCar = false;
    const ref = await refP;
    if (ref && (await fetchFor([ref[0].coords]))) {
      const refCheck = checkRoute(ref[0].coords, [...items.values()], v);
      const onChosen = new Set(compatible[0].check.ok.concat(compatible[0].check.unknown).map((e) => e.item.id));
      avoided = groupObstacles(refCheck.blocked.map((b) => b.item).filter((it) => !onChosen.has(it.id)));
      sameAsCar = same(ref[0], compatible[0]);
    }
    if (!verified || partial) return { status: "unverified", partial, routes: compatible, avoided };
    return { status: "ok", routes: compatible, avoided, sameAsCar };
  }
  return { plan };
})();
