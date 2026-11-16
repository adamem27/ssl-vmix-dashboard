#!/usr/bin/env python3
"""Draws the race signal flags of server/fixtures/race-flags that are not original (1.0) pictures, in their style.

The set's look is the original one: every flag fills the 512 x 512 square, flat colours, corners rounded (radius 64),
a thin light grey edge where a flag is white at its border; a combination ("N over H") is two flags one over the
other, each as wide as the square and just under half its height. Most pictures are still the original files.
Drawn here, in that style:
  - the cut flags: AP as a tapered pennant and A as a swallowtail, alone and in every combination (AP over A/H/1/2/3,
    N over A), with the same rounded corners;
  - the combinations that came later: C + red / green / minus / plus, AP over 1 / 2 / 3.
Needs Pillow; no fonts (the contact sheet uses one if it finds one).

  python3 scripts/race-flags.py [out-dir] [--sheet preview.png]
"""
import math
import os
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

S = 4                      # supersampling
SIZE = 512
RADIUS = 64                # corner radius at 512, as the original set
EDGE = 5                   # light grey edge on white, at 512
EDGE_GREY = (209, 209, 209)
HALF = 247.5               # height of a flag in a combination; the lower one starts at 512 - HALF
R, W, B, Y, K = (227, 6, 19), (255, 255, 255), (0, 87, 184), (244, 237, 0), (0, 0, 0)
G = (0, 154, 68)


# ---------- designs: paint the whole box (x, y, w, h) ----------
def plain(c):
    return lambda d, x, y, w, h: d.rectangle([x, y, x + w, y + h], fill=c)


def vstripes(*cs):
    def f(d, x, y, w, h):
        for i, c in enumerate(cs):
            d.rectangle([x + w * i / len(cs), y, x + w * (i + 1) / len(cs), y + h], fill=c)
    return f


def hstripes(*cs):
    def f(d, x, y, w, h):
        for i, c in enumerate(cs):
            d.rectangle([x, y + h * i / len(cs), x + w, y + h * (i + 1) / len(cs)], fill=c)
    return f


def checks(c1, c2, cols=4):
    def f(d, x, y, w, h):
        rows = max(1, round(h / (w / cols)))
        for i in range(rows):
            for j in range(cols):
                d.rectangle([x + w * j / cols, y + h * i / rows, x + w * (j + 1) / cols, y + h * (i + 1) / rows],
                            fill=c1 if (i + j) % 2 == 0 else c2)
    return f


def disc(bg, fg, r=0.27):
    def f(d, x, y, w, h):
        d.rectangle([x, y, x + w, y + h], fill=bg)
        c, rr = (x + w / 2, y + h / 2), h * r
        d.ellipse([c[0] - rr, c[1] - rr, c[0] + rr, c[1] + rr], fill=fg)
    return f


def minus(d, x, y, w, h):
    d.rectangle([x, y, x + w, y + h], fill=W)
    t, l = h * 0.16, h * 0.6
    d.rectangle([x + w / 2 - l / 2, y + h / 2 - t / 2, x + w / 2 + l / 2, y + h / 2 + t / 2], fill=K)


def plus(d, x, y, w, h):
    minus(d, x, y, w, h)
    t, l = h * 0.16, h * 0.6
    d.rectangle([x + w / 2 - t / 2, y + h / 2 - l / 2, x + w / 2 + t / 2, y + h / 2 + l / 2], fill=K)


