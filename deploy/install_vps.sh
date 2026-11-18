#!/usr/bin/env bash
# Installe le moteur Gabarit pour la France entière sur un serveur Linux.
#
#   sudo bash deploy/install_vps.sh          (depuis un clone du dépôt)
#
# Prévu pour un serveur qui héberge déjà d'autres sites : tout reste dans $BASE sous un
# utilisateur dédié, le moteur n'écoute que sur 127.0.0.1, nginx/apache/pare-feu ne sont
# pas touchés, la construction tourne en priorité basse avec un plafond mémoire.
# Rien n'est modifié avant la confirmation.
set -euo pipefail

BASE="${BASE:-/opt/gabarit}"
SVC_USER="${SVC_USER:-gabarit}"
PORT="${PORT:-8002}"
REGION_URL="${REGION_URL:-https://download.geofabrik.de/europe/france-latest.osm.pbf}"
PBF="$BASE/data/osm/france-latest.osm.pbf"
SRC="$(cd "$(dirname "$0")/.." && pwd)"

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
warn() { printf '\033[33m⚠ %s\033[0m\n' "$*"; }
die()  { printf '\033[31m✖ %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" = 0 ] || die "À lancer en root (sudo bash deploy/install_vps.sh)."
for f in tools/build_obstacles.py tools/build_engine.sh requirements.txt; do
  [ -f "$SRC/$f" ] || die "Fichier $f introuvable : lancer le script depuis un clone complet du dépôt."
done
for c in curl runuser awk df; do command -v "$c" >/dev/null || die "Commande $c manquante."; done

# 1. Vérifications (rien n'est modifié ici)
say "Vérifications"
ARCH="$(uname -m)"
case "$ARCH" in x86_64|aarch64) ;; *) die "Architecture $ARCH non prise en charge (x86_64 ou aarch64)." ;; esac
GLIBC="$(ldd --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+$' || echo 0)"
awk -v g="$GLIBC" 'BEGIN{exit !(g+0 >= 2.28)}' || die "glibc $GLIBC trop ancienne (2.28 minimum : Debian 10+, Ubuntu 20.04+)."
. /etc/os-release 2>/dev/null || true
CPU="$(nproc)"
MEM_TOTAL_GB=$(awk '/MemTotal/{printf "%d", $2/1048576}' /proc/meminfo)
MEM_AVAIL_GB=$(awk '/MemAvailable/{printf "%d", $2/1048576}' /proc/meminfo)
mkdir -p "$BASE"
DISK_FREE_GB=$(df -BG --output=avail "$BASE" | tail -1 | tr -dc '0-9')
echo "Système      : ${PRETTY_NAME:-inconnu} ($ARCH, glibc $GLIBC)"
echo "Processeurs  : $CPU"
echo "Mémoire      : ${MEM_TOTAL_GB} Go au total, ${MEM_AVAIL_GB} Go disponibles maintenant"
echo "Disque libre : ${DISK_FREE_GB} Go dans $BASE"

[ "$DISK_FREE_GB" -ge 45 ] || die "Il faut au moins 45 Go libres (fichier France 5,1 Go + réseau routier ~30 Go)."
if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$PORT\$"; then
  die "Le port $PORT est déjà utilisé sur ce serveur. Changez PORT en haut du script."
fi

# Plafond mémoire : on laisse toujours au moins 2 Go (et 25 %) aux autres sites.
MEM_LIMIT_GB=$(( MEM_AVAIL_GB * 75 / 100 ))
[ $(( MEM_AVAIL_GB - MEM_LIMIT_GB )) -ge 2 ] || MEM_LIMIT_GB=$(( MEM_AVAIL_GB - 2 ))
CONC=$(( CPU / 2 )); [ "$CONC" -ge 1 ] || CONC=1
BUILD_ROUTING=1
if [ "$MEM_LIMIT_GB" -lt 6 ]; then
  warn "Moins de 6 Go utilisables : le réseau routier France ne peut pas être construit sans risque pour les autres sites."
  warn "Seule l'extraction des hauteurs (peu gourmande) sera faite."
  BUILD_ROUTING=0
fi
echo "Construction : priorité basse, ${MEM_LIMIT_GB} Go max, ${CONC} cœur(s)"

echo
echo "Ce script va :"
echo "  - créer l'utilisateur système « $SVC_USER » et le dossier $BASE"
echo "  - installer Python 3.12, le moteur Valhalla et osmium DANS $BASE (pas dans le système)"
echo "  - télécharger la France depuis Geofabrik (5,1 Go)"
echo "  - extraire toutes les hauteurs → $BASE/data/obstacles"
[ "$BUILD_ROUTING" = 1 ] && echo "  - construire le réseau routier → $BASE/data/valhalla, puis le service gabarit-engine sur 127.0.0.1:$PORT"
read -r -p "Continuer ? [o/N] " ok; [[ "$ok" =~ ^[oOyY]$ ]] || die "Annulé, rien n'a été modifié."

