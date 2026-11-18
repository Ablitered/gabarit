// Adresses des services utilisés par l'application.
// Les serveurs publics (Overpass, Photon) ont des limites d'usage strictes : voir CONFORMITE.md
// avant toute mise en ligne.
self.GABARIT_CONFIG = {
  style: "https://tiles.openfreemap.org/styles/liberty",

  // Moteur Valhalla local : server/start_engine.sh (ou le service gabarit-engine sur un serveur).
  valhalla: `${location.protocol}//${location.hostname}:8002/route`,
  routeMinIntervalMs: 0, // pas d'attente entre deux calculs avec votre propre moteur

  // Hauteurs extraites d'OpenStreetMap par tools/build_obstacles.py.
  obstacleTiles: "data/obstacles",

  // Hors de la zone téléchargée seulement : serveurs Overpass publics.
  overpassFallback: true,
  overpass: [
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
  ],

  // Recherche d'adresses : instance publique de komoot, à remplacer avant une publication à fort trafic.
  photon: "https://photon.komoot.io",
};
