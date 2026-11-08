"""Drop every path painted entirely inside one of the given rectangles (top-left origin, page height 1080)."""
import json, sys, pikepdf
SRC, LAYOUT, OUT = sys.argv[1:4]
lay = json.load(open(LAYOUT))
rects = [(x - 4, y - 4, x + w + 4, y + h + 4) for s in lay['slots'] if s['flag'] for x, y, w, h in [s['flag']]]
pdf = pikepdf.open(SRC); pg = pdf.pages[0]
ops = list(pikepdf.parse_content_stream(pg))
def mul(a, b): return [a[0]*b[0]+a[1]*b[2], a[0]*b[1]+a[1]*b[3], a[2]*b[0]+a[3]*b[2], a[2]*b[1]+a[3]*b[3], a[4]*b[0]+a[5]*b[2]+b[4], a[4]*b[1]+a[5]*b[3]+b[5]]
ctm = [1, 0, 0, 1, 0, 0]; st = []; path = []; pts = []; drop = set()
PAINT = {'f', 'F', 'f*', 'S', 's', 'B', 'B*', 'b', 'b*'}
for i, (o, op) in enumerate(ops):
    s = str(op)
    if s == 'q': st.append(ctm)
    elif s == 'Q': ctm = st.pop()
    elif s == 'cm': ctm = mul([float(v) for v in o], ctm)
    elif s in ('m', 'l', 'c', 'v', 'y', 're', 'h'):
        path.append(i); v = [float(x) for x in o]
        if s == 're': v = [v[0], v[1], v[0] + v[2], v[1] + v[3]]
        for k in range(0, len(v), 2):
            x, y = v[k], v[k + 1]
            pts.append((x * ctm[0] + y * ctm[2] + ctm[4], 1080 - (x * ctm[1] + y * ctm[3] + ctm[5])))
    elif s in PAINT or s == 'n':
        if s in PAINT and pts:
            X = [p[0] for p in pts]; Y = [p[1] for p in pts]
            if any(r[0] <= min(X) and max(X) <= r[2] and r[1] <= min(Y) and max(Y) <= r[3] for r in rects):
                drop.update(path); drop.add(i)
        path = []; pts = []
print('dropped paths ops', len(drop))
pg.Contents = pdf.make_stream(pikepdf.unparse_content_stream([x for i, x in enumerate(ops) if i not in drop]))
pdf.save(OUT)