LIMIT=(nice -n 19 ionice -c3)
if command -v systemd-run >/dev/null; then
  LIMIT=(systemd-run --quiet --scope -p MemoryMax="${MEM_LIMIT_GB}G" -p CPUWeight=20 nice -n 19 ionice -c3)
fi

# 2. Utilisateur et dossiers
say "Utilisateur et dossiers"
id "$SVC_USER" >/dev/null 2>&1 || useradd --system --home-dir "$BASE" --shell /usr/sbin/nologin "$SVC_USER"
mkdir -p "$BASE"/{app,data/osm,bin}
cp -r "$SRC/tools" "$SRC/requirements.txt" "$BASE/app/"
chown -R "$SVC_USER:$SVC_USER" "$BASE"
as_svc()  { runuser -u "$SVC_USER" -- env HOME="$BASE" "$@"; }
# Idem en priorité basse et mémoire plafonnée, pour ne pas gêner les autres sites.
limited() { "${LIMIT[@]}" runuser -u "$SVC_USER" -- env HOME="$BASE" "$@"; }

# 3. Python 3.12 + moteur, isolés dans /opt/gabarit
say "Python 3.12, Valhalla, osmium (isolés)"
if ! python3 -m venv --help >/dev/null 2>&1; then
  warn "python3-venv manque."
  read -r -p "Installer le paquet python3-venv avec apt (aucune mise à jour d'autres paquets) ? [o/N] " a
  [[ "$a" =~ ^[oOyY]$ ]] || die "python3-venv requis."
  apt-get install -y --no-upgrade python3-venv
fi
[ -x "$BASE/bootstrap/bin/uv" ] || { as_svc python3 -m venv "$BASE/bootstrap"; as_svc "$BASE/bootstrap/bin/pip" install -q uv; }
UV="$BASE/bootstrap/bin/uv"
as_svc env UV_PYTHON_INSTALL_DIR="$BASE/python" UV_CACHE_DIR="$BASE/.cache/uv" "$UV" venv -q --python 3.12 "$BASE/.venv"
as_svc env UV_CACHE_DIR="$BASE/.cache/uv" "$UV" pip install -q --python "$BASE/.venv/bin/python" -r "$BASE/app/requirements.txt"
PY="$BASE/.venv/bin/python"
VBIN="$(as_svc "$PY" -c 'import valhalla,os;print(os.path.join(os.path.dirname(valhalla.__file__),"bin"))')"
echo "Moteur : $(as_svc "$VBIN/valhalla_build_tiles" --version 2>&1 | head -1)"

# 4. Données OpenStreetMap (France)
say "Téléchargement France (reprise automatique si coupé)"
as_svc curl -fL -C - --retry 5 -A "gabarit-install/1.0" -o "$PBF" "$REGION_URL"
ls -lh "$PBF"

# 5. Toutes les hauteurs
say "Extraction des hauteurs (ponts, tunnels, portiques…)"
cd "$BASE"
limited "$PY" "$BASE/app/tools/build_obstacles.py" "$PBF"
du -sh "$BASE/data/obstacles"

# 6. Réseau routier + service
if [ "$BUILD_ROUTING" = 1 ]; then
  say "Réseau routier France (long : 1 à 3 h selon le serveur)"
  OUT="$BASE/data/valhalla"
  limited env PY="$PY" OUT="$OUT" CONCURRENCY="$CONC" LISTEN="tcp://127.0.0.1:$PORT" \
    bash "$BASE/app/tools/build_engine.sh" "$PBF"

  say "Service gabarit-engine (127.0.0.1:$PORT uniquement)"
  RUNTIME_MEM=$(( MEM_LIMIT_GB < 4 ? MEM_LIMIT_GB : 4 ))
  cat > /etc/systemd/system/gabarit-engine.service <<EOF
[Unit]
Description=Gabarit - moteur d'itinéraire Valhalla (local uniquement)
After=network.target

[Service]
User=$SVC_USER
WorkingDirectory=$BASE
ExecStart=$VBIN/valhalla_service $OUT/valhalla.json 2
Restart=on-failure
Nice=10
MemoryMax=${RUNTIME_MEM}G
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=$BASE
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now gabarit-engine.service
  sleep 5
  curl -fsS "http://127.0.0.1:$PORT/status" >/dev/null && echo "✔ Moteur en ligne sur 127.0.0.1:$PORT" || warn "Le moteur ne répond pas encore : journalctl -u gabarit-engine"
fi

say "Terminé"
cat <<EOF
Rien n'est exposé sur Internet pour l'instant.
Pour publier, ajoutez VOUS-MÊME dans la config nginx du domaine choisi (exemple) :

    location /api/route { proxy_pass http://127.0.0.1:$PORT/route; }
    location /data/obstacles/ { alias $BASE/data/obstacles/; add_header Cache-Control "public, max-age=86400"; }

Puis dans js/config.js de l'app : valhalla = "https://votre-domaine/api/route", obstacleTiles = "https://votre-domaine/data/obstacles".
Mise à jour des données : relancer ce script (il réutilise ce qui est déjà installé).
EOF
