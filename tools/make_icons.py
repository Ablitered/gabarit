"""Redessine les icônes PNG de icons/ (même motif que icons/icon.svg), sans dépendance.

Usage : python3 tools/make_icons.py [dossier]   (par défaut : icons)
"""
import math, struct, sys, zlib, os

def png(path, size, maskable=False):
    S = 3  # suréchantillonnage pour des bords lisses
    out = bytearray()
    c = size / 2
    scale = (0.78 if maskable else 1.0) * size / 512  # zone sûre pour l'icône adaptative
    def color(x, y):
        # coordonnées dans le repère 512 de l'icône
        X = (x - c) / scale + 256; Y = (y - c) / scale + 256
        if not maskable:
            r = 112 * size / 512
            dx = max(abs(x - c) - (c - r), 0); dy = max(abs(y - c) - (c - r), 0)
            if dx * dx + dy * dy > r * r: return None
        d = math.hypot(X - 256, Y - 256)
        if d > 168: return (31, 111, 235)
        if d >= 132: return (229, 57, 53)  # anneau rouge du panneau
        # flèches haut/bas + tige
        if 128 <= Y <= 196 and abs(X - 256) <= (Y - 128) * 50 / 68: return (31, 31, 31)
        if 316 <= Y <= 384 and abs(X - 256) <= (384 - Y) * 50 / 68: return (31, 31, 31)
        if 244 <= X <= 268 and 190 <= Y <= 322: return (31, 31, 31)
        return (255, 255, 255)
    for y in range(size):
        out.append(0)
        for x in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(S):
                for sx in range(S):
                    col = color(x + (sx + 0.5) / S, y + (sy + 0.5) / S)
                    if col:
                        acc[0] += col[0]; acc[1] += col[1]; acc[2] += col[2]; acc[3] += 255
            n = S * S
            a = acc[3] // n
            if a:
                k = acc[3] / 255
                out += bytes((int(acc[0] / k), int(acc[1] / k), int(acc[2] / k), a))
            else:
                out += b"\0\0\0\0"
    def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    raw = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(bytes(out), 9)) + chunk(b"IEND", b"")
    open(path, "wb").write(raw)

d = sys.argv[1] if len(sys.argv) > 1 else "icons"
png(os.path.join(d, "icon-192.png"), 192)
png(os.path.join(d, "icon-512.png"), 512)
png(os.path.join(d, "icon-180.png"), 180)  # iPhone (écran d'accueil)
png(os.path.join(d, "icon-maskable-512.png"), 512, maskable=True)
print("ok")
