import json, sys, pikepdf, pymupdf
SRC, LAYOUT, OUTPDF, OUTPNG = sys.argv[1:5]
FORMS = {'/Fm5', '/Fm6', '/Fm180', '/Fm186', '/Fm220', '/Fm221', '/Fm222', '/Fm223'}
HL = {'/Sh2', '/Sh3', '/Sh7', '/Sh0', '/Sh1', '/Sh4', '/Sh5', '/Sh6', '/Sh9', '/Sh10', '/Sh11', '/Sh12'}
pdf = pikepdf.open(SRC); pg = pdf.pages[0]
ops = list(pikepdf.parse_content_stream(pg))
drop = set()
for i, (o, op) in enumerate(ops):
    if str(op) == 'Do' and str(o[0]) in FORMS: drop.add(i)
    if str(op) == 'sh' and str(o[0]) in HL:
        j = i
        while str(ops[j][1]) not in ('re', 'm'): j -= 1
        while str(ops[j - 1][1]) in ('c', 'l', 'm', 'v', 'y', 'h', 're'): j -= 1
        while str(ops[j][1]) != 'q': j -= 1
        depth, k = 0, j
        while True:
            s = str(ops[k][1])
            if s == 'q': depth += 1
            elif s == 'Q':
                depth -= 1
                if depth == 0: break
            k += 1
        drop.update(range(j, k + 1))
print('dropped ops', len(drop))
pg.Contents = pdf.make_stream(pikepdf.unparse_content_stream([x for i, x in enumerate(ops) if i not in drop]))
pdf.save(OUTPDF)
lay = json.load(open(LAYOUT))
doc = pymupdf.open(OUTPDF); p = doc[0]
HLROWS = [(377.8, 442.5), (377.8, 468.9), (377.8, 275.4), (467.5, 249.1), (467.5, 640.4), (377.8, 640.4), (557.2, 640.4), (646.9, 640.4)]
def apply(art):
    p.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=art, text=pymupdf.PDF_REDACT_TEXT_NONE if art != pymupdf.PDF_REDACT_LINE_ART_NONE else pymupdf.PDF_REDACT_TEXT_REMOVE)
# 1) highlighted rows: the waves drawn over the highlight
for x, y in HLROWS: p.add_redact_annot(pymupdf.Rect(x - 0.5, y + 1.8, x + 79.7, y + 26.9))
apply(pymupdf.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED)
# 2) flags: everything that touches the flag
for s in lay['slots']:
    if s['flag']:
        x, y, w, h = s['flag']; p.add_redact_annot(pymupdf.Rect(x - 2.5, y - 2.5, x + w + 2.5, y + h + 2.5))
apply(pymupdf.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED)
# 3) text, except the 1ST / 2ND badges
for b in p.get_text('dict')['blocks']:
    for l in b.get('lines', []):
        for sp in l['spans']:
            t = sp['text'].strip()
            if not t: continue
            if (t in ('ST', 'ND') and sp['size'] < 7) or (t in ('1', '2') and abs(sp['size'] - 11.2) < 0.1 and any(abs(sp['bbox'][2] - o['bbox'][0]) < 0.5 for o in l['spans'] if o is not sp and o['text'] in ('ST', 'ND'))):
                continue
            p.add_redact_annot(pymupdf.Rect(sp['bbox']))
apply(pymupdf.PDF_REDACT_LINE_ART_NONE)
doc.save(OUTPDF.replace('.pdf', '-red.pdf'))
pix = p.get_pixmap(matrix=pymupdf.Matrix(1, 1), alpha=True)
pix.save(OUTPNG); print(pix.width, pix.height)
print('text left:', [s['text'] for b in p.get_text('dict')['blocks'] for l in b.get('lines', []) for s in l['spans'] if s['text'].strip()][:80])
