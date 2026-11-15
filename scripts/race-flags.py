#!/usr/bin/env python3
"""Draws the race signal flags of server/fixtures/race-flags (512 x 512 PNG, transparent background).

International Code of Signals designs, drawn like a Racing Rules of Sailing race signals chart: rectangular flags,
tapered pennants, a triangular First substitute and a swallowtailed A, each with a thin dark outline; a combination
("AP over H", "C + red") shows its two signals stacked. Needs Pillow; no fonts.

  python3 scripts/race-flags.py [out-dir] [--sheet preview.png]
"""
import math
import os
import sys

from PIL import Image, ImageDraw, ImageFont

S = 4                      # supersampling
SIZE = 512
R, W, B, Y, K = (227, 6, 19), (255, 255, 255), (0, 87, 184), (244, 210, 0), (17, 17, 17)
G, O = (0, 154, 68), (255, 122, 0)
LINE = (34, 34, 34)
OUT = 6                    # outline width at 512


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


def quarters(tl, tr, bl, br):
    def f(d, x, y, w, h):
        d.rectangle([x, y, x + w / 2, y + h / 2], fill=tl); d.rectangle([x + w / 2, y, x + w, y + h / 2], fill=tr)
        d.rectangle([x, y + h / 2, x + w / 2, y + h], fill=bl); d.rectangle([x + w / 2, y + h / 2, x + w, y + h], fill=br)
    return f


def centre_square(bg, fg):
    def f(d, x, y, w, h):
        d.rectangle([x, y, x + w, y + h], fill=bg)
        s = h / 3
        d.rectangle([x + w / 2 - s / 2 * 1.2, y + h / 2 - s / 2, x + w / 2 + s / 2 * 1.2, y + h / 2 + s / 2], fill=fg)
    return f


def disc(bg, fg, cx=0.5, r=0.27):
    def f(d, x, y, w, h):
        d.rectangle([x, y, x + w, y + h], fill=bg)
        c, rr = (x + w * cx, y + h / 2), h * r
        d.ellipse([c[0] - rr, c[1] - rr, c[0] + rr, c[1] + rr], fill=fg)
    return f


def cross(bg, fg, k=0.2):
    def f(d, x, y, w, h):
        d.rectangle([x, y, x + w, y + h], fill=bg)
        t = h * k
        d.rectangle([x, y + h / 2 - t / 2, x + w, y + h / 2 + t / 2], fill=fg)
        d.rectangle([x + w / 2 - t / 2, y, x + w / 2 + t / 2, y + h], fill=fg)
    return f


def saltire(bg, fg, k=0.13):
    def f(d, x, y, w, h):
        d.rectangle([x, y, x + w, y + h], fill=bg)
        t = h * k
        for (a, b) in (((x, y), (x + w, y + h)), ((x, y + h), (x + w, y))):
            dx, dy = b[0] - a[0], b[1] - a[1]
            n = math.hypot(dx, dy); px, py = -dy / n * t, dx / n * t
            d.polygon([(a[0] + px, a[1] + py), (b[0] + px, b[1] + py), (b[0] - px, b[1] - py), (a[0] - px, a[1] - py)], fill=fg)
    return f


def checks(c1, c2, n=4):
    def f(d, x, y, w, h):
        for i in range(n):
            for j in range(n):
                d.rectangle([x + w * j / n, y + h * i / n, x + w * (j + 1) / n, y + h * (i + 1) / n], fill=c1 if (i + j) % 2 == 0 else c2)
    return f


def z_flag(d, x, y, w, h):
    c = (x + w / 2, y + h / 2)
    d.polygon([(x, y), (x + w, y), c], fill=Y)
    d.polygon([(x, y), (x, y + h), c], fill=K)
    d.polygon([(x + w, y), (x + w, y + h), c], fill=B)
    d.polygon([(x, y + h), (x + w, y + h), c], fill=R)


def y_flag(d, x, y, w, h):
    d.rectangle([x, y, x + w, y + h], fill=Y)
    n, step = 7, (w + h) / 7
    for i in range(-1, n + 1):
        if i % 2: continue
        a = x - h + i * step
        d.polygon([(a, y + h), (a + step, y + h), (a + step + h, y), (a + h, y)], fill=R)


def diagonal(c1, c2):
    def f(d, x, y, w, h):
        d.polygon([(x, y), (x + w, y), (x, y + h)], fill=c1)
        d.polygon([(x + w, y), (x + w, y + h), (x, y + h)], fill=c2)
    return f


