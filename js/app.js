// Interface de Gabarit. Une seule page, deux mises en page : panneau latéral au-dessus
// de 768 px, feuille glissante en dessous (voir css/app.css).
"use strict";
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const mq = matchMedia("(max-width: 768px)");
  const isMobile = () => mq.matches;
  const motion = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  const dur = (ms) => (motion ? ms : 0);
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const FC = (features = []) => ({ type: "FeatureCollection", features });
  const cm = (m) => Math.round(m * 100);
  const plural = (n, s = "s") => (n > 1 ? s : "");
  const PANEL_W = 416; // largeur du panneau ordinateur, cf. #sheet dans css/app.css

  const ICON = {
    pin: '<svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7Zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5Z"/></svg>',
    clock: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16Zm.5-13H11v6l5.2 3.2.8-1.3-4.5-2.7V7Z"/></svg>',
    me: '<svg viewBox="0 0 24 24"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm8.9 3A9 9 0 0 0 13 3.1V1h-2v2.1A9 9 0 0 0 3.1 11H1v2h2.1a9 9 0 0 0 7.9 7.9V23h2v-2.1a9 9 0 0 0 7.9-7.9H23v-2h-2.1ZM12 19a7 7 0 1 1 0-14 7 7 0 0 1 0 14Z"/></svg>',
  };
  // Types de manœuvre Valhalla -> flèche affichée
  const ARROW = { 1: "⬆", 2: "⬆", 3: "⬆", 4: "⚑", 5: "⚑", 6: "⚑", 7: "⬆", 8: "⬆", 9: "↗", 10: "➡", 11: "↪", 12: "↩", 13: "↩", 14: "⬅", 15: "⬅", 16: "↖", 17: "⬆", 18: "↗", 19: "↖", 20: "↗", 21: "↖", 22: "⬆", 23: "↗", 24: "↖", 25: "⬆", 26: "⟳", 27: "⟳", 28: "⛴", 29: "⛴", 37: "↗", 38: "↖" };

  const state = { view: "home", dirActive: false, place: null, from: null, to: null, plan: null, sel: 0, vehicle: Vehicle.load() };

  // --- Carte ---
  let map = null, mapReady = false;
  const pending = [];
  const onMap = (fn) => (mapReady ? fn() : pending.push(fn));
  const savedView = (() => { try { return JSON.parse(localStorage.getItem("gabarit.view")); } catch { return null; } })() || { c: [2.3488, 48.8534], z: 13.5 };

  async function initMap() {
    // Style allégé s'il arrive vite, sinon le style d'origine pour ne pas retarder la carte.
    const style = await Promise.race([loadMapStyle(), new Promise((r) => setTimeout(() => r(CFG.style), 2500))]).catch(() => CFG.style);
    map = new maplibregl.Map({
      container: "map", style, center: savedView.c, zoom: savedView.z,
      attributionControl: false, pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      fadeDuration: 100, maxZoom: 19, refreshExpiredTiles: false,
    });
    map.addControl(new maplibregl.AttributionControl({
      compact: true,
      customAttribution: '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© contributeurs OpenStreetMap</a> (ODbL) · <a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noopener">Signaler une erreur</a> · Itinéraires Valhalla · Recherche Photon',
    }), "bottom-right");
    new ResizeObserver(() => map.resize()).observe($("#map"));
    map.on("load", onLoad);
    map.on("moveend", onMoveEnd);
    map.on("rotate", updateCompass);
    map.on("pitch", updateCompass);
    map.on("contextmenu", (e) => pickPoint(e.lngLat));
    setupLongPress();
    requestViewObstacles(); // démarre avant même la fin du chargement de la carte
  }

  // gray : hauteur inconnue, red : ne passe pas, orange : passe mais sous la marge, green : passe.
  function fitClass(lim) {
    const { height: H, margin: M } = state.vehicle;
    return lim == null ? "gray" : lim < H ? "red" : lim < H + M ? "orange" : "green";
  }
  function colorExpr() {
    const { height: H, margin: M } = state.vehicle;
    return ["case", ["!", ["has", "lim"]], "#9aa0a6", ["<", ["get", "lim"], H], "#e53935", ["<", ["get", "lim"], H + M], "#fb8c00", "#2e9d4a"];
  }
  const marginLabel = () => `${Fmt.m(state.vehicle.height)} + ${cm(state.vehicle.margin)} cm de marge`;
  function applyVehicleColors() {
    map.setPaintProperty("obstacle-signs", "circle-stroke-color", colorExpr());
    map.setPaintProperty("hl-signs", "circle-stroke-color", colorExpr());
  }

  function onLoad() {
    const beforeLabels = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
    const w = (a, b) => ["interpolate", ["linear"], ["zoom"], 6, a, 16, b];
    const line = { "line-cap": "round", "line-join": "round" };
    map.addSource("routes", { type: "geojson", data: FC() });
    map.addLayer({ id: "route-alt-casing", type: "line", source: "routes", filter: ["!", ["get", "sel"]], layout: line, paint: { "line-color": "#8193ab", "line-width": w(6, 13) } }, beforeLabels);
    map.addLayer({ id: "route-alt", type: "line", source: "routes", filter: ["!", ["get", "sel"]], layout: line, paint: { "line-color": "#bcc9db", "line-width": w(4, 9) } }, beforeLabels);
    map.addLayer({ id: "route-casing", type: "line", source: "routes", filter: ["get", "sel"], layout: line, paint: { "line-color": "#1552b5", "line-width": w(7, 14) } }, beforeLabels);
    map.addLayer({ id: "route-line", type: "line", source: "routes", filter: ["get", "sel"], layout: line, paint: { "line-color": "#2f80ed", "line-width": w(4.5, 9) } }, beforeLabels);

    map.addSource("obstacles", { type: "geojson", data: obstacleFC(), buffer: 32 });
    map.addSource("highlight", { type: "geojson", data: FC() });
    map.addLayer({ id: "hl-halo", type: "circle", source: "highlight", paint: {
      "circle-radius": w(12, 26),
      "circle-color": ["match", ["get", "kind"], "avoided", "rgba(229,57,53,0.16)", "rgba(251,140,0,0.16)"],
      "circle-stroke-color": ["match", ["get", "kind"], "avoided", "#e53935", "#fb8c00"], "circle-stroke-width": 1.5 } });
    const sign = { "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 10, 12, 11, 16, 17], "circle-color": "#fff", "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 12, 3, 16, 4], "circle-stroke-color": colorExpr() };
    const label = { "text-field": ["get", "label"], "text-font": ["Noto Sans Bold"], "text-size": ["interpolate", ["linear"], ["zoom"], 8, 8, 12, 8, 16, 11], "text-allow-overlap": true, "text-ignore-placement": true };
    map.addLayer({ id: "obstacle-signs", type: "circle", source: "obstacles", minzoom: CFG.minZoomObstacles, paint: sign });
    map.addLayer({ id: "obstacle-labels", type: "symbol", source: "obstacles", minzoom: CFG.minZoomObstacles, layout: label, paint: { "text-color": "#1f1f1f" } });
    // Les passages qui expliquent le trajet restent visibles à faible zoom.
    map.addLayer({ id: "hl-signs", type: "circle", source: "highlight", maxzoom: CFG.minZoomObstacles, paint: sign });
    map.addLayer({ id: "hl-labels", type: "symbol", source: "highlight", maxzoom: CFG.minZoomObstacles, layout: label, paint: { "text-color": "#1f1f1f" } });

    for (const id of ["obstacle-signs", "hl-signs"]) {
      map.on("click", id, (e) => { e.preventDefault(); showObstacle(e.features[0].properties.id); });
      map.on("mouseenter", id, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", id, () => (map.getCanvas().style.cursor = ""));
    }
    for (const id of ["route-alt", "route-alt-casing"]) {
      map.on("click", id, (e) => { if (!e.defaultPrevented) selectRoute(e.features[0].properties.idx); });
      map.on("mouseenter", id, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", id, () => (map.getCanvas().style.cursor = ""));
    }
    // Mentions repliées dans le bouton (i) : elles ne cachent pas la carte.
    document.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
    mapReady = true;
    pending.splice(0).forEach((f) => f());
    updateHint();
  }

  const saveView = debounce(() => {
    const c = map.getCenter();
    localStorage.setItem("gabarit.view", JSON.stringify({ c: [+c.lng.toFixed(5), +c.lat.toFixed(5)], z: +map.getZoom().toFixed(2) }));
  }, 500);
  const onMoveEnd = () => { saveView(); requestViewObstaclesSoon(); updateHint(); };

  // --- Passages bas (affichage) ---
  const labelOf = (lim) => (lim == null ? "?" : lim.toLocaleString("fr-FR", { maximumFractionDigits: 2 }));
  function obstacleFC() {
    const f = [];
    for (const it of Obstacles.items.values()) {
      const props = { id: it.id, label: labelOf(it.lim) };
      if (it.lim != null) props.lim = it.lim;
      f.push({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: [it.lon, it.lat] } });
    }
    return FC(f);
  }
  Obstacles.on("change", () => onMap(() => map.getSource("obstacles").setData(obstacleFC())));
  let lastErrToast = 0;
  Obstacles.on("status", (s) => {
    $("#progress").hidden = s !== "loading";
    if (s === "error" && Date.now() - lastErrToast > 60000) {
      lastErrToast = Date.now();
      toast("Serveur des hauteurs saturé — nouvel essai automatique", 4000);
    }
  });

  function requestViewObstacles() {
    if (!map) return;
    if (map.getZoom() < CFG.minZoomObstacles) { Obstacles.request([]); return; }
    const b = map.getBounds();
    const dx = (b.getEast() - b.getWest()) * 0.25, dy = (b.getNorth() - b.getSouth()) * 0.25;
    let tiles = Tiles.cover(b.getWest() - dx, b.getSouth() - dy, b.getEast() + dx, b.getNorth() + dy);
    if (tiles.length > 36) tiles = Tiles.cover(b.getWest(), b.getSouth(), b.getEast(), b.getNorth());
    const c = map.getCenter(), cx = Tiles.x(c.lng), cy = Tiles.y(c.lat);
    tiles.sort((a, b2) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b2.x - cx, b2.y - cy));
    Obstacles.request(tiles.slice(0, 48));
  }
  const requestViewObstaclesSoon = debounce(requestViewObstacles, 200);

  function updateHint() {
    if (!map) return;
    const hint = $("#hint");
    const show = map.getZoom() < CFG.minZoomObstacles && !state.dirActive && state.view === "home";
    hint.hidden = !show;
    if (show) hint.textContent = "Zoomez pour voir les passages bas";
  }

  let popup = null;
  function showObstacle(id) {
    const it = Obstacles.get(id);
    if (!it || !map) return;
    const H = state.vehicle.height, cls = fitClass(it.lim);
    const txt = {
      gray: "Hauteur non indiquée — prudence",
      red: `Ne passe pas (${cm(H - it.lim)} cm de trop)`,
      orange: `Sous votre marge de sécurité (${cm(it.lim - H)} cm d'espace) — évité`,
      green: `Passe (${cm(it.lim - H)} cm de marge)`,
    }[cls];
    const html = `<div class="pop"><h3>${Fmt.esc(it.n || it.k)}</h3>
      ${it.n ? `<div class="kv"><span>Type</span><b>${Fmt.esc(it.k)}</b></div>` : ""}
      <div class="kv"><span>Hauteur max</span><b>${it.lim != null ? Fmt.m(it.lim) : "inconnue"}</b></div>
      <div class="kv"><span>Votre véhicule</span><b>${Fmt.m(H)}</b></div>
      <div class="verdict ${cls}">${txt}</div>
      <a href="https://www.openstreetmap.org/${it.id}" target="_blank" rel="noopener">Voir / corriger sur OpenStreetMap ↗</a></div>`;
    popup?.remove();
    popup = new maplibregl.Popup({ offset: 16, maxWidth: "290px" }).setLngLat([it.lon, it.lat]).setHTML(html).addTo(map);
  }
  function flyToObstacle(id) {
    const it = Obstacles.get(id);
    if (!it) return;
    if (isMobile()) Sheet.snap("peek");
    map.flyTo({ center: [it.lon, it.lat], zoom: Math.max(map.getZoom(), 16), padding: mapPad("peek"), duration: dur(700), essential: true });
    map.once("moveend", () => showObstacle(id));
  }

  // --- Feuille (téléphone) ---
  const sheet = $("#sheet"), scroller = $("#sheet-scroll");
  const HANDLE = 22;
  const Sheet = {
    y: innerHeight, state: "peek",
    barBottom() { return (state.dirActive ? $("#dirbar") : $("#searchbar")).getBoundingClientRect().bottom; },
    fullY() { return Math.round(this.barBottom() + 10); },
    peekY() {
      const view = $(`.view[data-view="${state.view}"]`);
      const mark = view && [...view.querySelectorAll("[data-peek]")].find((e) => e.offsetParent);
      const vis = mark ? HANDLE + mark.offsetTop + mark.offsetHeight + 14 : 150;
      return Math.max(this.fullY(), Math.round(innerHeight - vis));
    },
    halfY() { return Math.max(this.fullY(), Math.min(Math.round(innerHeight * 0.5), this.peekY())); },
    yFor(s) { return s === "full" ? this.fullY() : s === "half" ? this.halfY() : this.peekY(); },
    apply(y, animate) {
      this.y = y;
      sheet.classList.toggle("dragging", !animate);
      sheet.style.transform = `translate3d(0,${y}px,0)`;
      document.documentElement.style.setProperty("--sheet-visible", Math.max(0, innerHeight - y) + "px");
    },
    snap(s = this.state, animate = true) {
      if (!isMobile()) return;
      this.state = s;
      sheet.dataset.snap = s;
      document.body.classList.toggle("sheet-full", s === "full");
      scroller.style.height = innerHeight - this.fullY() - HANDLE + "px";
      if (s !== "full") scroller.scrollTop = 0;
      this.apply(this.yFor(s), animate);
    },
    visible(s = this.state) { return isMobile() ? innerHeight - this.yFor(s) : 0; },
  };

  (function setupSheetDrag() {
    let tracking = false, dragging = false, startY = 0, startTop = 0, lastY = 0, lastT = 0, vel = 0, suppress = false;
    sheet.addEventListener("pointerdown", (e) => {
      if (!isMobile() || e.button > 0 || e.target.closest("input, select, textarea")) return;
      const fromHandle = !!e.target.closest(".sheet-handle");
      if (Sheet.state === "full" && !fromHandle) return; // en plein écran, le contenu défile
      tracking = true; dragging = false;
      startY = lastY = e.clientY; startTop = Sheet.y; lastT = e.timeStamp; vel = 0;
    });
    sheet.addEventListener("pointermove", (e) => {
      if (!tracking) return;
      const dy = e.clientY - startY;
      if (!dragging) {
        if (Math.abs(dy) < 6) return;
        dragging = true;
        sheet.setPointerCapture(e.pointerId);
      }
      const dt = e.timeStamp - lastT || 16;
      vel = (e.clientY - lastY) / dt; lastY = e.clientY; lastT = e.timeStamp;
      Sheet.apply(Math.min(innerHeight - 70, Math.max(Sheet.fullY(), startTop + dy)), false);
    });
    const end = () => {
      if (!tracking) return;
      tracking = false;
      if (!dragging) return;
      dragging = false;
      suppress = true; setTimeout(() => (suppress = false), 350);
      const target = Sheet.y + vel * 180;
      const best = ["full", "half", "peek"].map((s) => [s, Sheet.yFor(s)]).reduce((a, b) => (Math.abs(b[1] - target) < Math.abs(a[1] - target) ? b : a));
      Sheet.snap(best[0]);
    };
    sheet.addEventListener("pointerup", end);
    sheet.addEventListener("pointercancel", end);
    sheet.addEventListener("click", (e) => { if (suppress) { e.stopPropagation(); e.preventDefault(); suppress = false; } }, true);
    $(".sheet-handle").addEventListener("click", () => Sheet.snap(Sheet.state === "peek" ? "half" : Sheet.state === "half" ? "full" : "peek"));
  })();

  function layoutChanged() {
    if (isMobile()) Sheet.snap(Sheet.state, false);
    else {
      sheet.style.transform = ""; scroller.style.height = "";
      document.documentElement.style.setProperty("--sheet-visible", "0px");
      document.body.classList.remove("sheet-full");
    }
  }
  mq.addEventListener("change", layoutChanged);
  addEventListener("resize", debounce(() => isMobile() && Sheet.snap(Sheet.state, false), 100));

  function mapPad(snap) {
    const W = innerWidth, H = innerHeight;
    const p = isMobile()
      ? { top: Sheet.barBottom() + 12, bottom: Sheet.visible(snap) + 12, left: 24, right: 24 }
      : { top: 80, bottom: 30, left: state.view === "home" ? 24 : PANEL_W + 24, right: 72 };
    p.left = Math.max(10, Math.min(p.left, W - p.right - 120));
    p.bottom = Math.max(10, Math.min(p.bottom, H - p.top - 120));
    return p;
  }

  // --- Vues + bouton Retour du téléphone ---
  const SNAP = { home: "peek", place: "peek", directions: "peek", vehicle: "full" };
  const topbar = $("#topbar");
  function syncBars() {
    $("#searchbar").hidden = state.dirActive;
    $("#dirbar").hidden = !state.dirActive;
    const searching = topbar.classList.contains("searching");
    $("#sb-back").hidden = !(state.view !== "home" || (searching && isMobile()));
    topbar.classList.toggle("has-back", !$("#sb-back").hidden);
    $("#sb-clear").hidden = !$("#q").value;
  }
  new ResizeObserver(() => {
    const bar = state.dirActive ? $("#dirbar") : $("#searchbar");
    document.documentElement.style.setProperty("--topbar-h", bar.offsetHeight + "px");
  }).observe(topbar);

  function render(view) {
    state.view = view;
    sheet.dataset.view = view;
    $$(".view").forEach((el) => (el.hidden = el.dataset.view !== view));
    sheet.classList.toggle("open", view !== "home");
    syncBars();
    if (view === "home") renderRecents();
    if (!isMobile()) scroller.scrollTop = 0;
    requestAnimationFrame(() => Sheet.snap(SNAP[view]));
    updateHint();
  }
  function go(view) {
    if (view === state.view) return render(view);
    history.pushState({ view }, "");
    applyView(view);
  }
  function back() {
    if (history.state?.view && history.state.view !== "home") history.back();
    else applyView("home");
  }
  addEventListener("popstate", (e) => applyView(e.state?.view || "home"));
  history.replaceState({ view: "home" }, "");

  function applyView(view) {
    closeSuggest();
    if (view === "home") { clearPlace(); leaveDirections(); $("#q").value = ""; }
    else if (view === "place") { leaveDirections(); if (state.place) showPlaceMarker(); }
    else if (view === "directions") { state.dirActive = true; hidePlaceMarker(); }
    render(view);
  }

  // --- Recherche ---
  const suggest = $("#suggest");
  const ME = { me: true, name: "Ma position", sub: "Utiliser la localisation" };
  let sugTarget = null, sugItems = [], sugActive = -1, searchTok = 0;

  function baseItems() {
    const rec = Geo.recents().map((p) => ({ ...p, recent: true }));
    return sugTarget === "q" ? rec : [ME, ...rec];
  }
  function renderSuggest(items) {
    sugItems = items; sugActive = -1;
    suggest.hidden = false;
    suggest.innerHTML = items.length
      ? items.map((it, i) => `<li role="option" data-i="${i}"><span class="s-ico ${it.me ? "me" : ""}">${it.me ? ICON.me : it.recent ? ICON.clock : ICON.pin}</span><span class="s-txt"><b>${Fmt.esc(it.name)}</b><small>${Fmt.esc(it.sub || "")}</small></span></li>`).join("")
      : `<li class="empty">${sugTarget === "q" ? "Tapez une adresse, une ville, un lieu…" : "Aucun résultat"}</li>`;
  }
  function openSuggest(target) {
    sugTarget = target;
    topbar.classList.add("searching");
    syncBars();
    const val = $("#" + target).value.trim();
    const isSet = target !== "q" && state[target]?.name === val;
    if (val.length >= 3 && !isSet) runSearch(); else renderSuggest(baseItems());
    if (isSet) $("#" + target).select();
  }
  function closeSuggest() {
    sugTarget = null;
    topbar.classList.remove("searching");
    suggest.hidden = true;
    syncBars();
  }
  const nearPoint = () => Loc.pos || (map ? { lat: map.getCenter().lat, lon: map.getCenter().lng } : null);
  const runSearch = debounce(async () => {
    if (!sugTarget) return;
    const q = $("#" + sugTarget).value.trim(), tok = ++searchTok;
    if (q.length < 3) { renderSuggest(baseItems()); return; }
    try {
      const list = await Geo.search(q, nearPoint());
      if (tok !== searchTok || !sugTarget) return;
      const meMatch = sugTarget !== "q" && "ma position".startsWith(q.toLowerCase());
      renderSuggest(meMatch ? [ME, ...list] : list);
    } catch (e) {
      if (e.name !== "AbortError" && tok === searchTok) suggest.innerHTML = `<li class="empty">Recherche indisponible, réessayez</li>`;
    }
  }, 250);

  async function submitSearch() {
    if (sugActive >= 0 && sugItems[sugActive]) return pick(sugItems[sugActive]);
    const q = $("#" + sugTarget).value.trim();
    if (q.length < 3) return;
    try { const list = await Geo.search(q, nearPoint()); if (list[0]) pick(list[0]); else toast("Aucun résultat"); }
    catch { toast("Recherche indisponible"); }
  }
  async function pick(it) {
    const target = sugTarget;
    closeSuggest();
    document.activeElement?.blur();
    if (target === "q") return selectPlace(it);
    let p = it;
    if (it.me) {
      p = await myPlace();
      if (!p) { toast("Localisation indisponible"); return; }
    } else if (!it.recent) Geo.addRecent(it);
    setEndpoint(target, p);
  }

  for (const id of ["q", "from", "to"]) {
    const input = $("#" + id);
    input.addEventListener("focus", () => openSuggest(id));
    input.addEventListener("input", () => { if (sugTarget !== id) openSuggest(id); runSearch(); syncBars(); });
    input.addEventListener("blur", () => setTimeout(() => {
      if (!isMobile() && sugTarget === id && document.activeElement !== input) closeSuggest();
    }, 180));
    input.addEventListener("keydown", (e) => {
      const lis = $$("li[data-i]", suggest);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!lis.length) return;
        sugActive = (sugActive + (e.key === "ArrowDown" ? 1 : -1) + lis.length) % lis.length;
        lis.forEach((li, i) => li.classList.toggle("active", i === sugActive));
      } else if (e.key === "Enter") { e.preventDefault(); submitSearch(); }
      else if (e.key === "Escape") { closeSuggest(); input.blur(); }
    });
  }
  $("#searchbar").addEventListener("submit", (e) => { e.preventDefault(); submitSearch(); });
  suggest.addEventListener("pointerdown", (e) => { if (e.pointerType === "mouse") e.preventDefault(); });
  suggest.addEventListener("click", (e) => { const li = e.target.closest("li[data-i]"); if (li) pick(sugItems[+li.dataset.i]); });

  $("#sb-back").addEventListener("click", () => {
    if (topbar.classList.contains("searching")) { closeSuggest(); document.activeElement?.blur(); }
    else back();
  });
  $("#sb-clear").addEventListener("click", () => { $("#q").value = ""; $("#q").focus(); openSuggest("q"); });
  $("#sb-dir").addEventListener("click", () => startDirections({ to: state.view === "place" ? state.place : null }));

  function renderRecents() {
    const list = Geo.recents();
    $("#recent-block").hidden = !list.length;
    $("#recent-list").innerHTML = list.map((p, i) => `<li data-i="${i}"><span class="s-ico">${ICON.clock}</span><span class="s-txt"><b>${Fmt.esc(p.name)}</b><small>${Fmt.esc(p.sub || "")}</small></span></li>`).join("");
  }
  $("#recent-list").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-i]");
    if (li) selectPlace(Geo.recents()[+li.dataset.i]);
  });

  // --- Lieu ---
  let placeMarker = null;
  function selectPlace(p, { fly = true, recent = true } = {}) {
    state.place = p;
    if (recent) Geo.addRecent(p);
    $("#q").value = p.name;
    $("#place-name").textContent = p.name;
    $("#place-sub").textContent = p.sub || Fmt.coords(p.lat, p.lon);
    $("#place-eta").textContent = "";
    if (state.view !== "place") go("place"); else render("place");
    showPlaceMarker();
    if (fly) onMap(() => map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 15), padding: mapPad("peek"), duration: dur(800), essential: true }));
    prefetchEta();
  }
  function showPlaceMarker() {
    const p = state.place;
    if (!p) return;
    onMap(() => { placeMarker ??= new maplibregl.Marker({ color: "#e53935" }); placeMarker.setLngLat([p.lon, p.lat]).addTo(map); });
  }
  const hidePlaceMarker = () => placeMarker?.remove();
  function clearPlace() { hidePlaceMarker(); state.place = null; }

  // Le temps de trajet s'affiche sur le bouton « Itinéraire » et le clic devient instantané.
  function prefetchEta() {
    const p = state.place;
    if (!p || !Loc.pos) return;
    Router.route(meEndpoint(), p, state.vehicle).then((r) => {
      if (state.place === p && state.view === "place") $("#place-eta").textContent = Fmt.dur(r[0].time);
    }).catch(() => {});
  }

  $("#place-close").addEventListener("click", back);
  $("#btn-route").addEventListener("click", () => startDirections({ to: state.place }));
  $("#btn-from-here").addEventListener("click", () => startDirections({ from: state.place, to: null }));

  // --- Itinéraire ---
  let startMarker = null, endMarker = null, planTok = 0;
  const meEndpoint = () => ({ lat: Loc.pos.lat, lon: Loc.pos.lon, name: "Ma position", me: true });
  async function myPlace() { const pos = await Loc.get(); return pos ? meEndpoint() : null; }

  function startDirections({ from, to }) {
    state.to = to ? { ...to } : null;
    state.from = from ? { ...from } : Loc.pos ? meEndpoint() : null;
    go("directions");
    syncDir();
    computeRoute();
    if (!state.from) {
      myPlace().then((p) => {
        if (!state.dirActive || state.from) return;
        if (p) { state.from = p; syncDir(); computeRoute(); }
        else $("#from").focus();
      });
    } else if (!state.to) $("#to").focus();
  }
  function leaveDirections() {
    if (!state.dirActive) return;
    state.dirActive = false;
    state.from = state.to = state.plan = null;
    planTok++;
    drawRoutes([]); setHighlight([]);
    startMarker?.remove(); endMarker?.remove();
    $("#route-options").innerHTML = ""; $("#steps").innerHTML = "";
  }
  function syncDir() {
    $("#from").value = state.from?.name || "";
    $("#to").value = state.to?.name || "";
  }
  function setEndpoint(which, p) {
    state[which] = p ? { ...p } : null;
    syncDir();
    computeRoute();
  }
  $("#dir-back").addEventListener("click", back);
  $("#dir-swap").addEventListener("click", () => {
    [state.from, state.to] = [state.to, state.from];
    syncDir();
    computeRoute();
  });

  function updateEndpointMarkers() {
    onMap(() => {
      if (state.from) {
        if (!startMarker) { const el = document.createElement("div"); el.className = "start-marker"; startMarker = new maplibregl.Marker({ element: el }); }
        startMarker.setLngLat([state.from.lon, state.from.lat]).addTo(map);
      } else startMarker?.remove();
      if (state.to) { endMarker ??= new maplibregl.Marker({ color: "#e53935" }); endMarker.setLngLat([state.to.lon, state.to.lat]).addTo(map); }
      else endMarker?.remove();
    });
  }

  async function computeRoute() {
    const tok = ++planTok;
    const { from, to } = state;
    updateEndpointMarkers();
    if (!from || !to) {
      state.plan = null;
      drawRoutes([]); setHighlight([]);
      $("#route-options").innerHTML = ""; $("#steps").innerHTML = "";
      setRouteStatus("info", "Choisissez le départ et la destination.");
      return;
    }
    const v = { ...state.vehicle };
    let draftFirst = null;
    setRouteStatus("loading", "Recherche d'un itinéraire compatible…");
    $("#route-options").innerHTML = ""; $("#steps").innerHTML = "";
    try {
      const res = await Planner.plan(from, to, v, (draft) => {
        if (tok !== planTok) return;
        draftFirst = draft[0];
        state.plan = { status: "checking", routes: draft, avoided: [] };
        state.sel = 0;
        renderPlan(true);
      });
      if (tok !== planTok) return;
      state.plan = res; state.sel = 0;
      const changed = !draftFirst || !res.routes[0] || res.routes[0].coords.length !== draftFirst.coords.length || res.routes[0].time !== draftFirst.time;
      renderPlan(changed);
      if (state.view === "vehicle" && res.routes[0]) toast(`Itinéraire mis à jour pour ${Fmt.m(v.height)}`);
    } catch (e) {
      if (tok !== planTok) return;
      console.error("Itinéraire", e);
      state.plan = null;
      drawRoutes([]); setHighlight([]);
      setRouteStatus("error", `Impossible de calculer l'itinéraire pour le moment (service indisponible). <button class="link" data-retry>Réessayer</button>`);
    }
  }

  function setRouteStatus(kind, html) {
    const el = $("#route-status");
    el.className = "route-status " + kind;
    el.innerHTML = html;
    el.hidden = !html;
    el.toggleAttribute("data-peek", !state.plan?.routes?.length);
    if (isMobile() && state.view === "directions") requestAnimationFrame(() => Sheet.snap(Sheet.state));
  }

  function obsList(items) {
    const shown = items.slice(0, 6);
    return `<ul class="obs">${shown.map((it) => `<li><button class="obs-link" data-obs="${Fmt.esc(it.id)}"><i class="lg ${fitClass(it.lim)}"></i><span>${Fmt.esc(it.n || it.k)}</span><b>${it.lim != null ? Fmt.m(it.lim) : "?"}</b></button></li>`).join("")}${items.length > 6 ? `<li class="more">et ${items.length - 6} autre${plural(items.length - 6)}</li>` : ""}</ul>`;
  }

  function renderPlan(fit) {
    const plan = state.plan;
    if (!plan || plan.status === "none") {
      drawRoutes([]);
      $("#route-options").innerHTML = ""; $("#steps").innerHTML = "";
      const blocked = plan?.blockedBy || [];
      setHighlight(blocked.map((it) => ({ ...it, kind: "avoided" })));
      setRouteStatus("error", `<b>Aucun itinéraire compatible</b> avec un véhicule de ${marginLabel()}.` +
        (blocked.length ? `<div>Passages trop bas sur les trajets possibles :</div>${obsList(blocked)}` : "") +
        `<div class="small">Le départ ou la destination n'est peut-être accessible que par un passage trop bas. Essayez un point voisin ou vérifiez la hauteur saisie.</div>`);
      return;
    }
    $("#route-options").innerHTML = plan.routes.map((r, i) => {
      let badge;
      if (plan.status === "checking") badge = `<span class="badge">Contrôle…</span>`;
      else if (!r.check) badge = `<span class="badge warn">Non contrôlé</span>`;
      else if (r.check.unknown.length) badge = `<span class="badge warn">⚠ ${r.check.unknown.length} inconnue${plural(r.check.unknown.length)}</span>`;
      else badge = `<span class="badge ok">✓ Compatible</span>`;
      return `<li data-i="${i}"${i === 0 ? " data-peek" : ""}><div class="ro-main"><div class="ro-time">${Fmt.dur(r.time)}</div><div class="ro-sub">${Fmt.km(r.length)}${r.via ? " · via " + Fmt.esc(r.via) : ""}${i === 0 ? " · le plus rapide" : ""}</div></div>${badge}</li>`;
    }).join("");
    renderSelected(fit);
  }

  function renderSelected(fit) {
    const plan = state.plan, r = plan.routes[state.sel];
    if (!r) return;
    $$("#route-options li").forEach((li) => li.classList.toggle("sel", +li.dataset.i === state.sel));
    drawRoutes(plan.routes, state.sel);
    const marge = marginLabel();

    let hl = [];
    if (plan.status === "checking") {
      setRouteStatus("loading", "Contrôle des hauteurs le long du trajet…");
    } else if (plan.status === "unverified") {
      setRouteStatus("warn", plan.partial
        ? `<b>Compatibilité non entièrement vérifiable.</b> Une partie du trajet sort de la zone dont les hauteurs sont téléchargées. Le moteur a tenu compte des hauteurs qu'il connaît (${marge}) ; suivez la signalisation sur cette partie.`
        : `<b>Compatibilité non entièrement vérifiable.</b> Le serveur des hauteurs ne répond pas : le trajet tient compte des hauteurs connues du moteur d'itinéraire (${marge}), mais n'a pas pu être contrôlé passage par passage. Suivez la signalisation. <button class="link" data-retry>Réessayer le contrôle</button>`);
    } else {
      const c = r.check;
      let html = "";
      if (c.unknown.length) {
        const unk = groupObstacles(c.unknown.map((e) => e.item));
        html += `<div class="status-card warn"><b>Compatibilité non entièrement vérifiable</b> : ${unk.length} passage${plural(unk.length)} sans hauteur indiquée sur ce trajet (tunnel, passage couvert…). Vérifiez la signalisation.${obsList(unk)}</div>`;
      } else {
        html += `<div class="status-card ok"><b>✓ Trajet compatible</b> avec ${marge}${c.ok.length ? ` · ${c.ok.length} passage${plural(c.ok.length)} limité${plural(c.ok.length)} contrôlé${plural(c.ok.length)}` : ""}.</div>`;
      }
      if (plan.avoided?.length) html += `<div class="status-card info"><b>Détour</b> : ce trajet évite ${plan.avoided.length} passage${plural(plan.avoided.length)} trop bas emprunté${plural(plan.avoided.length)} par le trajet habituel.${obsList(plan.avoided)}</div>`;
      else if (plan.sameAsCar && state.sel === 0) html += `<div class="status-card info">Même trajet qu'une voiture : aucun passage trop bas sur le chemin le plus rapide.</div>`;
      setRouteStatus("result", html);
      hl = (plan.avoided || []).map((it) => ({ ...it, kind: "avoided" })).concat(c.unknown.map((e) => ({ ...e.item, kind: "unknown" })));
    }
    setHighlight(hl);

    $("#steps").innerHTML = r.maneuvers.map((m) => `<li><span class="step-arrow">${ARROW[m.type] || "⬆"}</span><span>${Fmt.esc(m.text)}${m.len > 0 ? `<small>${Fmt.km(m.len)}</small>` : ""}</span></li>`).join("");
    if (fit) fitRoute(r);
  }

  function selectRoute(i) {
    if (!state.plan?.routes?.[i] || i === state.sel) return;
    state.sel = i;
    renderSelected(false);
  }
  $("#route-options").addEventListener("click", (e) => { const li = e.target.closest("li[data-i]"); if (li) selectRoute(+li.dataset.i); });
  $("#route-status").addEventListener("click", (e) => {
    const o = e.target.closest("[data-obs]");
    if (o) return flyToObstacle(o.dataset.obs);
    if (e.target.closest("[data-retry]")) computeRoute();
  });

  function drawRoutes(routes, sel = 0) {
    onMap(() => {
      const f = routes.map((r, i) => ({ type: "Feature", properties: { idx: i, sel: i === sel }, geometry: { type: "LineString", coordinates: r.coords } }));
      f.sort((a, b) => a.properties.sel - b.properties.sel);
      map.getSource("routes").setData(FC(f));
    });
  }
  function setHighlight(items) {
    onMap(() => map.getSource("highlight").setData(FC(items.map((it) => {
      const props = { id: it.id, label: labelOf(it.lim), kind: it.kind };
      if (it.lim != null) props.lim = it.lim;
      return { type: "Feature", properties: props, geometry: { type: "Point", coordinates: [it.lon, it.lat] } };
    }))));
  }
  function fitRoute(r) {
    onMap(() => {
      const b = r.coords.reduce((acc, c) => acc.extend(c), new maplibregl.LngLatBounds(r.coords[0], r.coords[0]));
      map.fitBounds(b, { padding: mapPad(), duration: dur(700), maxZoom: 16 });
    });
  }

  // --- Véhicule ---
  const recomputeSoon = debounce(() => state.dirActive && computeRoute(), 450);
  function updateVehicleUI() {
    const v = state.vehicle;
    const dims = `${Fmt.mShort(v.height)} haut · ${Fmt.mShort(v.width)} large · ${v.weight.toLocaleString("fr-FR")} t`;
    $$("[data-v-icon]").forEach((e) => (e.textContent = Vehicle.icon(v)));
    $$("[data-v-label]").forEach((e) => (e.textContent = Vehicle.label(v)));
    $$("[data-v-dims]").forEach((e) => (e.textContent = dims));
    $$("[data-v-h]").forEach((e) => (e.textContent = v.height.toLocaleString("fr-FR", { maximumFractionDigits: 2 })));
  }
  function renderPresets() {
    $("#presets").innerHTML = Object.entries(Vehicle.PRESETS).map(([k, p]) =>
      `<button class="preset${state.vehicle.preset === k ? " active" : ""}" data-preset="${k}"><span>${p.icon}</span>${p.label}<small>${Fmt.mShort(p.height)}</small></button>`).join("");
  }
  function renderVehicleForm() {
    const v = state.vehicle;
    renderPresets();
    $("#h-out").textContent = Fmt.m(v.height);
    $("#h-range").value = v.height;
    $("#v-width").value = v.width;
    $("#v-length").value = v.length;
    $("#v-weight").value = v.weight;
    $("#v-margin").value = v.margin;
  }
  function vehicleChanged() {
    Vehicle.save(state.vehicle);
    updateVehicleUI();
    onMap(applyVehicleColors);
    popup?.remove();
    $("#place-eta").textContent = "";
    recomputeSoon();
  }
  function setDim(key, value) {
    if (!Number.isFinite(value)) return;
    const lim = { height: [1, 6], width: [1, 3.5], length: [2, 30], weight: [0.3, 60], margin: [0, 1] }[key];
    state.vehicle[key] = Math.round(Math.min(lim[1], Math.max(lim[0], value)) * 100) / 100;
    if (key !== "margin") state.vehicle.preset = "custom";
    vehicleChanged();
  }
  $("#presets").addEventListener("click", (e) => {
    const b = e.target.closest("[data-preset]");
    if (!b) return;
    state.vehicle = { ...state.vehicle, preset: b.dataset.preset, ...Vehicle.PRESETS[b.dataset.preset] };
    vehicleChanged(); renderVehicleForm();
  });
  $("#h-range").addEventListener("input", (e) => { setDim("height", +e.target.value); $("#h-out").textContent = Fmt.m(state.vehicle.height); renderPresets(); });
  $$("[data-step]").forEach((b) => b.addEventListener("click", () => { setDim("height", state.vehicle.height + +b.dataset.step); renderVehicleForm(); }));
  for (const [id, key] of [["#v-width", "width"], ["#v-length", "length"], ["#v-weight", "weight"], ["#v-margin", "margin"]]) {
    $(id).addEventListener("change", (e) => { setDim(key, parseFloat(String(e.target.value).replace(",", "."))); renderVehicleForm(); });
  }
  $$("[data-open-vehicle]").forEach((b) => b.addEventListener("click", () => { closeSuggest(); renderVehicleForm(); go("vehicle"); }));
  $("#vehicle-done").addEventListener("click", back);

  // --- Localisation ---
  const Loc = {
    pos: null, watchId: null, waiters: [], marker: null, denied: false,
    start() {
      if (this.watchId !== null || !navigator.geolocation) return;
      this.watchId = navigator.geolocation.watchPosition((p) => this.fix(p), (e) => this.fail(e), { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
    },
    fix(p) {
      const first = !this.pos;
      this.pos = { lat: p.coords.latitude, lon: p.coords.longitude };
      this.waiters.splice(0).forEach((w) => w(this.pos));
      onMap(() => {
        if (!this.marker) { const el = document.createElement("div"); el.className = "me-dot"; this.marker = new maplibregl.Marker({ element: el }); }
        this.marker.setLngLat([this.pos.lon, this.pos.lat]).addTo(map);
      });
      if (first) prefetchEta();
    },
    fail(e) {
      if (e.code !== 1) return;
      this.denied = true;
      navigator.geolocation.clearWatch(this.watchId); this.watchId = null;
      this.waiters.splice(0).forEach((w) => w(null));
    },
    async get(timeout = 8000) {
      if (this.pos) return this.pos;
      if (!navigator.geolocation || this.denied) return null;
      if (!(await askLocationConsent())) return null;
      this.start();
      return new Promise((res) => { this.waiters.push(res); setTimeout(() => res(this.pos), timeout); });
    },
  };
  // Explication avant la demande système (App Store, règle 5.1.5). Le « oui » est mémorisé.
  function askLocationConsent() {
    if (localStorage.getItem("gabarit.loc.ok")) return Promise.resolve(true);
    return new Promise((resolve) => {
      const box = $("#loc-ask");
      box.hidden = false;
      const done = (ok) => {
        box.hidden = true;
        if (ok) localStorage.setItem("gabarit.loc.ok", "1");
        $("#loc-yes").onclick = $("#loc-no").onclick = null;
        resolve(ok);
      };
      $("#loc-yes").onclick = () => done(true);
      $("#loc-no").onclick = () => done(false);
    });
  }
  // Autorisation déjà accordée : on démarre le suivi tout de suite.
  navigator.permissions?.query({ name: "geolocation" }).then((s) => { if (s.state === "granted") Loc.start(); }).catch(() => {});

  $("#btn-locate").addEventListener("click", async () => {
    const btn = $("#btn-locate");
    btn.classList.add("active");
    const p = await Loc.get();
    if (!p) { btn.classList.remove("active"); toast("Localisation indisponible ou refusée"); return; }
    map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 15.5), padding: mapPad(), duration: dur(700), essential: true });
  });
  function updateCompass() {
    const b = map.getBearing(), p = map.getPitch();
    $("#btn-compass").hidden = Math.abs(b) < 0.5 && p < 1;
    $("#compass-ico").style.transform = `rotate(${-b}deg)`;
  }
  $("#btn-compass").addEventListener("click", () => map.easeTo({ bearing: 0, pitch: 0, duration: dur(400) }));
  $("#btn-zin").addEventListener("click", () => map.zoomIn({ duration: dur(250) }));
  $("#btn-zout").addEventListener("click", () => map.zoomOut({ duration: dur(250) }));

  // --- Choisir un point sur la carte ---
  let lastPick = 0;
  async function pickPoint(ll) {
    if (Date.now() - lastPick < 800) return;
    lastPick = Date.now();
    const p = { lat: ll.lat, lon: ll.lng, name: "Point sélectionné", sub: Fmt.coords(ll.lat, ll.lng) };
    let which = null;
    if (state.dirActive) { which = !state.to ? "to" : !state.from ? "from" : "to"; setEndpoint(which, p); }
    else selectPlace(p, { fly: false, recent: false });
    const r = await Geo.reverse(p.lat, p.lon);
    if (!r) return;
    if (which && state[which]?.lat === p.lat) { state[which].name = r.name; syncDir(); }
    else if (state.place === p) {
      p.name = r.name; p.sub = r.sub;
      $("#place-name").textContent = r.name; $("#place-sub").textContent = r.sub || Fmt.coords(p.lat, p.lon); $("#q").value = r.name;
    }
  }
  function setupLongPress() {
    let timer = null, start = null;
    const clear = () => { clearTimeout(timer); timer = null; };
    map.on("touchstart", (e) => {
      if (e.originalEvent.touches.length !== 1) return clear();
      start = e.point;
      timer = setTimeout(() => { timer = null; navigator.vibrate?.(12); pickPoint(e.lngLat); }, 550);
    });
    map.on("touchmove", (e) => { if (timer && (Math.abs(e.point.x - start.x) > 8 || Math.abs(e.point.y - start.y) > 8)) clear(); });
    map.on("touchend", clear);
    map.on("touchcancel", clear);
  }

  // --- Divers ---
  let toastTimer;
  function toast(msg, ms = 2600) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), ms);
  }

  const SAFETY = "gabarit.safety.v1";
  if (!localStorage.getItem(SAFETY)) $("#safety").hidden = false;
  $("#safety-ok").addEventListener("click", () => { localStorage.setItem(SAFETY, String(Date.now())); $("#safety").hidden = true; });

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }

  updateVehicleUI();
  render("home");
  layoutChanged();
  initMap();

  // Pour déboguer depuis la console du navigateur.
  window.Gabarit = { state, computeRoute, Sheet, get map() { return map; } };
})();
