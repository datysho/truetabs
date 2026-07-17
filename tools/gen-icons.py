#!/usr/bin/env python3
"""Generate TrueTabs action icons - stdlib only, SDF rendering + PNG encoder.

ONE glyph, two treatments (the way Chrome pairs filled/outline icons):
a stack of two tab cards - the front card over a back card peeking out
top-left. Color: white filled stack on a Material-blue rounded badge.
Mono: the same stack as a thin grey outline on transparency, stroke weight
matched to Chrome's own toolbar icons."""
import os
import struct
import sys
import zlib

BLUE = (26, 115, 232)  # #1a73e8 - Material/TruePin accent
GREY = (95, 99, 104)  # #5f6368 - Chrome's neutral icon grey

BADGE = (0.5, 0.5, 0.5, 0.5, 0.21)
# Shared stack geometry (normalized): front card + back card offset up-left.
FRONT = (0.565, 0.565, 0.255, 0.215, 0.055)
BACK = (0.435, 0.435, 0.255, 0.215, 0.055)


def rr_dist(px, py, shape):
    cx, cy, hw, hh, r = shape
    qx = abs(px - cx) - (hw - r)
    qy = abs(py - cy) - (hh - r)
    ox = qx if qx > 0 else 0.0
    oy = qy if qy > 0 else 0.0
    return (ox * ox + oy * oy) ** 0.5 + min(max(qx, qy), 0.0) - r


def clamp01(v):
    return 0.0 if v <= 0 else (1.0 if v >= 1 else v)


def fill_cov(px, py, shape, aa):
    return clamp01(0.5 - rr_dist(px, py, shape) / aa)


def ring_cov(px, py, shape, aa, stroke):
    return clamp01(0.5 - (abs(rr_dist(px, py, shape)) - stroke / 2) / aa)


def render(size, mode):
    ss = 4
    aa = 1.0 / size
    # Chrome-native stroke weight: ~2px at 16, scaling gently with size.
    stroke = (1.6 + size * 0.05) / size
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            r_acc = g_acc = b_acc = a_acc = 0.0
            for sy in range(ss):
                for sx in range(ss):
                    px = (x + (sx + 0.5) / ss) / size
                    py = (y + (sy + 0.5) / ss) / size
                    if mode == "color":
                        # badge, then the white stack (painter's order)
                        ca = fill_cov(px, py, BADGE, aa)
                        sr, sg, sb, sa = BLUE[0] * ca, BLUE[1] * ca, BLUE[2] * ca, ca
                        for card, alpha in ((BACK, 0.55), (FRONT, 1.0)):
                            cv = fill_cov(px, py, card, aa) * alpha
                            if cv > 0:
                                sr = 255 * cv + sr * (1 - cv)
                                sg = 255 * cv + sg * (1 - cv)
                                sb = 255 * cv + sb * (1 - cv)
                                sa = cv + sa * (1 - cv)
                    else:
                        # outline stack: back ring only where the front card
                        # (grown by a hair gap) does not cover it
                        gap = fill_cov(px, py, grow(FRONT, stroke * 0.9), aa)
                        cv = max(
                            ring_cov(px, py, FRONT, aa, stroke),
                            ring_cov(px, py, BACK, aa, stroke) * (1 - gap),
                        )
                        sr, sg, sb, sa = GREY[0], GREY[1], GREY[2], cv
                    r_acc += sr
                    g_acc += sg
                    b_acc += sb
                    a_acc += sa
            n = ss * ss
            row += bytes(
                (
                    min(255, round(r_acc / n)),
                    min(255, round(g_acc / n)),
                    min(255, round(b_acc / n)),
                    min(255, round(a_acc / n * 255) if a_acc / n <= 1 else 255),
                )
            )
        rows.append(bytes(row))
    return rows


def grow(shape, by):
    cx, cy, hw, hh, r = shape
    return (cx, cy, hw + by, hh + by, r + by)


def write_png(path, size, rows):
    def chunk(tag, data):
        payload = tag + data
        return struct.pack(">I", len(data)) + payload + struct.pack(">I", zlib.crc32(payload))

    raw = b"".join(b"\x00" + row for row in rows)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)


def main():
    out_dir = os.path.join(os.path.dirname(__file__), "..", "extension", "icons")
    os.makedirs(out_dir, exist_ok=True)
    for size in (16, 32, 48, 128):
        for mode, name in (("color", f"tt-{size}.png"), ("mono", f"tt-mono-{size}.png")):
            path = os.path.join(out_dir, name)
            write_png(path, size, render(size, mode))
            print(f"wrote {path}")


if __name__ == "__main__":
    sys.exit(main())
