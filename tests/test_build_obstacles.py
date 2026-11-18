"""Tests de la lecture des hauteurs OSM (tools/build_obstacles.py).

    server/.venv/bin/python -m unittest discover -s tests

Les valeurs attendues pour les tuiles ont été relevées dans le navigateur avec
Tiles.x / Tiles.y de js/services.js : Python et JavaScript doivent ranger un passage
dans la même tuile, sinon l'application ne le retrouve pas.
"""
import os, sys, unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import build_obstacles as bo  # noqa: E402


class ParseHeight(unittest.TestCase):
    def test_metres(self):
        self.assertEqual(bo.parse_height("3.5"), 3.5)
        self.assertEqual(bo.parse_height("3,5"), 3.5)
        self.assertEqual(bo.parse_height("3.5 m"), 3.5)
        self.assertEqual(bo.parse_height("350 cm"), 3.5)

    def test_pieds_et_pouces(self):
        self.assertAlmostEqual(bo.parse_height("12'6\""), 3.81, places=2)
        self.assertAlmostEqual(bo.parse_height("13 ft"), 3.96, places=2)

    def test_sans_valeur(self):
        self.assertIsNone(bo.parse_height("none"))
        self.assertIsNone(bo.parse_height("default"))
        self.assertIsNone(bo.parse_height("n'importe quoi"))
        self.assertEqual(bo.parse_height("below_default"), "unknown")


class HeightLimit(unittest.TestCase):
    def test_prend_la_plus_basse(self):
        self.assertEqual(bo.height_limit({"maxheight": "3.8", "maxheight:physical": "3.6"}), 3.6)

    def test_valeurs_aberrantes_ignorees(self):
        self.assertIsNone(bo.height_limit({"maxheight": "0.2"}))
        self.assertIsNone(bo.height_limit({"maxheight": "45"}))

    def test_tunnel_sans_hauteur_inconnu(self):
        self.assertEqual(bo.height_limit({"highway": "primary", "tunnel": "yes"}), "unknown")
        self.assertEqual(bo.height_limit({"barrier": "height_restrictor"}), "unknown")

    def test_route_ordinaire_ignoree(self):
        self.assertIsNone(bo.height_limit({"highway": "primary"}))
        self.assertIsNone(bo.height_limit({"highway": "primary", "tunnel": "no"}))
        self.assertIsNone(bo.height_limit({"tunnel": "yes", "maxheight": "none"}))


class Tuiles(unittest.TestCase):
    def test_meme_grille_que_le_javascript(self):
        self.assertEqual(bo.tile_of(2.3488, 48.8534), (4149, 2818))   # Paris centre
        self.assertEqual(bo.tile_of(2.4117, 48.8443), (4150, 2818))   # avenue de Saint-Mandé
        self.assertEqual(bo.tile_of(-4.4861, 48.3904), (3993, 2834))  # Brest


if __name__ == "__main__":
    unittest.main()
