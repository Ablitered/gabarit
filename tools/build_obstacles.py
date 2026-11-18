"""
Extrait les restrictions de hauteur d'un fichier OpenStreetMap (.osm.pbf) et les écrit
en fichiers statiques par tuile, lus directement par l'application :

    <sortie>/13/<x>/<y>.json   passages de la tuile
    <sortie>/meta.json         statistiques et liste des tuiles couvertes par le fichier

Usage : server/.venv/bin/python tools/build_obstacles.py <fichier.osm.pbf> [sortie]
        (sortie par défaut : data/obstacles)

La lecture des hauteurs doit rester identique à celle de js/services.js (parseHeight,
heightLimit, obstacleKind).
"""
import json, math, os, re, sys, time, shutil
from collections import defaultdict
import osmium

Z = 13  # même grille que js/services.js (CFG.tileZ)
DRIVABLE = {
    "motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential",
    "service", "living_street", "road", "track", "busway",
    "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link",
}

def parse_height(raw):
    if not raw:
        return None
    v = str(raw).strip().lower().replace(",", ".")
    if v in ("none", "default", "no_sign", "no_indications", "unsigned", "no"):
        return None
    if v == "below_default":
        return "unknown"
    m = re.match(r"^(\d+(?:\.\d+)?)\s*(?:m|meters?|mètres?)?$", v)
    if m: return float(m.group(1))
    m = re.match(r"^(\d+(?:\.\d+)?)\s*cm$", v)
    if m: return float(m.group(1)) / 100
    m = re.match(r"""^(\d+)\s*'\s*(?:(\d+(?:\.\d+)?)\s*(?:"|''))?$""", v)
    if m: return (int(m.group(1)) * 12 + float(m.group(2) or 0)) * 0.0254
    m = re.match(r"^(\d+(?:\.\d+)?)\s*ft$", v)
    if m: return float(m.group(1)) * 0.3048
    return None

def height_limit(t):
    vals = [parse_height(t.get("maxheight")), parse_height(t.get("maxheight:physical"))]
    nums = [x for x in vals if isinstance(x, float) and 0.8 < x < 10]
    if nums:
        return round(min(nums), 2)
    if "unknown" in vals:
        return "unknown"
    untagged = not t.get("maxheight") and not t.get("maxheight:physical")
    risky = (t.get("tunnel") not in (None, "no")) or t.get("covered") == "yes" or t.get("barrier") == "height_restrictor"
    return "unknown" if (untagged and risky) else None

def kind(t):
    if t.get("barrier") == "height_restrictor": return "Portique"
    if t.get("tunnel") not in (None, "no"): return "Tunnel"
    if t.get("covered") == "yes": return "Passage couvert"
    if t.get("amenity") == "parking" or t.get("parking"): return "Parking"
    if t.get("highway"): return "Passage sous un pont"
    return "Hauteur limitée"

def tile_of(lon, lat):
    n = 2 ** Z
    r = math.radians(max(-85, min(85, lat)))
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * n)
    return x, y

def mid_along(g):
    if len(g) == 1:
        return g[0]
    k = math.cos(math.radians(g[0][1]))
    seg = [math.hypot((g[i + 1][0] - g[i][0]) * k, g[i + 1][1] - g[i][1]) for i in range(len(g) - 1)]
    half = sum(seg) / 2
    for i, s in enumerate(seg):
        if half <= s or i == len(seg) - 1:
            t = min(1, half / s) if s else 0
            return [g[i][0] + (g[i + 1][0] - g[i][0]) * t, g[i][1] + (g[i + 1][1] - g[i][1]) * t]
        half -= s
    return g[0]

def interesting(t):
    return any(k in t for k in ("maxheight", "maxheight:physical")) or t.get("barrier") == "height_restrictor" \
        or t.get("tunnel") not in (None, "no") or t.get("covered") == "yes"

