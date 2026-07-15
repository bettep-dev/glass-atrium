#!/usr/bin/env python3
# OFFLINE build-time tool — regenerates the Glass Atrium braille bulldog asset.
#
#   Regenerate:
#     python3 -m venv venv && venv/bin/pip install pillow \
#       && venv/bin/python bulldog-braille-gen.py
#
#   Input : bulldog-reference.webp  (same directory as this script)
#   Output: bulldog-braille.txt      (same directory as this script)
#   Deterministic: identical input -> identical output, no randomness.
#
# Not runtime code — nothing in the app imports this. It is self-contained
# (the flat-body + feature-sharpen pipeline is inlined) so it runs standalone
# from this directory with only Pillow installed.
"""Feature-sharpened flat braille bulldog head, made symmetric by mirror.

env-085 base: a flat solid body (`_fill_cut`) + crisp outer outline ring, with
Floyd-dithered detail inside the eyes/nose/mouth/ears envelope, squish 0.85,
width 56. The dither SOURCE inside that envelope is sharpened (UnsharpMask +
contrast push toward bimodal) so the dither resolves clean eye slits / nose
leather + nostrils / scowl mouth / brow notch instead of gray noise.

Symmetry pass (supersedes the old right-cheek smoothing):
The viewer-right cheek was over-smoothed, so the face read asymmetric. The fix
reflects the LEFT half of the dot bitmap — which keeps env-085's defined jowl
굴곡 (fold contour) — onto the RIGHT across the silhouette vertical center axis
(`_mirror_left_to_right`). The axis is the horizontal midpoint of the silhouette
bounding box (a nose-bridge proxy). Two modes:
  - "full": reflect the entire left half onto the right -> a perfectly symmetric
    face (both jowls/cheeks/eyes/ears mirror the good left side).
  - "cheek": reflect only the right jowl box (below the eyes, right of the
    muzzle) from the left jowl, keeping the central eyes/nose/brow/mouth and the
    ears as env-085 rendered them.
The mirror runs at the dot-bitmap level (deterministic column reflection), so the
right jowl ends up with the SAME defined 굴곡 as the left. The legacy right-only
silhouette/body smoothing is gone — the reflection supersedes it.
"""
from __future__ import annotations

from pathlib import Path

from PIL import (
    Image,
    ImageChops,
    ImageDraw,
    ImageEnhance,
    ImageFilter,
    ImageOps,
)

BASE = Path(__file__).resolve().parent
SRC = BASE / "bulldog-reference.webp"
OUT = BASE / "bulldog-braille.txt"

CONTRAST = 2.0
SHARPNESS = 2.5

GEN_BOX = (1160, 300, 1535, 645)
ALPHA_THR = 128
PAD = 6

CELL_ASPECT = 2.1
BLANK = chr(0x2800)

DOTS = [
    (0, 0, 0x01), (0, 1, 0x02), (0, 2, 0x04), (1, 0, 0x08),
    (1, 1, 0x10), (1, 2, 0x20), (0, 3, 0x40), (1, 3, 0x80),
]

# env-085 flat-body fill params (verbatim).
CUT_PARAMS = dict(blur=2.5, bright_thr=150, erode=4, feat_close=5, feat_open=5)

# env-085 feature envelope (verbatim): ears, eyes+brow, nose+mouth/muzzle folds.
FEATURE_BOXES = [
    (0.00, 0.03, 0.27, 0.45),  # left ear
    (0.73, 0.03, 1.00, 0.45),  # right ear
    (0.20, 0.33, 0.80, 0.56),  # eyes + brow furrow
    (0.28, 0.50, 0.72, 0.88),  # nose + mouth/muzzle folds
]

# "mid" variant params (feature-sharpen strength).
MID = dict(radius=3.0, percent=190, threshold=1, contrast=1.85)

# Which side to build the final asset from. "full" = whole left half mirrored to
# the right (cleanest symmetry). "cheek" = only the right jowl box mirrored.
FINAL_MIRROR = "full"

# Right-jowl target box for the "cheek" mirror mode: below the eyes (y>=0.55),
# right of the muzzle (x>=0.66) — the exact region that had been over-smoothed.
# The reflected source is the matching LEFT jowl, so central features + ears keep
# their env-085 rendering while only the right cheek picks up the left's 굴곡.
MIRROR_CHEEK_BOX = (0.66, 0.55, 1.00, 0.90)


def load_rgba() -> Image.Image:
    return Image.open(SRC).convert("RGBA")


