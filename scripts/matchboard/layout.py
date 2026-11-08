"""raw.json (from extract.py) → the matchboard layout the app draws: ids, sections, groups, rows."""
import json, re, sys
raw = json.load(open(sys.argv[1]))
texts = sorted(raw['texts'], key=lambda t: (t['baseline'], t['x0']))
slug = lambda s: re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')
out_texts = []
def add_text(t, tid, label, section, align):
    x = t['x0'] if align == 'left' else t['x1'] if align == 'right' else round((t['x0'] + t['x1']) / 2, 1)
    # weights read off the artwork: dates medium, everything else semibold
    d = {'id': tid, 'label': label, 'section': section, 'text': t['text'], 'x': x, 'baseline': t['baseline'], 'size': t['size'], 'color': t['color'], 'align': align,
         'weight': 500 if tid.endswith('-date') else 600}
    out_texts.append(d); return d
used = set()
# global
for t in texts:
    if t['text'] in ('Qualifying Series', 'Final Series'): add_text(t, slug(t['text']), t['text'] + ' title', 'titles', 'center'); used.add(id(t))
    if t['text'] == 'DRAW*': add_text(t, 'draw-note', 'Draw label', 'titles', 'center'); used.add(id(t))
# regions (QS)
regions = []
for t in texts:
    if abs(t['size'] - 18.6) < 0.2:
        rid = 'region-' + slug(t['text'])
        add_text(t, rid + '-name', 'Name', rid, 'left'); used.add(id(t))
        date = next(d for d in texts if abs(d['baseline'] - t['baseline']) < 0.5 and d is not t)
        add_text(date, rid + '-date', 'Dates & place', rid, 'right'); used.add(id(date))
        regions.append({'id': rid, 'title': t['text'], 'baseline': t['baseline']})
# stages (final series)
stages = []
for t in texts:
    if abs(t['size'] - 14.9) < 0.2 and t['baseline'] < 210:
        sid = 'stage-' + slug(t['text'])
        add_text(t, sid + '-name', 'Name', sid, 'center'); used.add(id(t))
        cx = (t['x0'] + t['x1']) / 2
        date = min((d for d in texts if 220 < d['baseline'] < 226), key=lambda d: abs((d['x0'] + d['x1']) / 2 - cx))
        add_text(date, sid + '-date', 'Dates', sid, 'center'); used.add(id(date))
        stages.append({'id': sid, 'title': t['text'], 'cx': cx})
# groups: label texts above boxes of slots
slots = raw['slots']
groups = []
for t in texts:
    if id(t) in used: continue
    cx = (t['x0'] + t['x1']) / 2
    mine = [s for s in slots if s['x'] <= cx <= s['x'] + s['w'] and s['baseline'] > t['baseline']]
    if not mine: print('no slots for', t['text']); continue
    first = min(s['baseline'] for s in mine)
    if first - t['baseline'] > 45: print('far', t['text']); continue
    groups.append({'t': t, 'cx': cx})
for s in slots:
    cands = [g for g in groups if g['cx'] >= s['x'] and g['cx'] <= s['x'] + s['w'] and g['t']['baseline'] < s['baseline']]
    s['g'] = max(cands, key=lambda g: g['t']['baseline'])
out_groups, out_slots = [], []
for g in groups:
    t = g['t']; gid = slug(t['text'])
    if g['cx'] < 760:
        section = max((r for r in regions if r['baseline'] < t['baseline']), key=lambda r: r['baseline'])['id']
    else:
        section = min(stages, key=lambda st: abs(st['cx'] - g['cx']))['id']
    add_text(t, gid + '-label', 'Label', section, 'center')
    mine = sorted([s for s in slots if s['g'] is g], key=lambda s: s['baseline'])
    pitch = round(mine[1]['cy'] - mine[0]['cy'], 1) if len(mine) > 1 else 26.4
    ids = []
    for i, s in enumerate(mine):
        sid = f'{gid}-{i + 1}'; ids.append(sid)
        out_slots.append({'id': sid, 'x': s['x'], 'y': round(s['cy'] - pitch / 2, 1), 'w': s['w'], 'h': pitch, 'cy': s['cy'], 'baseline': s['baseline'], 'size': s['size'],
                          'team': s['team'], 'text': s['text']})
    out_groups.append({'id': gid, 'section': section, 'labelId': gid + '-label', 'slots': ids})
sections = [{'id': 'titles', 'kind': 'titles', 'title': 'Titles'}] + \
    [{'id': r['id'], 'kind': 'qualifying', 'title': r['title']} for r in regions] + \
    [{'id': s['id'], 'kind': 'final', 'title': s['title']} for s in sorted(stages, key=lambda s: s['cx'])]
order = {s['id']: i for i, s in enumerate(sections)}
out_groups.sort(key=lambda g: (order[g['section']], g['id']))
json.dump({'width': 1920, 'height': 1080, 'sections': sections, 'texts': out_texts, 'groups': out_groups, 'slots': out_slots}, open(sys.argv[2], 'w'), indent=1)
print(len(sections), 'sections', len(out_texts), 'texts', len(out_groups), 'groups', len(out_slots), 'slots')
print([ (g['id'], g['section'], len(g['slots'])) for g in out_groups])