def first_sub(d, x, y, w, h):
    d.rectangle([x, y, x + w, y + h], fill=B)
    m = h * 0.2
    d.polygon([(x + m * 0.9, y + m), (x + m * 0.9, y + h - m), (x + w - m * 2.6, y + h / 2)], fill=Y)


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
    if kind == 'triangle': return [(x, y), (x + w, y + h / 2), (x, y + h)]
    if kind == 'tri_up': return [(x + w / 2, y), (x + w, y + h), (x, y + h)]
    raise ValueError(kind)


def flag(design, kind='rect', ratio=4 / 3):
    return (design, kind, ratio)


F = {
    'A': flag(vstripes(W, B), 'swallow', 3 / 2), 'C': flag(hstripes(B, W, R, W, B)), 'H': flag(vstripes(W, R)),
    'I': flag(disc(Y, K)), 'L': flag(quarters(Y, K, K, Y)), 'M': flag(saltire(B, W)), 'N': flag(checks(B, W)),
    'P': flag(centre_square(B, W)), 'S': flag(centre_square(W, B)), 'U': flag(quarters(R, W, W, R)),
    'V': flag(saltire(W, R)), 'X': flag(cross(W, B)), 'Y': flag(y_flag), 'Z': flag(z_flag),
    'BLACK': flag(plain(K)), 'BLUE': flag(plain(B)), 'ORANGE': flag(plain(O)), 'RED': flag(plain(R)),
    'GREEN': flag(plain(G)), 'YELLOW': flag(plain(Y)), 'GREEN_WHITE': flag(diagonal(G, W)),
    'AP': flag(vstripes(R, W, R, W, R), 'pennant', 1.7), 'FIRST': flag(first_sub, 'triangle', 1.7),
    '1': flag(disc(W, R, 0.33, 0.2), 'pennant', 1.7), '2': flag(disc(B, W, 0.33, 0.2), 'pennant', 1.7),
    '3': flag(vstripes(R, W, B), 'pennant', 1.7),
    'PORT': flag(plain(R), 'rect', 3 / 2), 'STARBOARD': flag(plain(G), 'tri_up', 1.15),
    'MINUS': flag(minus, 'rect', 1.0), 'PLUS': flag(plus, 'rect', 1.0),
}


def draw_one(img, key, cx, cy, maxw, maxh):
    design, kind, ratio = F[key]
    w = min(maxw, maxh * ratio); h = w / ratio
    x, y = cx - w / 2, cy - h / 2
    layer = Image.new('RGBA', img.size, (0, 0, 0, 0))
    design(ImageDraw.Draw(layer), x, y, w, h)
    mask = Image.new('L', img.size, 0)
    poly = shape(kind, x, y, w, h)
    ImageDraw.Draw(mask).polygon(poly, fill=255)
    img.paste(layer, (0, 0), mask)
    ImageDraw.Draw(img).line(poly + [poly[0]], fill=LINE, width=OUT * S, joint='curve')


def render(keys):
    big = Image.new('RGBA', (SIZE * S, SIZE * S), (0, 0, 0, 0))
    m = 14 * S                                   # margin
    full = SIZE * S - 2 * m
    if len(keys) == 1:
        draw_one(big, keys[0], SIZE * S / 2, SIZE * S / 2, full, full)
    else:                                         # stacked: one over the other, the lower one may be a small shape
        gap = 16 * S
        hh = (full - gap) / 2
        draw_one(big, keys[0], SIZE * S / 2, m + hh / 2, full, hh)
        draw_one(big, keys[1], SIZE * S / 2, m + hh + gap + hh / 2, full, hh)
    return big.resize((SIZE, SIZE), Image.LANCZOS)