def crop_head(rgba: Image.Image) -> Image.Image:
    box = rgba.crop(GEN_BOX)
    mask = box.getchannel("A").point(lambda p: 255 if p > ALPHA_THR else 0)
    bb = mask.getbbox()
    if bb:
        x0, y0, x1, y1 = bb
        x0 = max(0, x0 - PAD)
        y0 = max(0, y0 - PAD)
        x1 = min(box.width, x1 + PAD)
        y1 = min(box.height, y1 + PAD)
        box = box.crop((x0, y0, x1, y1))
    return box


def _base_lum(rgba_crop: Image.Image) -> Image.Image:
    """Composite over white -> L, with the reference contrast/sharpness."""
    white = Image.new("RGBA", rgba_crop.size, (255, 255, 255, 255))
    lum = Image.alpha_composite(white, rgba_crop).convert("L")
    lum = ImageEnhance.Contrast(lum).enhance(CONTRAST)
    lum = ImageEnhance.Sharpness(lum).enhance(SHARPNESS)
    return lum


def _mask_full(rgba_crop: Image.Image) -> Image.Image:
    return rgba_crop.getchannel("A").point(lambda p: 255 if p > ALPHA_THR else 0)


def _and(a: Image.Image, b: Image.Image) -> Image.Image:
    return ImageChops.darker(a, b)


def _close(img: Image.Image, k: int) -> Image.Image:
    """Fill small 0-holes (dilate 255 then erode). Keeps large features."""
    if k < 3:
        return img
    return img.filter(ImageFilter.MaxFilter(k)).filter(ImageFilter.MinFilter(k))


def _open(img: Image.Image, k: int) -> Image.Image:
    """Remove small 255-specks (erode then dilate)."""
    if k < 3:
        return img
    return img.filter(ImageFilter.MinFilter(k)).filter(ImageFilter.MaxFilter(k))


def _fill_cut(rgba_crop, cols, rows, blur, bright_thr, erode,
              feat_close=5, feat_open=3) -> Image.Image:
    """Solid silhouette minus CLEAN interior bright features (rim kept solid)."""
    lum = _base_lum(rgba_crop)
    blurred = lum.filter(ImageFilter.GaussianBlur(radius=blur)) if blur else lum
    mask = _mask_full(rgba_crop)
    interior = mask.filter(ImageFilter.MinFilter(size=max(3, 2 * erode + 1)))
    bright = blurred.point(lambda p: 255 if p > bright_thr else 0)
    feature = _and(bright, interior)
    feature = _open(_close(feature, feat_close), feat_open)
    fill_full = _and(mask, ImageOps.invert(feature))
    return fill_full.resize((cols, rows)).point(lambda p: 255 if p >= 128 else 0)


def _remove_orphans(dots: list[list[bool]], cols: int, rows: int) -> None:
    snap = [row[:] for row in dots]
    for y in range(rows):
        for x in range(cols):
            if not snap[y][x]:
                continue
            has_neighbour = False
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if dx == 0 and dy == 0:
                        continue
                    yy, xx = y + dy, x + dx
                    if 0 <= yy < rows and 0 <= xx < cols and snap[yy][xx]:
                        has_neighbour = True
                        break
                if has_neighbour:
                    break
            if not has_neighbour:
                dots[y][x] = False


def _is_blank_row(line: str) -> bool:
    return all(ch == BLANK for ch in line)


def _rstrip_blank(line: str) -> str:
    end = len(line)
    while end > 0 and line[end - 1] == BLANK:
        end -= 1
    return line[:end]


def _feature_env(cols: int, rows: int, boxes) -> Image.Image:
    env = Image.new("L", (cols, rows), 0)
    draw = ImageDraw.Draw(env)
    for x0, y0, x1, y1 in boxes:
        draw.rectangle([x0 * cols, y0 * rows, x1 * cols - 1, y1 * rows - 1], fill=255)
    return env


def _sharpen_feature_source(lum_small, env_small, *, radius, percent, threshold,
                            contrast) -> Image.Image:
    """Sharpen the dither SOURCE inside the feature envelope only."""
    sharp = lum_small.filter(
        ImageFilter.UnsharpMask(radius=radius, percent=percent, threshold=threshold)
    )
    sharp = ImageEnhance.Contrast(sharp).enhance(contrast)
    return Image.composite(sharp, lum_small, env_small)


def _silhouette_axis(dots, cols, rows) -> float | None:
    """Horizontal midpoint of the ON-dot bounding box (nose-bridge proxy)."""
    minx, maxx = cols, -1
    for y in range(rows):
        row = dots[y]
        for x in range(cols):
            if row[x]:
                if x < minx:
                    minx = x
                if x > maxx:
                    maxx = x
    if maxx < 0:
        return None
    return (minx + maxx) / 2.0


