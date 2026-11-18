# Gabarit — conformité services tiers, App Store et Google Play

Vérifié le 18 novembre 2026 sur les pages officielles (liens en bas).

## État actuel

| Point | État |
|---|---|
| Itinéraires | ✅ Votre moteur Valhalla (`server/start_engine.sh`, ou `deploy/install_vps.sh` sur serveur) : plus de dépendance à FOSSGIS |
| Hauteurs (ponts, tunnels, portiques) | ✅ Vos fichiers extraits d'OpenStreetMap (`tools/build_obstacles.py`). Overpass ne sert plus qu'hors de la zone téléchargée : `overpassFallback: false` pour le couper |
| Recherche d'adresses | ⚠ Encore Photon public (komoot) : à remplacer par votre instance avant une publication à fort trafic |
| Fond de carte | ✅ OpenFreeMap (usage commercial autorisé, mention affichée) |
| Données OSM téléchargées | ✅ Geofabrik, licence ODbL : mention « © contributeurs OpenStreetMap » affichée ; si vous redistribuez la base dérivée (fichiers `data/obstacles`), elle reste sous ODbL |

## 1. Services tiers utilisés

| Service | Ce que disent les conditions | Conséquence |
|---|---|---|
| **Valhalla — FOSSGIS** (`valhalla1.openstreetmap.de`) | Usage commercial seulement si le service n'est pas une « partie essentielle » de l'offre ; sites/apps à fort trafic non autorisés ; **1 requête/seconde max** ; mention OSM + lien « fixthemap » ; e-mail de contact sur le site **et sur la fiche du store** ; ne pas coder l'adresse en dur (recommandé) ; service révocable sans préavis | L'itinéraire est l'élément essentiel de l'app : ce serveur ne convient pas à une publication. ✅ Remplacé par votre moteur ; si vous y revenez, `routeMinIntervalMs: 1100` respecte la limite |
| **Overpass** (`overpass-api.de`, FOSSGIS + autres) | ~10 000 requêtes et 1 Go/jour, **÷100 pour un usage régulier** ; pour une app, c'est la **somme de tous les utilisateurs** qui compte ; 2 connexions max | Intenable pour une app publiée. ✅ Remplacé par les fichiers de hauteurs pré-calculés ; ne reste qu'en secours hors zone |
| **Photon — komoot** | « Soyez raisonnable », gros usage ralenti voire bloqué, aucune garantie | À remplacer par une instance à vous ou un hébergeur Photon payant. ✅ Déjà fait : recherche à partir de 3 caractères, 250 ms d'attente, cache |
| **OpenFreeMap** (fond de carte) | Usage commercial **autorisé**, sans clé ; mention « © OpenMapTiles · Data from OpenStreetMap » obligatoire (MapLibre l'ajoute) ; téléchargements hors ligne ≤ 3 000 tuiles / 50 Mo, User-Agent propre à l'app | ✅ OK. Le cache garde seulement les zones vues (pas de téléchargement massif) |
| **Données OpenStreetMap** | Licence ODbL : mention « © contributeurs OpenStreetMap » visible | ✅ Sur la carte + page `legal.html#sources` |

## 2. App Store (Apple) — règles concernées

| Règle | Exigence | État |
|---|---|---|
| **4.2** Fonctionnalité minimale | L'app doit aller « au-delà d'un site web reconditionné » | ⚠ Une simple coquille autour du site est souvent refusée. Emballer avec **Capacitor**, le code inclus dans l'app (pas `server.url`), avec localisation native, mode hors ligne, écrans d'erreur natifs, liens externes dans un navigateur intégré |
| **5.2.2** Services tiers | Être explicitement autorisé par les conditions de chaque service utilisé ; preuve sur demande | ⚠ Reste la recherche Photon publique (§1) |
| **5.1.1** Confidentialité | Lien vers la politique dans App Store Connect **et** dans l'app ; dire quelles données, où elles vont, durée, comment retirer son accord / effacer | ✅ `legal.html#confidentialite`, liens dans l'app et dans l'avertissement de départ. À compléter : nom de l'éditeur et e-mail |
| **5.1.5** Localisation | Seulement si utile à l'app ; expliquer le but ; consentement avant usage | ✅ Écran d'explication avant la demande système. Dans Capacitor : texte `NSLocationWhenInUseUsageDescription`, **pas** de localisation en arrière-plan |
| **1.4.5** Risques physiques | Ne pas pousser à utiliser l'appareil de façon dangereuse | ✅ Avertissement au 1er lancement : signalisation prioritaire, pas de manipulation en conduisant |
| **1.5** Infos développeur | URL de support et contact faciles à trouver | ⚠ À compléter : éditeur et e-mail dans `legal.html`, et sur le site de l'app |
| Confidentialité (fiche store) | « Étiquettes de confidentialité » à remplir | À faire : localisation précise (fonctionnement de l'app, non liée à l'identité, pas de pistage) ; contenu des recherches |
| Compte | Programme développeur Apple (payant, annuel) | À faire |

## 3. Google Play — règles concernées

| Exigence | État |
|---|---|
| **Compte personnel créé après le 13/11/2023** : test fermé avec **au moins 12 testeurs** inscrits **14 jours de suite** avant la mise en production (les comptes organisation en sont dispensés, mais demandent un numéro D-U-N-S) | À prévoir dans le planning |
| **Niveau d'API cible : Android 16 (API 36)** obligatoire pour toute nouvelle app ou mise à jour depuis le 31/08/2026 | À régler dans le projet Android (Capacitor ou TWA) |
| Politique de confidentialité (lien sur la fiche + dans l'app) | ✅ `legal.html` |
| Formulaire **Sécurité des données** : déclarer localisation précise (fonctionnement), recherches, envoi à des tiers (itinéraire, recherche) ; pas de vente ni de publicité | À remplir |
| Localisation **au premier plan seulement** (pas de déclaration spéciale « arrière-plan » nécessaire) | ✅ |
| Services tiers : mêmes conditions qu'au §1 | ⚠ Reste la recherche Photon publique |

Côté Android, une **TWA** (Trusted Web Activity, outil Bubblewrap) est acceptée par Google Play pour une PWA de qualité. Pour un seul code iOS + Android, **Capacitor** reste le plus simple.

## 4. Ce qu'il reste à faire avant de publier

1. **Recherche d'adresses** : Photon auto-hébergé ou hébergeur Photon payant (`photon` dans `js/config.js`).
   Pour la France entière, lancer `deploy/install_vps.sh` et publier le moteur et `data/obstacles` en HTTPS.
2. Compléter **éditeur + e-mail de contact** dans `legal.html` et sur le site de l'app (exigé par Apple 1.5 et par Google Play).
3. Emballer avec **Capacitor** (iOS + Android), code inclus dans l'app, User-Agent « Gabarit/1.0 (contact) », API Android 36.
4. Remplir les fiches de confidentialité (Apple) et Sécurité des données (Google).
5. Google : lancer le test fermé 12 testeurs × 14 jours.
6. Ne pas utiliser de marque, logo ou nom d'une autre app (ex. ne pas appeler l'app « … Maps »).

## Sources

- [App Store Review Guidelines (mise à jour du 16/10/2026)](https://developer.apple.com/app-store/review/guidelines/) — 1.4.5, 1.5, 4.2, 5.1.1, 5.1.5, 5.2.2
- [Conditions d'utilisation des serveurs OSM de FOSSGIS](https://www.fossgis.de/arbeitsgruppen/osm-server/nutzungsbedingungen/)
- [Overpass API — limites d'usage (wiki OSM)](https://wiki.openstreetmap.org/wiki/Overpass_API)
- [Photon — conditions d'utilisation](https://photon.komoot.io/)
- [OpenFreeMap](https://openfreemap.org/) et [conditions](https://openfreemap.org/tos/)
- [Google Play — test obligatoire pour les nouveaux comptes personnels](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en)
- [Google Play — niveau d'API cible](https://support.google.com/googleplay/android-developer/answer/11926878?hl=en-ZA)