class Pass1(osmium.SimpleHandler):
    """Nœuds avec restriction + voies concernées (on garde la liste de leurs nœuds)."""
    def __init__(self):
        super().__init__()
        self.items, self.ways, self.need = [], [], set()
    def node(self, n):
        t = n.tags
        if not interesting(t): return
        d = {k: v for k, v in t}
        lim = height_limit(d)
        if lim is None or not n.location.valid(): return
        self.items.append(item(f"node/{n.id}", n.location.lon, n.location.lat, None, lim, d))
    def way(self, w):
        t = w.tags
        if not interesting(t): return
        d = {k: v for k, v in t}
        hw = d.get("highway")
        if hw and hw not in DRIVABLE: return  # trottoirs, pistes cyclables : jamais sur un trajet
        if not hw and not (d.get("amenity") == "parking" or d.get("parking")): return
        lim = height_limit(d)
        if lim is None: return
        refs = [nd.ref for nd in w.nodes]
        self.ways.append((w.id, refs, lim, d, bool(hw)))
        self.need.update(refs)

class Pass2(osmium.SimpleHandler):
    """Positions des nœuds des voies retenues + tuiles réellement couvertes par le fichier."""
    def __init__(self, need):
        super().__init__()
        self.need, self.loc, self.cover, self.i = need, {}, set(), 0
    def node(self, n):
        if not n.location.valid(): return
        if n.id in self.need:
            self.loc[n.id] = (round(n.location.lon, 6), round(n.location.lat, 6))
        self.i += 1
        if self.i % 40 == 0:  # échantillon suffisant : une tuile fait plusieurs km
            self.cover.add(tile_of(n.location.lon, n.location.lat))

def item(id_, lon, lat, g, lim, t):
    it = {"id": id_, "lat": round(lat, 6), "lon": round(lon, 6), "lim": None if lim == "unknown" else lim,
          "k": kind(t), "n": t.get("name") or t.get("bridge:name") or ""}
    if g: it["g"] = g
    return it

def main(pbf, out="data/obstacles"):
    t0 = time.time()
    p1 = Pass1(); p1.apply_file(pbf)
    print(f"passe 1 : {len(p1.items)} nœuds, {len(p1.ways)} voies ({time.time()-t0:.0f} s)")
    p2 = Pass2(p1.need); p2.apply_file(pbf)
    print(f"passe 2 : {len(p2.loc)} positions ({time.time()-t0:.0f} s)")
    items = list(p1.items)
    for wid, refs, lim, d, is_road in p1.ways:
        g = [list(p2.loc[r]) for r in refs if r in p2.loc]
        if not g: continue
        lon, lat = mid_along(g)
        # Voies routières : géométrie complète (nécessaire au contrôle du trajet).
        # Parkings : simple point, pour ne pas les confondre avec la route qui les longe.
        items.append(item(f"way/{wid}", lon, lat, g if is_road else None, lim, d))

    tiles = defaultdict(list)
    for it in items:
        tiles[tile_of(it["lon"], it["lat"])].append(it)
    if os.path.isdir(os.path.join(out, str(Z))):
        shutil.rmtree(os.path.join(out, str(Z)))
    for (x, y), lst in tiles.items():
        d = os.path.join(out, str(Z), str(x))
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, f"{y}.json"), "w") as f:
            json.dump(lst, f, separators=(",", ":"), ensure_ascii=False)
    meta = {
        "z": Z, "source": os.path.basename(pbf), "built": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "count": len(items), "tiles": len(tiles),
        "known": sum(1 for i in items if i["lim"] is not None), "unknown": sum(1 for i in items if i["lim"] is None),
        # Tuiles où le fichier OSM contient des données : absence de fichier = aucun obstacle.
        # Hors de cette liste : zone non couverte (l'app le signale).
        "covered": sorted(f"{x}/{y}" for x, y in p2.cover),
        "license": "© contributeurs OpenStreetMap, ODbL",
    }
    with open(os.path.join(out, "meta.json"), "w") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    print({k: v for k, v in meta.items() if k != "covered"}, "tuiles couvertes :", len(meta["covered"]), f"({time.time()-t0:.0f} s)")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(*sys.argv[1:3])
