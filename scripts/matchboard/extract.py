import json, sys, pymupdf
SRC = sys.argv[1]; OUT = sys.argv[2]
doc = pymupdf.open(SRC); p = doc[0]
spans = []
for b in p.get_text('dict')['blocks']:
    for l in b.get('lines', []):
        for s in l['spans']:
            if s['text'].strip(): spans.append(s)
dr = p.get_drawings()
boxes = [d['rect'] for d in dr if d['type'] == 'f' and 60 <= d['rect'].width <= 120 and d['rect'].height >= 40]
def box_of(cx, cy):
    c = [r for r in boxes if r.x0 <= cx <= r.x1 and r.y0 <= cy <= r.y1]
    return min(c, key=lambda r: r.width * r.height) if c else None
flags = [d['rect'] for d in dr if d['type'] == 'f' and 15.5 < d['rect'].width < 17 and 10 < d['rect'].height < 11.5]
def flag_left(s):
    x0, y0, x1, y1 = s['bbox']
    for f in flags:
        if abs(f.x1 + 5.1 - x0) < 2 and f.y0 > y0 - 2 and f.y1 < y1 + 2: return f
    return None
hex_ = lambda c: '#%06x' % c
def short_font(f): return 'grotesk' if 'Grotesk' in f else 'sans'
slots, texts, keep = [], [], []
used = set()
# superscripts 1ST/2ND stay in the artwork
for i, s in enumerate(spans):
    if s['text'] in ('ST', 'ND') and s['size'] < 7:
        used.add(i)
        for j, t in enumerate(spans):
            if t['text'] in ('1', '2') and abs(t['bbox'][2] - s['bbox'][0]) < 0.5 and abs(t['origin'][1] - s['origin'][1]) < 5: used.add(j)
for i, s in enumerate(spans):
    if i in used: continue
    x0, y0, x1, y1 = s['bbox']; cy = (y0 + y1) / 2
    is_slot = (abs(s['size'] - 13.0) < 0.2 and s['text'] != 'DRAW*') or (abs(s['size'] - 14.9) < 0.2 and x0 > 1590 and y0 > 520)
    if is_slot:
        bx = box_of((x0 + x1) / 2, cy)
        f = flag_left(s)
        if not f and __import__('re').fullmatch(r'[A-Z]{3}', s['text']): f = pymupdf.Rect(x0 - 21.4, cy - 5.45, x0 - 5.1, cy + 5.45)
        slots.append({'x': round(bx.x0, 1), 'w': round(bx.width, 1), 'cy': round(cy, 1), 'baseline': round(s['origin'][1], 1), 'size': round(s['size'], 1),
                      'team': s['text'] if f else None, 'text': '' if f else s['text'], 'flag': [round(f.x0, 1), round(f.y0, 1), round(f.width, 1), round(f.height, 1)] if f else None,
                      'codeX': round(x0, 1)})
        used.add(i)
# merge remaining spans on one line into text fields
rest = [s for i, s in enumerate(spans) if i not in used]
rest.sort(key=lambda s: (round(s['origin'][1]), s['bbox'][0]))
groups = []
for s in rest:
    g = groups[-1] if groups else None
    if g and abs(g[-1]['origin'][1] - s['origin'][1]) < 1 and -1 < s["bbox"][0] - g[-1]["bbox"][2] < 2: g.append(s)
    else: groups.append([s])
for g in groups:
    x0 = g[0]['bbox'][0]; x1 = g[-1]['bbox'][2]
    main = max(g, key=lambda s: len(s['text']))
    texts.append({'text': ''.join(s['text'] for s in g), 'x0': round(x0, 1), 'x1': round(x1, 1), 'baseline': round(main['origin'][1], 1), 'size': round(main['size'], 1),
                  'color': hex_(main['color']), 'font': short_font(main['font'])})
json.dump({'slots': slots, 'texts': texts}, open(OUT, 'w'), indent=1)
print(len(slots), 'slots', sum(1 for s in slots if s['team']), 'teams', len(texts), 'texts')