def _mirror_left_to_right(dots, cols, rows, *, mode, cheek_box) -> float | None:
    """Reflect the LEFT half of the dot bitmap onto the RIGHT across the axis.

    The right side (over-smoothed) is replaced by the reflection of the left
    (which carries env-085's defined jowl 굴곡), so the face becomes symmetric.
    "full" reflects the whole right half; "cheek" reflects only the right jowl
    box, leaving the central features + ears as env-085 rendered them.
    """
    if mode == "none":
        return None
    axis = _silhouette_axis(dots, cols, rows)
    if axis is None:
        return None

    def source_x(x: int) -> int:
        return int(round(2 * axis - x))

    if mode == "full":
        rx0, rx1, ry0, ry1 = 0, cols, 0, rows
    elif mode == "cheek":
        x0f, y0f, x1f, y1f = cheek_box
        rx0, rx1 = int(x0f * cols), int(x1f * cols)
        ry0, ry1 = int(y0f * rows), int(y1f * rows)
    else:
        raise ValueError(f"unknown mirror mode: {mode!r}")

    for y in range(max(0, ry0), min(rows, ry1)):
        row = dots[y]
        for x in range(max(0, rx0), min(cols, rx1)):
            if x <= axis:  # keep the good left half + center column intact
                continue
            sx = source_x(x)
            row[x] = row[sx] if 0 <= sx < cols else False
    return axis


def to_braille(crop, width, squish, *, radius, percent, threshold, contrast,
               outline=1, mirror="full"):
    w, h = crop.size
    cols = width * 2
    new_h = int(h * width / w * 2 * squish)
    rows = max(4, (new_h // 4) * 4)

    body = _fill_cut(crop, cols, rows, **CUT_PARAMS)
    # Plain env-085 silhouette (NEAREST) — the mirror handles the right jowl.
    mask = (
        _mask_full(crop)
        .resize((cols, rows), Image.NEAREST)
        .point(lambda p: 255 if p > ALPHA_THR else 0)
    )
    lum = _base_lum(crop)

    feat = _feature_env(cols, rows, FEATURE_BOXES)
    feat = ImageChops.darker(feat, mask)  # never outside the silhouette
    lum_small = lum.resize((cols, rows))
    feat_lum = _sharpen_feature_source(
        lum_small, feat, radius=radius, percent=percent,
        threshold=threshold, contrast=contrast,
    )
    dither = feat_lum.convert("1")  # Floyd-Steinberg, 0 = dark

    interior = (
        mask.filter(ImageFilter.MinFilter(2 * outline + 1)) if outline else mask
    )
    ring = ImageChops.subtract(mask, interior)

    bp, mp, dp, fe, rg = body.load(), mask.load(), dither.load(), feat.load(), ring.load()
    dots = [[False] * cols for _ in range(rows)]
    for y in range(rows):
        for x in range(cols):
            if mp[x, y] == 0:
                continue
            if rg[x, y] > 0:
                dots[y][x] = True  # crisp outline
            elif fe[x, y] > 0:
                dots[y][x] = dp[x, y] == 0  # sharpened feature dither
            else:
                dots[y][x] = bp[x, y] > 0  # flat solid body
    # Mirror the good LEFT jowl 굴곡 onto the RIGHT -> symmetric face.
    _mirror_left_to_right(dots, cols, rows, mode=mirror, cheek_box=MIRROR_CHEEK_BOX)
    _remove_orphans(dots, cols, rows)

    raw_lines: list[str] = []
    for cy in range(0, rows, 4):
        chars: list[str] = []
        for cx in range(0, cols, 2):
            value = 0
            for dx, dy, bit in DOTS:
                x, y = cx + dx, cy + dy
                if y < rows and x < cols and dots[y][x]:
                    value |= bit
            chars.append(chr(0x2800 + value))
        raw_lines.append("".join(chars))

    top, bottom = 0, len(raw_lines)
    while top < bottom and _is_blank_row(raw_lines[top]):
        top += 1
    while bottom > top and _is_blank_row(raw_lines[bottom - 1]):
        bottom -= 1
    return [_rstrip_blank(line) for line in raw_lines[top:bottom]]


def main() -> None:
    crop = crop_head(load_rgba())
    lines = to_braille(crop, width=56, squish=0.85, mirror=FINAL_MIRROR, **MID)
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    cells_h = len(lines)
    cells_w = max((len(line) for line in lines), default=0)
    print(f"wrote {OUT.name}: cells_w={cells_w} cells_h={cells_h} mirror={FINAL_MIRROR}")


if __name__ == "__main__":
    main()
