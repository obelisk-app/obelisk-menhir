#!/usr/bin/env python3
"""Regenerate the desktop app icons from the obelisk mark.

Two shapes come out of this:

* **Full bleed** — the green tile fills the whole canvas. What Windows and
  Linux expect, and what `icon.png` / `.ico` / the small PNGs use.
* **macOS** — the artwork sits in a rounded square occupying 824 of 1024
  pixels, per Apple's icon grid. Without that margin the icon renders larger
  than every other app in the Dock, because macOS expects to be given the
  padding rather than adding it.

The mark itself is drawn from the same two-face obelisco geometry the UI uses
(`app/ui/src/icons.js`), centred — the previous artwork was traced off-centre.

    python3 scripts/make-icons.py
"""

import struct
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "app/src-tauri/icons"

GREEN = (180, 249, 83, 255)
BLACK = (10, 10, 10, 255)
# The shaded face: the SVG draws it at 70% opacity over the green.
SHADED = tuple(round(b * 0.7 + g * 0.3) for b, g in zip(BLACK, GREEN))[:3] + (255,)

SS = 4  # supersampling factor; edges are downscaled back to size

# Obelisco outline in the SVG's 512-unit viewBox.
LEFT_FACE = [(256, 16), (220, 72), (196, 460), (200, 464), (256, 464), (256, 72)]
RIGHT_FACE = [(256, 16), (292, 72), (316, 460), (312, 464), (256, 464), (256, 72)]
MARK_BOX = (196, 16, 316, 464)  # x0, y0, x1, y1 of the drawn area


def draw_mark(img: Image.Image, box: tuple[float, float, float, float]) -> None:
    """Draw the obelisk centred inside `box` (x0, y0, x1, y1), keeping aspect."""
    x0, y0, x1, y1 = box
    mx0, my0, mx1, my1 = MARK_BOX
    scale = min((x1 - x0) / (mx1 - mx0), (y1 - y0) / (my1 - my0))
    w, h = (mx1 - mx0) * scale, (my1 - my0) * scale
    ox = x0 + ((x1 - x0) - w) / 2 - mx0 * scale
    oy = y0 + ((y1 - y0) - h) / 2 - my0 * scale
    d = ImageDraw.Draw(img)
    for face, colour in ((LEFT_FACE, SHADED), (RIGHT_FACE, BLACK)):
        d.polygon([(ox + px * scale, oy + py * scale) for px, py in face], fill=colour)


def full_bleed(size: int) -> Image.Image:
    big = size * SS
    img = Image.new("RGBA", (big, big), GREEN)
    # The mark takes ~68% of the height, centred — enough presence at 32px.
    inset = big * 0.16
    draw_mark(img, (inset, inset, big - inset, big - inset))
    return img.resize((size, size), Image.LANCZOS)


def macos(size: int) -> Image.Image:
    """Apple's grid: an 824/1024 rounded square with transparent margins."""
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    tile = round(big * 824 / 1024)
    margin = (big - tile) / 2
    radius = tile * 0.2247  # the corner radius Apple's template uses
    ImageDraw.Draw(img).rounded_rectangle(
        (margin, margin, margin + tile, margin + tile), radius=radius, fill=GREEN
    )
    inset = tile * 0.17
    draw_mark(img, (margin + inset, margin + inset, margin + tile - inset, margin + tile - inset))
    return img.resize((size, size), Image.LANCZOS)


def png_bytes(img: Image.Image) -> bytes:
    from io import BytesIO

    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def write_icns(path: Path) -> None:
    """An ICNS of PNG entries — every size macOS asks for, at 1x and 2x."""
    entries = [
        (b"icp4", 16), (b"icp5", 32),
        (b"ic11", 32), (b"ic12", 64),   # 16@2x, 32@2x
        (b"ic07", 128), (b"ic13", 256),  # 128, 128@2x
        (b"ic08", 256), (b"ic14", 512),  # 256, 256@2x
        (b"ic09", 512), (b"ic10", 1024),  # 512, 512@2x
    ]
    chunks = b""
    for tag, size in entries:
        data = png_bytes(macos(size))
        chunks += tag + struct.pack(">I", len(data) + 8) + data
    path.write_bytes(b"icns" + struct.pack(">I", len(chunks) + 8) + chunks)


def main() -> None:
    master = full_bleed(1024)
    (ROOT / "app/icon-source.png").write_bytes(png_bytes(master))
    for name, size in [
        ("32x32.png", 32),
        ("64x64.png", 64),
        ("128x128.png", 128),
        ("128x128@2x.png", 256),
        ("icon.png", 512),
    ]:
        full_bleed(size).save(ICONS / name)
    # Windows wants every size in one file.
    master.save(ICONS / "icon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    write_icns(ICONS / "icon.icns")
    print(f"wrote icons to {ICONS}")


if __name__ == "__main__":
    main()
