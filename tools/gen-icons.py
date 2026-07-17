#!/usr/bin/env python3
"""Generate TrueTabs action icons (extension/icons/tt-{16,32,48,128}.png).

Stdlib only: rounded-rect signed-distance rendering with 4x4 supersampling,
hand-written PNG encoder. Glyph: a cascade of three white "tab cards" on a
Material-blue rounded square (the TruePin family palette)."""
import os
import struct
import sys
import zlib

BLUE = (26, 115, 232)  # #1a73e8 - Material/TruePin accent
CARDS = [
    # cx, cy, half-w, half-h, radius, alpha (normalized 0..1 canvas)
    (0.400, 0.335, 0.215, 0.115, 0.050, 0.50),
    (0.478, 0.500, 0.215, 0.115, 0.050, 0.74),
    (0.560, 0.665, 0.215, 0.115, 0.050, 1.00),
]
BG = (0.5, 0.5, 0.5, 0.5, 0.21, 1.0)


def rr_dist(px, py, cx, cy, hw, hh, r):
    qx = abs(px - cx) - (hw - r)
    qy = abs(py - cy) - (hh - r)
    ox = qx if qx > 0 else 0.0
    oy = qy if qy > 0 else 0.0
    return (ox * ox + oy * oy) ** 0.5 + min(max(qx, qy), 0.0) - r


def coverage(px, py, shape, aa):
    cx, cy, hw, hh, r, _ = shape
    d = rr_dist(px, py, cx, cy, hw, hh, r)
    a = 0.5 - d / aa
    return 0.0 if a <= 0 else (1.0 if a >= 1 else a)


def render(size):
    ss = 4  # 4x4 supersampling
    aa = 1.0 / size  # ~1px smoothing in normalized units
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            r = g = b = a = 0.0
            for sy in range(ss):
                for sx in range(ss):
                    px = (x + (sx + 0.5) / ss) / size
                    py = (y + (sy + 0.5) / ss) / size
                    # background square
                    ca = coverage(px, py, BG, aa)
                    sr, sg, sb, sa = BLUE[0] * ca, BLUE[1] * ca, BLUE[2] * ca, ca
                    # white cards over it
                    for card in CARDS:
                        cv = coverage(px, py, card, aa) * card[5]
                        if cv > 0:
                            sr = 255 * cv + sr * (1 - cv)
                            sg = 255 * cv + sg * (1 - cv)
                            sb = 255 * cv + sb * (1 - cv)
                            sa = cv + sa * (1 - cv)
                    r += sr
                    g += sg
                    b += sb
                    a += sa
            n = ss * ss
            row += bytes(
                (
                    min(255, round(r / n)),
                    min(255, round(g / n)),
                    min(255, round(b / n)),
                    min(255, round(a / n * 255) if a / n <= 1 else 255),
                )
            )
        rows.append(bytes(row))
    return rows


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


def ring_coverage(px, py, shape, aa, thickness):
    """Outline of a rounded rect: |distance| within half the stroke width."""
    cx, cy, hw, hh, r, _ = shape
    d = abs(rr_dist(px, py, cx, cy, hw, hh, r)) - thickness / 2
    a = 0.5 - d / aa
    return 0.0 if a <= 0 else (1.0 if a >= 1 else a)


# Chrome-style monochrome glyph: a single OUTLINED browser tab card with a
# "header" line, grey, on transparency - like the toolbar icons Chrome ships.
MONO_CARD = (0.5, 0.52, 0.34, 0.27, 0.09, 1.0)
MONO_HEADER_Y = 0.37  # separator line under the card's header strip


def render_mono(size):
    grey = (95, 99, 104)  # #5f6368 - Chrome's neutral icon grey
    ss = 4
    aa = 1.0 / size
    stroke = max(2.0 / size, 0.075)  # >= 2px at 16, elegant at 128
    rows = []
    cx, cy, hw, hh, r, _ = MONO_CARD
    for y in range(size):
        row = bytearray()
        for x in range(size):
            acc = 0.0
            for sy in range(ss):
                for sx in range(ss):
                    px = (x + (sx + 0.5) / ss) / size
                    py = (y + (sy + 0.5) / ss) / size
                    cv = ring_coverage(px, py, MONO_CARD, aa, stroke)
                    # header separator line inside the card
                    if (
                        cx - hw + stroke * 1.2 < px < cx + hw - stroke * 1.2
                        and abs(py - MONO_HEADER_Y) < stroke / 2
                    ):
                        cv = 1.0
                    acc += cv
            a = acc / (ss * ss)
            row += bytes((grey[0], grey[1], grey[2], min(255, round(a * 255))))
        rows.append(bytes(row))
    return rows


def main():
    out_dir = os.path.join(os.path.dirname(__file__), "..", "extension", "icons")
    os.makedirs(out_dir, exist_ok=True)
    for size in (16, 32, 48, 128):
        path = os.path.join(out_dir, f"tt-{size}.png")
        write_png(path, size, render(size))
        print(f"wrote {path}")
        mono = os.path.join(out_dir, f"tt-mono-{size}.png")
        write_png(mono, size, render_mono(size))
        print(f"wrote {mono}")


if __name__ == "__main__":
    sys.exit(main())