# in the order of the Announcements list: file name, signals (top first), announcement name
ICONS = [
    ('X_individual_recall.png', ['X'], 'X – Individual recall'),
    ('FIRST_SUBSTITUTE_general_recall.png', ['FIRST'], 'First substitute – General recall'),
    ('AP_postponed.png', ['AP'], 'AP – Postponed'),
    ('AP_over_A_postponed_no_more_racing_today.png', ['AP', 'A'], 'AP over A – Postponed, no more racing today'),
    ('S_shortened_course.png', ['S'], 'S – Shortened course'),
    ('C_change_of_course.png', ['C'], 'C – Change of course'),
    ('GREEN_no_penalty.png', ['GREEN'], 'Green – No penalty'),
    ('YELLOW_penalty.png', ['YELLOW'], 'Yellow – Penalty'),
    ('BLACK_disqualified.png', ['BLACK'], 'Black – Disqualified'),
    ('C_red_mark_moved_to_port.png', ['C', 'PORT'], 'C + red – Mark moved to port'),
    ('C_green_mark_moved_to_starboard.png', ['C', 'STARBOARD'], 'C + green – Mark moved to starboard'),
    ('C_minus_leg_shortened.png', ['C', 'MINUS'], 'C + minus – Next leg shortened'),
    ('C_plus_leg_lengthened.png', ['C', 'PLUS'], 'C + plus – Next leg lengthened'),
    ('AP_over_H_postponed_signals_ashore.png', ['AP', 'H'], 'AP over H – Postponed, signals ashore'),
    ('AP_over_1_postponed_1_hour.png', ['AP', '1'], 'AP over 1 – Postponed 1 hour'),
    ('AP_over_2_postponed_2_hours.png', ['AP', '2'], 'AP over 2 – Postponed 2 hours'),
    ('AP_over_3_postponed_3_hours.png', ['AP', '3'], 'AP over 3 – Postponed 3 hours'),
    ('N_over_H_abandoned_signals_ashore.png', ['N', 'H'], 'N over H – Abandoned, signals ashore'),
    ('N_over_A_abandoned_no_more_racing_today.png', ['N', 'A'], 'N over A – Abandoned, no more racing today'),
    ('P_preparatory.png', ['P'], 'P – Preparatory'),
    ('I_preparatory_round_the_ends.png', ['I'], 'I – Round the ends'),
    ('Z_preparatory_20_percent_penalty.png', ['Z'], 'Z – 20% penalty'),
    ('U_preparatory_u_flag.png', ['U'], 'U – U flag rule'),
    ('BLACK_preparatory_black_flag.png', ['BLACK'], 'Black – Black flag rule'),
    ('N_abandoned.png', ['N'], 'N – Abandoned'),
    ('M_mark_replaced.png', ['M'], 'M – Mark replaced'),
    ('L_come_within_hail.png', ['L'], 'L – Come within hail'),
    ('Y_wear_lifejackets.png', ['Y'], 'Y – Wear lifejackets'),
    ('A_ashore.png', ['A'], 'A – No more racing today'),
    ('H_ashore.png', ['H'], 'H – Signals ashore'),
    ('V_safety_monitor_channel.png', ['V'], 'V – Monitor safety channel'),
    ('ORANGE_start_line.png', ['ORANGE'], 'Orange – Start line'),
    ('BLUE_finish_line.png', ['BLUE'], 'Blue – Finish line'),
    ('RED_penalty_protest.png', ['RED'], 'Red – Penalty / protest'),
    ('GREEN_WHITE_no_penalty.png', ['GREEN_WHITE'], 'Green and white – No penalty'),
]


def sheet(path):
    cols, cell, lab = 7, 210, 40
    rows = (len(ICONS) + cols - 1) // cols
    img = Image.new('RGB', (cols * cell, rows * (cell + lab)), (200, 204, 210))
    font = None
    for p in ('/usr/share/fonts/opentype/inter/Inter-Medium.otf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'):
        if os.path.exists(p): font = ImageFont.truetype(p, 13); break
    d = ImageDraw.Draw(img)
    for i, (_, keys, label) in enumerate(ICONS):
        x, y = (i % cols) * cell, (i // cols) * (cell + lab)
        ic = render(keys).resize((cell - 30, cell - 30), Image.LANCZOS)
        img.paste(ic, (x + 15, y + 15), ic)
        for j, part in enumerate(label.split(' – ')):
            d.text((x + cell / 2, y + cell - 8 + j * 17), part, fill=(20, 20, 20), anchor='mt', font=font)
    img.save(path)


if __name__ == '__main__':
    args = [a for a in sys.argv[1:]]
    sheet_path = None
    if '--sheet' in args:
        i = args.index('--sheet'); sheet_path = args[i + 1]; del args[i:i + 2]
    out = args[0] if args else os.path.join(os.path.dirname(__file__), '..', 'server', 'fixtures', 'race-flags')
    os.makedirs(out, exist_ok=True)
    for name, keys, _ in ICONS:
        render(keys).save(os.path.join(out, name), optimize=True)
    if sheet_path: sheet(sheet_path)