# ---------- shapes: the outline polygon in the box ----------
def shape(kind, x, y, w, h):
    if kind == 'rect': return [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
    if kind == 'swallow': return [(x, y), (x + w, y), (x + w * 0.72, y + h / 2), (x + w, y + h), (x, y + h)]
    if kind == 'pennant': return [(x, y), (x + w, y + h * 0.33), (x + w, y + h * 0.67), (x, y + h)]
    if kind == 'tri_up':
        tw = h * 1.15
        return [(x + w / 2, y), (x + w / 2 + tw / 2, y + h), (x + w / 2 - tw / 2, y + h)]
    raise ValueError(kind)


SMALL = {'swallow': {2: 10}, 'tri_up': {0: 26, 1: 26, 2: 26}}   # corners not as round as the rest (at 512)


def rounded(poly, r, radii=None):
    """The polygon with every corner filleted (radius r or radii[i], less where an edge is too short for it)."""
    n, out = len(poly), []
    for i in range(n):
        r_i = (radii or {}).get(i, r)
        p, a, b = poly[i], poly[i - 1], poly[(i + 1) % n]
        u1 = (a[0] - p[0], a[1] - p[1]); l1 = math.hypot(*u1); u1 = (u1[0] / l1, u1[1] / l1)
        u2 = (b[0] - p[0], b[1] - p[1]); l2 = math.hypot(*u2); u2 = (u2[0] / l2, u2[1] / l2)
        half = math.acos(max(-1.0, min(1.0, u1[0] * u2[0] + u1[1] * u2[1]))) / 2
        t = min(r_i / math.tan(half), l1 * 0.45, l2 * 0.45)        # tangent distance from the corner
        rr = t * math.tan(half)
        bis = (u1[0] + u2[0], u1[1] + u2[1]); bl = math.hypot(*bis); bis = (bis[0] / bl, bis[1] / bl)
        c = (p[0] + bis[0] * rr / math.sin(half), p[1] + bis[1] * rr / math.sin(half))
        s, e = (p[0] + u1[0] * t, p[1] + u1[1] * t), (p[0] + u2[0] * t, p[1] + u2[1] * t)
        a0, a1 = math.atan2(s[1] - c[1], s[0] - c[0]), math.atan2(e[1] - c[1], e[0] - c[0])
        da = (a1 - a0 + math.pi) % (2 * math.pi) - math.pi                   # the short way round
        for k in range(25):
            ang = a0 + da * k / 24
            out.append((c[0] + rr * math.cos(ang), c[1] + rr * math.sin(ang)))
    return out


F = {   # design, shape
    'A': (vstripes(W, B), 'swallow'), 'C': (hstripes(B, W, R, W, B), 'rect'),
    'H': (vstripes(W, R), 'rect'), 'N': (checks(B, W), 'rect'),
    'AP': (vstripes(R, W, R, W, R), 'pennant'),
    '1': (disc(W, R), 'rect'), '2': (disc(B, W), 'rect'), '3': (vstripes(R, W, B), 'rect'),
    'PORT': (plain(R), 'rect'), 'STARBOARD': (plain(G), 'tri_up'),
    'MINUS': (minus, 'rect'), 'PLUS': (plus, 'rect'),
}
SOLO_HEIGHT = {'AP': 360}    # the pennant alone is not as tall as the square, like a pennant beside a flag


def draw_one(img, key, x, y, w, h):
    design, kind = F[key]
    layer = Image.new('RGB', img.size, (0, 0, 0))
    design(ImageDraw.Draw(layer), x, y, w, h)
    mask = Image.new('L', img.size, 0)
    ImageDraw.Draw(mask).polygon(rounded(shape(kind, x, y, w, h), RADIUS * S, {i: v * S for i, v in SMALL.get(kind, {}).items()}), fill=255)
    # the light grey edge where the flag is white at its border, as the original set
    small = mask.resize((img.size[0] // S, img.size[1] // S), Image.BOX).point(lambda v: 255 if v >= 128 else 0)
    inner = small.filter(ImageFilter.MinFilter(EDGE * 2 + 1)).resize(img.size, Image.BILINEAR)
    ring = ImageChops.subtract(mask, inner)
    white = layer.convert('L').point(lambda v: 255 if v >= 254 else 0)
    layer.paste(EDGE_GREY, (0, 0), ImageChops.multiply(ring, white))
    img.paste(layer, (0, 0), mask)


def render(keys):
    big = Image.new('RGBA', (SIZE * S, SIZE * S), (0, 0, 0, 0))
    if len(keys) == 1:
        h = SOLO_HEIGHT.get(keys[0], SIZE)
        draw_one(big, keys[0], 0, (SIZE - h) / 2 * S, SIZE * S, h * S)
    else:
        draw_one(big, keys[0], 0, 0, SIZE * S, HALF * S)
        draw_one(big, keys[1], 0, (SIZE - HALF) * S, SIZE * S, HALF * S)
    return big.resize((SIZE, SIZE), Image.LANCZOS)


# the pictures drawn here: file name, signals (top first)
DRAWN = [
    ('AP_postponed.png', ['AP']),
    ('AP_over_A_postponed_no_more_racing_today.png', ['AP', 'A']),
    ('AP_over_H_postponed_signals_ashore.png', ['AP', 'H']),
    ('AP_over_1_postponed_1_hour.png', ['AP', '1']),
    ('AP_over_2_postponed_2_hours.png', ['AP', '2']),
    ('AP_over_3_postponed_3_hours.png', ['AP', '3']),
    ('A_ashore.png', ['A']),
    ('N_over_A_abandoned_no_more_racing_today.png', ['N', 'A']),
    ('C_red_mark_moved_to_port.png', ['C', 'PORT']),
    ('C_green_mark_moved_to_starboard.png', ['C', 'STARBOARD']),
    ('C_minus_leg_shortened.png', ['C', 'MINUS']),
    ('C_plus_leg_lengthened.png', ['C', 'PLUS']),
]


def sheet(folder, path):
    """Every picture in the folder, with its name."""
    names = sorted(f for f in os.listdir(folder) if f.endswith('.png'))
    cols, cell, lab = 7, 220, 44
    rows = (len(names) + cols - 1) // cols
    img = Image.new('RGB', (cols * cell, rows * (cell + lab)), (200, 204, 210))
    font = None
    for p in ('/usr/share/fonts/opentype/inter/Inter-Medium.otf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'):
        if os.path.exists(p): font = ImageFont.truetype(p, 12); break
    d = ImageDraw.Draw(img)
    for i, name in enumerate(names):
        x, y = (i % cols) * cell, (i // cols) * (cell + lab)
        ic = Image.open(os.path.join(folder, name)).convert('RGBA').resize((cell - 40, cell - 40), Image.LANCZOS)
        img.paste(ic, (x + 20, y + 16), ic)
        lines = ['']
        for wd in name[:-4].split('_'):
            if lines[-1] and len(lines[-1]) + len(wd) > 26: lines.append('')
            lines[-1] = (lines[-1] + ' ' + wd).strip()
        for j, line in enumerate(lines[:3]):
            d.text((x + cell / 2, y + cell - 18 + j * 15), line, fill=(20, 20, 20), anchor='mt', font=font)
    img.save(path)


if __name__ == '__main__':
    args = list(sys.argv[1:])
    sheet_path = None
    if '--sheet' in args:
        i = args.index('--sheet'); sheet_path = args[i + 1]; del args[i:i + 2]
    out = args[0] if args else os.path.join(os.path.dirname(__file__), '..', 'server', 'fixtures', 'race-flags')
    os.makedirs(out, exist_ok=True)
    for name, keys in DRAWN:
        render(keys).save(os.path.join(out, name), optimize=True)
    if sheet_path: sheet(out, sheet_path)
