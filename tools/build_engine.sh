#!/usr/bin/env bash
# Construit le réseau routier Valhalla à partir d'un fichier OpenStreetMap (.osm.pbf).
#
#   tools/build_engine.sh [fichier.osm.pbf]
#
# Variables facultatives : PY (Python avec pyvalhalla), OUT (dossier de sortie),
# CONCURRENCY (cœurs utilisés), LISTEN (adresse du service).
set -euo pipefail
cd "$(dirname "$0")/.."

PBF="${1:-data/osm/ile-de-france-latest.osm.pbf}"
PY="${PY:-server/.venv/bin/python}"
OUT="${OUT:-data/valhalla}"
CONCURRENCY="${CONCURRENCY:-4}"
LISTEN="${LISTEN:-tcp://127.0.0.1:8002}"

[ -f "$PBF" ] || { echo "Fichier OSM introuvable : $PBF" >&2; exit 1; }
BIN="$("$PY" -c 'import os, valhalla; print(os.path.join(os.path.dirname(valhalla.__file__), "bin"))')"
mkdir -p "$OUT/tiles"

echo "== Configuration"
# 200 exclusions : le planificateur exclut les passages trop bas restés sur le trajet.
"$PY" -m valhalla.valhalla_build_config \
  --mjolnir-tile-dir "$OUT/tiles" \
  --mjolnir-tile-extract "$OUT/tiles.tar" \
  --mjolnir-admin "$OUT/admins.sqlite" \
  --mjolnir-timezone "$OUT/timezones.sqlite" \
  --mjolnir-concurrency "$CONCURRENCY" \
  --httpd-service-listen "$LISTEN" \
  --service-limits-max-exclude-locations 200 \
  --service-limits-max-alternates 3 \
  > "$OUT/valhalla.json"

echo "== Zones administratives"
# Sur un extrait régional, Valhalla signale des frontières incomplètes : sans conséquence.
"$BIN/valhalla_build_admins" -c "$OUT/valhalla.json" "$PBF" || echo "Zones administratives incomplètes, on continue."

echo "== Réseau routier"
"$BIN/valhalla_build_tiles" -c "$OUT/valhalla.json" "$PBF"

echo "== Archive"
# Le service lit l'archive tiles.tar ; le dossier des tuiles ne sert plus ensuite.
"$PY" -m valhalla.valhalla_build_extract -c "$OUT/valhalla.json" -v --overwrite
rm -rf -- "${OUT:?}/tiles"
mkdir -p "$OUT/tiles"

du -sh "$OUT"
