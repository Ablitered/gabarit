#!/usr/bin/env bash
# Démarre le moteur d'itinéraire local (adresse définie dans data/valhalla/valhalla.json,
# 127.0.0.1:8002 par défaut).
set -euo pipefail
cd "$(dirname "$0")/.."
PY="${PY:-server/.venv/bin/python}"
CONFIG="${CONFIG:-data/valhalla/valhalla.json}"
[ -f "$CONFIG" ] || { echo "Configuration introuvable : $CONFIG (lancer tools/build_engine.sh)" >&2; exit 1; }
BIN="$("$PY" -c 'import os, valhalla; print(os.path.join(os.path.dirname(valhalla.__file__), "bin"))')"
exec "$BIN/valhalla_service" "$CONFIG" "${THREADS:-4}"
