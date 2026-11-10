import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { GtzipService, loadPackage, resourcePart, savePackage } from '../src/services/gtzip/gtzip.js';
import { allNames, animationsOf, duplicate, elements, fitLayer, groupElements, GtNode, insertElements, makeElement, moveElements, parseXml, pasteElements, remove, renameElement, serializeXml, setVec, storyboards, syncLayerSizes, ungroup, uniqueName, vec } from '../src/services/gtzip/model.js';
import { repeatGroups, setCount } from '../src/services/gtzip/params.js';
import { zipStore } from '../src/services/xlsx.js';
import { setup } from './helpers.js';

// 1×1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const FLAG = 'aaaaaaaa-0000-0000-0000-000000000001\\FLAG_BRN.png';
const PART = 'bbbbbbbb-0000-0000-0000-000000000001';

const DOC = `<?xml version="1.0" encoding="utf-16"?>
<Composition Width="1920" Height="1080">
  <Layer Name="BAR 1" Dimensions="1920,1080,0" Location="0,25,0">
    <Layer.Composition>
      <Composition Width="1920" Height="1080">
        <Image Name="Image1" Dimensions="930,60,0" Location="493.5,527,0">
          <Image.Bitmap>
            <Bitmap Source="${FLAG}" />
          </Image.Bitmap>
        </Image>
        <TextBlock Name="RACE 1" Dimensions="95,38,0" Location="1291,535,0" Text="RACE&#xD;&#xA;1" FontFamily="General Sans" FontSize="25">
          <TextBlock.Fill>
            <Brush Color="#FFFFFFFF" />
          </TextBlock.Fill>
        </TextBlock>
        <Image Name="FLAG 2" Dimensions="48,32,0" Location="1046,540,0">
          <Image.Mask>
            <Mask Object="MASK" />
          </Image.Mask>
        </Image>
        <Image Name="FLAG 1" Dimensions="48,32,0" Location="988,540,0" />
        <Rectangle Name="MASK" Dimensions="48,32,0" Location="988,540,0" Radius="4,4" />
      </Composition>
    </Layer.Composition>
  </Layer>
  <TextBlock Name="TITLE" Text="DAY 1" />
  <Storyboard>
    <Storyboard.Animations>
      <Fly Object="BAR 1" Delay="0.15" Duration="0.65" Interpolation="CubicEasingInOut" />
      <Fade Object="TITLE" />
    </Storyboard.Animations>
  </Storyboard>
  <Storyboard Type="DataChangeIn" DataName="FLAG 1.Source">
    <Storyboard.Animations>
      <Fade Object="FLAG 1" Duration="0.3" />
    </Storyboard.Animations>
  </Storyboard>
</Composition>`.replace(/\n/g, '\r\n');

function sampleGtzip(): Buffer {
  const res = `<resources><resource filename="${FLAG}"><source guid="${PART}">${FLAG}</source></resource></resources>`;
  const ct = '﻿<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="text/xml" /><Default Extension="png" ContentType="image/png" />'
    + `<Override PartName="/${PART}" ContentType="application/octet-stream" /></Types>`;
  return zipStore([[PART, PNG], ['resources.xml', Buffer.from(res)], ['document.xml', Buffer.from(DOC)], ['thumbnail.png', PNG], ['[Content_Types].xml', Buffer.from(ct)]]);
}

describe('gtzip model', () => {
  it('reads and writes GT Title Designer XML byte for byte', () => {
    const { decl, root } = parseXml(DOC);
    expect(decl + '\r\n' + serializeXml(root, true)).toBe(DOC);
    const buf = sampleGtzip();
    expect(savePackage(loadPackage(buf)).equals(buf)).toBe(true);
  });

  it('round-trips real GT files when GTZIP_SAMPLES points at a folder of them', () => {
    const dir = process.env.GTZIP_SAMPLES;
    if (!dir || !fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.gtzip'))) {
      const buf = fs.readFileSync(path.join(dir, f));
      const p = loadPackage(buf), back = loadPackage(savePackage(p));
      for (const n of ['document.xml', 'resources.xml', '[Content_Types].xml']) expect(back.files.get(n)!.equals(p.files.get(n)!), `${f} ${n}`).toBe(true);
    }
  });

  it('duplicates a row with renumbered names, offsets, animations and DataChange storyboards', () => {
    const { root } = parseXml(DOC);
    const bar = elements(root).find((e) => e.node.attrs.Name === 'BAR 1')!;
    const { root: r, added } = duplicate(root, [bar.path], { count: 2, dx: 0, dy: 70, delayStep: 0.05 });
    const names = [...allNames(r)];
    expect(names).toEqual(expect.arrayContaining(['BAR 2', 'BAR 3', 'Image2', 'Image3', 'RACE 2', 'RACE 3', 'FLAG 3', 'FLAG 4', 'FLAG 5', 'FLAG 6', 'MASK1', 'MASK2']));
    expect(added).toHaveLength(2);
    const bar3 = elements(r).find((e) => e.node.attrs.Name === 'BAR 3')!.node;
    expect(bar3.attrs.Location).toBe('0,165,0');
    // the copy's flag is masked by the copy's mask
    const masked = elements(r).find((e) => e.node.attrs.Name === 'FLAG 4')!.node;
    expect(masked.children[0].children[0].attrs.Object).toBe('MASK1');
    const sbs = storyboards(r);
    const fly = sbs[0].animations.filter((a) => a.tag === 'Fly').map((a) => [a.attrs.Object, a.attrs.Delay]);
    expect(fly).toEqual([['BAR 1', '0.15'], ['BAR 2', '0.2'], ['BAR 3', '0.25']]);
    expect(sbs.map((s) => s.node.attrs.DataName).filter(Boolean)).toEqual(['FLAG 1.Source', 'FLAG 3.Source', 'FLAG 5.Source']);
    // the original is untouched
    expect(allNames(root).has('BAR 2')).toBe(false);
  });

  it('renames with a pattern and removes with references', () => {
    const { root } = parseXml(DOC);
    const flag1 = elements(root).find((e) => e.node.attrs.Name === 'FLAG 1')!;
    const { root: r } = duplicate(root, [flag1.path], { count: 1, dx: 58, dy: 0, find: 'FLAG 1', replace: 'NATION {n}', start: 7 });
    expect(allNames(r).has('NATION 7')).toBe(true);
    renameElement(r, 'TITLE', 'HEADLINE');
    expect(storyboards(r)[0].animations.some((a) => a.attrs.Object === 'HEADLINE')).toBe(true);
    expect(() => renameElement(r, 'HEADLINE', 'BAR 1')).toThrow();
    const mask = elements(r).find((e) => e.node.attrs.Name === 'MASK')!;
    const gone = remove(r, [mask.path, elements(r).find((e) => e.node.attrs.Name === 'FLAG 1')!.path]);
    expect(allNames(gone).has('MASK')).toBe(false);
    expect(elements(gone).find((e) => e.node.attrs.Name === 'FLAG 2')!.node.children).toHaveLength(0);
    expect(storyboards(gone).some((s) => s.node.attrs.DataName === 'FLAG 1.Source')).toBe(false);
  });
});

describe('gtzip generator API', () => {
  async function app() {
    const s = setup();
    const a = await buildApp({ db: s.db, assetsDir: s.ctx.assetsDir, sync: s.sync });
    return { ...s, app: a };
  }
  const upload = (file: string, buf: Buffer, url: string) => {
    const boundary = '----gt' + Math.random().toString(16).slice(2);
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file}"\r\nContent-Type: application/octet-stream\r\n\r\n`), buf, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    return { method: 'POST' as const, url, payload: body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
  };

  it('adds every title of a .zip set as a template', async () => {
    const { app: a } = await app();
    const pack = zipStore([['set/Day_schedule_3_races.gtzip', sampleGtzip()], ['set/Welcome.gtzip', sampleGtzip()], ['set/readme.txt', Buffer.from('x')], ['set/broken.gtzip', Buffer.from('nope')]]);
    const r = await a.inject(upload('Finals.zip', pack, '/api/gtzip/templates/pack'));
    expect(r.statusCode).toBe(200);
    expect(r.json().added.map((t: any) => t.name)).toEqual(['Day_schedule_3_races', 'Welcome']);
    expect(r.json().added[0].scene).toBe('day-schedule');
    expect(r.json().skipped).toEqual(['broken.gtzip']);
  });

  it('generates new single files and never overwrites', async () => {
    const { app: a, ctx } = await app();
    const tplBuf = sampleGtzip();
    const up = await a.inject(upload('day_schedule.gtzip', tplBuf, '/api/gtzip/templates'));
    expect(up.statusCode).toBe(200);
    const tpl = up.json();
    expect(tpl.fields).toBe(5);
    const t = (await a.inject({ url: `/api/gtzip/templates/${tpl.id}` })).json();
    expect(t.images[FLAG]).toEqual({ embedded: true, name: 'FLAG_BRN.png' });

    // edit: four bars, a new picture on the copy
    const bar = elements(t.doc).find((e) => e.node.attrs.Name === 'BAR 1')!;
    const { root } = duplicate(t.doc, [bar.path], { count: 3, dx: 0, dy: 70 });
    const pic = (await a.inject(upload('logo.png', PNG, '/api/gtzip/images'))).json();
    expect(pic.source).toMatch(/^upload:[0-9a-f]{12}-logo\.png$/);
    const img4 = elements(root).find((e) => e.node.attrs.Name === 'Image4')!.node as GtNode;
    img4.children[0].children[0].attrs.Source = pic.source;

    const gen = await a.inject({ method: 'POST', url: '/api/gtzip/generate', payload: { templateId: tpl.id, fileName: 'Day schedule 4 races', doc: root } });
    expect(gen.statusCode).toBe(200);
    const out = gen.json();
    expect(out.file).toBe('Day schedule 4 races.gtzip');
    const file = path.join(ctx.assetsDir, 'gtzip', out.file);
    const p = loadPackage(fs.readFileSync(file));
    expect(allNames(p.doc).has('Bar 4')).toBe(true);
    const src4 = elements(p.doc).find((e) => e.node.attrs.Name === 'Image4')!.node.children[0].children[0].attrs.Source;
    expect(src4).toMatch(/^[0-9a-f-]{36}\\logo\.png$/);
    expect(resourcePart(p, src4)).toBeTruthy();
    expect(p.res.children).toHaveLength(2);
    expect(p.ct.children.filter((c) => c.tag === 'Override')).toHaveLength(2);
    const before = fs.readFileSync(file);

    // same name again → 409 with a suggestion, file untouched
    const again = await a.inject({ method: 'POST', url: '/api/gtzip/generate', payload: { templateId: tpl.id, fileName: 'day schedule 4 RACES.gtzip', doc: t.doc } });
    expect(again.statusCode).toBe(409);
    expect(again.json().details.suggestion).toBe('day schedule 4 RACES (2)');
    expect(fs.readFileSync(file).equals(before)).toBe(true);

    // the template file is never modified
    const stored = (await a.inject({ url: `/api/gtzip/templates/${tpl.id}/file` })).rawPayload;
    expect(stored.equals(tplBuf)).toBe(true);

    const list = (await a.inject({ url: '/api/gtzip' })).json();
    expect(list.outputs.map((o: any) => o.name)).toEqual(['Day schedule 4 races']);
    expect(list.outputs[0].templateId).toBe(tpl.id);
    // a generated file can become a template of its own
    const t2 = await a.inject({ method: 'POST', url: '/api/gtzip/outputs/Day schedule 4 races/to-template' });
    expect(t2.json().elements).toBe(elements(p.doc).length);
  });

  it('rejects files that are not GT titles', async () => {
    const { app: a } = await app();
    expect((await a.inject(upload('x.gtzip', Buffer.from('nope'), '/api/gtzip/templates'))).statusCode).toBe(400);
    expect((await a.inject(upload('x.gtzip', zipStore([['a.txt', Buffer.from('x')]]), '/api/gtzip/templates'))).statusCode).toBe(400);
  });

  it('renders a thumbnail', async () => {
    const s = setup();
    const svc = new GtzipService(s.ctx);
    const t = svc.addTemplate(sampleGtzip(), 't.gtzip');
    const png = await svc.renderDoc(t.id, svc.template(t.id).doc);
    if (png) expect(png.subarray(1, 4).toString()).toBe('PNG');
  });
});

describe('gtzip rename pattern', () => {
  it('matches any case and keeps all-caps names all-caps', () => {
    const { root } = parseXml(`<Composition><Image Name="HelmBG" /><Layer Name="HELM" Dimensions="10,10,0" /><Storyboard><Storyboard.Animations><Expand Object="HELM" /></Storyboard.Animations></Storyboard></Composition>`);
    const { root: r } = duplicate(root, [[0], [1]], { count: 1, dx: 0, dy: 0, find: 'helm', replace: 'Sailor{n}', start: 10 });
    expect([...allNames(r)]).toEqual(['HelmBG', 'Sailor10BG', 'HELM', 'SAILOR10']);
    expect(storyboards(r)[0].animations.map((a) => a.attrs.Object)).toEqual(['HELM', 'SAILOR10']);
  });
});

describe('gtzip scenes', () => {
  it('recognises scenes from file names and saves variants as templates', async () => {
    const s = setup();
    const svc = new GtzipService(s.ctx);
    const t = svc.addTemplate(sampleGtzip(), 'day_schedule_2_rows_NO_TIME.gtzip');
    expect([t.scene, t.variant]).toEqual(['day-schedule', '2-races-no-time']);
    const bar = elements(svc.template(t.id).doc).find((e) => e.node.attrs.Name === 'BAR 1')!;
    const { root } = duplicate(svc.template(t.id).doc, [bar.path], { count: 2, dx: 0, dy: 70 });
    const v = await svc.saveAsTemplate({ templateId: t.id, name: 'Day schedule – 3 races', doc: root, scene: 'day-schedule', variant: '3-races' });
    expect([v.scene, v.variant, v.name]).toEqual(['day-schedule', '3-races', 'Day schedule – 3 races']);
    expect(allNames(svc.template(v.id).doc).has('Bar 3')).toBe(true);
    expect(allNames(svc.template(t.id).doc).has('BAR 3')).toBe(false);
    expect(svc.updateTemplate(v.id, { scene: 'team-lineup', variant: 'nope' }).variant).toBe('8-sailors');
    expect(() => svc.updateTemplate(v.id, { scene: 'nope' })).toThrow();
  });
});

describe('gtzip part counts', () => {
  const layer = (name: string, y: number, inner: string, extra = '') =>
    `<Layer Name="${name}" Dimensions="1920,1080,0" Location="0,${y},0"${extra}><Layer.Composition><Composition Width="1920" Height="1080">${inner}</Composition></Layer.Composition></Layer>`;
  const row = (n: number) => layer(`BAR ${n}`, 75 * (n - 1), `<Rectangle Name="ROWBG ${n}" Dimensions="800,60,0" Location="560,400,0" /><TextBlock Name="POSITION ${n}" Dimensions="40,40,0" Location="570,410,0" Text="${n}" /><TextBlock Name="RACE ${n}" Dimensions="120,40,0" Location="1200,410,0" Text="RACE ${n}" />`);
  const doc = (body: string, anims = '') => parseXml(`<?xml version="1.0" encoding="utf-16"?><Composition Width="1920" Height="1080">${body}<Storyboard><Storyboard.Animations>${anims}</Storyboard.Animations></Storyboard></Composition>`).root;
  const named = (root: GtNode, name: string) => elements(root).find((e) => e.node.attrs.Name === name)?.node;
  const at = (root: GtNode, name: string) => { const e = elements(root).find((x) => x.node.attrs.Name === name)!; const [x, y] = (e.node.attrs.Location ?? '0,0').split(',').map(Number); return [e.origin[0] + x, e.origin[1] + y]; };
  const schedule = () => doc(
    `<Image Name="PANEL" Dimensions="900,400,0" Location="510,250,0"><Image.Bitmap><Bitmap Source="${FLAG}" /></Image.Bitmap></Image><TextBlock Name="TITLE" Dimensions="600,60,0" Location="660,300,0" Text="DAY 1" />`
      + row(1) + row(2) + row(3) + '<Rectangle Name="SPONSORS" Dimensions="900,60,0" Location="510,700,0" />',
    '<Fly Object="BAR 1" Delay="0.2" /><Fly Object="BAR 2" Delay="0.3" /><Fly Object="BAR 3" Delay="0.4" />');

  it('finds numbered rows and adds one below with the next numbers, moving what comes after and growing the panel', () => {
    const root = schedule();
    const [g] = repeatGroups(root);
    expect(g.count).toBe(3);
    expect(g.step).toEqual([0, 75]);
    const r = setCount(root, g.id, 4, { shiftAfter: true, stretch: true });
    const bar4 = named(r.root, 'BAR 4')!;
    expect(bar4.attrs.Location).toBe('0,225,0');
    expect(named(r.root, 'POSITION 4')!.attrs.Text).toBe('4');
    expect(named(r.root, 'RACE 4')!.attrs.Text).toBe('RACE 4');
    expect(named(r.root, 'SPONSORS')!.attrs.Location).toBe('510,775,0');
    expect(named(r.root, 'PANEL')!.attrs.Dimensions).toBe('900,475,0');
    expect(named(r.root, 'TITLE')!.attrs.Location).toBe('660,300,0');
    // the copy's entry follows the stagger of the rows
    expect(animationsOf(storyboards(r.root)[0].node).find((a) => a.attrs.Object === 'BAR 4')!.attrs.Delay).toBe('0.5');
    // the panel picture repeats the band under the last row instead of being squashed
    expect(r.bands).toHaveLength(1);
    expect(r.bands[0]).toMatchObject({ name: 'PANEL', axis: 1, op: 'insert' });
    expect(r.bands[0].to - r.bands[0].from).toBeCloseTo(75 / 400, 5);
    // and back
    const back = setCount(r.root, g.id, 2, { shiftAfter: true, stretch: true, center: true });
    expect(repeatGroups(back.root)[0].count).toBe(2);
    expect(named(back.root, 'BAR 3')).toBeUndefined();
    expect(named(back.root, 'SPONSORS')!.attrs.Location).toBe('510,700,0');
  });

  it('keeps the animations when rows go and fits them to the new number of rows', () => {
    const anims = '<Reveal Object="PANEL" Duration="0.8" Direction="Top" /><Fly Object="BAR 1" Delay="0.2" /><Fly Object="BAR 2" Delay="0.3" /><Fly Object="BAR 3" Delay="0.4" /><Fade Object="SPONSORS" Delay="0.6" />';
    const root = doc(`<Image Name="PANEL" Dimensions="900,400,0" Location="510,250,0"><Image.Bitmap><Bitmap Source="${FLAG}" /></Image.Bitmap></Image>` + row(1) + row(2) + row(3) + '<Rectangle Name="SPONSORS" Dimensions="900,60,0" Location="510,700,0" />', anims);
    const [g] = repeatGroups(root);
    const delays = (r: GtNode) => Object.fromEntries(animationsOf(storyboards(r)[0].node).map((a) => [a.attrs.Object, Number(a.attrs.Delay ?? 0)]));
    const less = setCount(root, g.id, 2, { shiftAfter: true, stretch: true });
    // removing a row used to drop every animation of the title
    expect(delays(less.root)).toEqual({ PANEL: 0, 'BAR 1': 0.2, 'BAR 2': 0.3, SPONSORS: 0.5 });
    const panel = animationsOf(storyboards(less.root)[0].node).find((a) => a.attrs.Object === 'PANEL')!;
    expect(Number(panel.attrs.Duration)).toBeCloseTo(0.8 * 325 / 400, 2);
    const more = setCount(root, g.id, 5, { shiftAfter: true, stretch: true });
    expect(delays(more.root)).toMatchObject({ 'BAR 4': 0.5, 'BAR 5': 0.6, SPONSORS: 0.8 });
  });

  it('treats hidden rows at the end as spares', () => {
    const root = doc(row(1) + row(2) + layer('BAR 3', 150, '<Rectangle Name="ROWBG 3" Dimensions="800,60,0" Location="560,400,0" /><TextBlock Name="POSITION 3" Dimensions="40,40,0" Location="570,410,0" Text="3" /><TextBlock Name="RACE 3" Dimensions="120,40,0" Location="1200,410,0" Text="RACE 3" />', ' Visible="False"'));
    const [g] = repeatGroups(root);
    expect([g.count, g.spares]).toEqual([2, 1]);
    const r = setCount(root, g.id, 3);
    expect(named(r.root, 'BAR 3')!.attrs.Visible).toBeUndefined();
    expect(named(r.root, 'BAR 3')!.attrs.Location).toBe('0,150,0');
  });

  it('fills the empty cell of a team grid and hides the placeholder there', () => {
    const team = (code: string, x: number, y: number) => layer(code, 0, `<Image Name="${code} BG" Dimensions="800,380,0" Location="${x},${y},0" /><TextBlock Name="RANK ${code}" Dimensions="100,50,0" Location="${x + 20},${y + 20},0" Text="1" /><TextBlock Name="Country${code}" Dimensions="300,50,0" Location="${x + 20},${y + 100},0" Text="X" />`);
    const root = doc(team('OMA', 1000, 100) + team('KAZ', 100, 100) + team('UAE', 100, 550) + layer('Photo', 0, '<Image Name="PHOTO OMA" Dimensions="300,380,0" Location="1500,100,0" />')
      + '<Image Name="EMPTY" Dimensions="800,380,0" Location="1000,550,0" />');
    const [g] = repeatGroups(root);
    expect(g.members.map((m) => m.label)).toEqual(['OMA', 'KAZ', 'UAE']);
    expect(g.members[0].paths).toHaveLength(2); // its photo layer goes with it
    const r = setCount(root, g.id, 4);
    expect(repeatGroups(r.root)[0].count).toBe(4);
    expect(at(r.root, 'TEAMD BG')).toEqual([1000, 550]);
    expect(named(r.root, 'RANK TEAMD')).toBeDefined();
    expect(at(r.root, 'PHOTO TEAMD')).toEqual([1500, 550]);
    expect(named(r.root, 'EMPTY')!.attrs.Visible).toBe('False');
  });

  it('keeps a part’s photo layer with its loose elements (HelmBG, HelmNAME + layer HELM)', () => {
    const card = (p: string, x: number) => `<Image Name="${p}BG" Dimensions="200,130,0" Location="${x},300,0" /><TextBlock Name="${p}NAME" Dimensions="200,25,0" Location="${x},430,0" Text="Name" /><TextBlock Name="${p}NUMBER" Dimensions="60,50,0" Location="${x + 130},300,0" Text="1" />`;
    const photo = (p: string, x: number) => `<Layer Name="${p.toUpperCase()}" Dimensions="200,170,0" Location="${x},290,0"><Layer.Composition><Composition Width="200" Height="170"><Image Name="${p}PHOTO" Dimensions="340,340,0" Location="-100,5,0" /></Composition></Layer.Composition></Layer>`;
    const root = doc(card('Helm', 100) + card('Grinder', 400) + card('Pit', 700) + photo('Helm', 100) + photo('Grinder', 400) + photo('Pit', 700));
    const [g] = repeatGroups(root);
    expect(g.members.map((m) => m.paths.length)).toEqual([4, 4, 4]);
    const less = setCount(root, g.id, 2);
    expect(named(less.root, 'PIT')).toBeUndefined();
    expect(named(less.root, 'PitBG')).toBeUndefined();
    const more = setCount(root, g.id, 4);
    expect(named(more.root, 'Pit1BG')!.attrs.Location).toBe('1000,300,0');
    expect(named(more.root, 'Pit1PHOTO')).toBeDefined();
  });

  it('gives a stretched picture a new bitmap with the band repeated', async () => {
    const s = setup();
    const svc = new GtzipService(s.ctx);
    const t = svc.addTemplate(sampleGtzip(), 't.gtzip');
    const root = schedule();
    const [g] = repeatGroups(root);
    const r = await svc.setPartCount({ template: t.id, doc: root, group: g.id, count: 5, options: { stretch: true, shiftAfter: true } });
    const src = named(r.doc as GtNode, 'PANEL')!.children[0].children[0].attrs.Source;
    expect(src.startsWith('upload:')).toBe(true);
    const png = svc.image(null, src);
    expect(png.subarray(1, 4).toString()).toBe('PNG');
  });
});

describe('gtzip layer names', () => {
  it('gives layers readable names, keeps field names and team codes, and moves the animations along', async () => {
    const { tidyLayers } = await import('../src/services/gtzip/tidy.js');
    const L = (name: string, kids: GtNode[]): GtNode => ({ tag: 'Layer', attrs: { Name: name }, children: [{ tag: 'Layer.Composition', attrs: {}, children: [{ tag: 'Composition', attrs: {}, children: kids }] }] });
    const T = (name: string): GtNode => ({ tag: 'TextBlock', attrs: { Name: name }, children: [] });
    const root: GtNode = { tag: 'Composition', attrs: {}, children: [
      L('BG layer', [T('BG1')]), L('HEADER', [T('TITLE')]), L('ROW 1', [T('TEAM 1')]), L('Layer1', [{ tag: 'Ticker', attrs: { Name: 'Ticker1' }, children: [] }]),
      L('OMA', [T('OMA Name'), L('PHOTO OMA', [T('OMA Photo')])]), L('BAR layer', [T('BAR')]), L('T1PhotoLayer', [T('T1Photo')]),
      { tag: 'Storyboard', attrs: {}, children: [{ tag: 'Storyboard.Animations', attrs: {}, children: [{ tag: 'Fade', attrs: { Object: 'HEADER' }, children: [] }, { tag: 'Fade', attrs: { Object: 'TITLE' }, children: [] }] }] },
    ] };
    const ren = tidyLayers(root);
    expect(ren).toEqual({ 'BG layer': 'Background', HEADER: 'Header', 'ROW 1': 'Row 1', Layer1: 'Ticker', 'PHOTO OMA': 'Photo OMA', 'BAR layer': 'Main bar', T1PhotoLayer: 'T1 photo' });
    expect(allNames(root).has('TITLE')).toBe(true);
    const anims = root.children[7].children[0].children.map((a) => a.attrs.Object);
    expect(anims).toEqual(['Header', 'TITLE']);
  });
});

describe('gtzip data fields', () => {
  const layer = (name: string, y: number, inner: string) =>
    `<Layer Name="${name}" Dimensions="1920,1080,0" Location="0,${y},0"><Layer.Composition><Composition Width="1920" Height="1080">${inner}</Composition></Layer.Composition></Layer>`;
  const row = (n: number, raceW: number) => layer(`BAR ${n}`, 75 * (n - 1), `<Image Name="ROWBG ${n}" Dimensions="800,60,0" Location="560,400,0"><Image.Bitmap><Bitmap Source="${FLAG}" /></Image.Bitmap></Image><TextBlock Name="POSITION ${n}" Dimensions="40,40,0" Location="570,410,0" Text="${n}" FontSize="25" /><TextBlock Name="RACE ${n}" Dimensions="${raceW},40,0" Location="700,410,0" Text="RACE ${n}${raceW > 200 ? ' – A LONG NAME THAT FILLS THE WHOLE ROW OF IT' : ''}" FontSize="25" />`);
  const doc = (raceW: number) => parseXml(`<?xml version="1.0" encoding="utf-16"?><Composition Width="1920" Height="1080"><Image Name="PANEL" Dimensions="900,300,0" Location="510,380,0"><Image.Bitmap><Bitmap Source="${FLAG}" /></Image.Bitmap></Image>${row(1, raceW)}${row(2, raceW)}<Rectangle Name="SPONSORS" Dimensions="900,60,0" Location="510,700,0" /><Storyboard><Storyboard.Animations><Fly Object="BAR 1" /></Storyboard.Animations></Storyboard></Composition>`).root;
  const box = (r: GtNode, name: string) => { const e = elements(r).find((x) => x.node.attrs.Name === name)!; const [x, y] = e.node.attrs.Location.split(',').map(Number); const [w, h] = e.node.attrs.Dimensions.split(',').map(Number); return [e.origin[0] + x, e.origin[1] + y, w, h]; };

  it('puts a field in the free space of each row, named and styled like the row', async () => {
    const { addField } = await import('../src/services/gtzip/fields.js');
    const root = doc(120);
    const [g] = repeatGroups(root);
    const r = addField(root, { name: 'STATUS', sample: 'LIVE', group: g.id });
    expect(r.added).toEqual(['STATUS 1', 'STATUS 2']);
    expect(r.bands).toEqual([]);
    const s1 = box(r.root, 'STATUS 1');
    expect(s1[0]).toBeGreaterThan(820); // after RACE 1
    expect(s1[0] + s1[2]).toBeLessThanOrEqual(1360);
    expect(box(r.root, 'STATUS 2')[1]).toBe(s1[1] + 75);
    expect(elements(r.root).find((x) => x.node.attrs.Name === 'STATUS 1')!.node.attrs.FontSize).toBe('25');
    // a new row copies the field with the next number
    const more = setCount(r.root, g.id, 3, {});
    expect(allNames(more.root).has('STATUS 3')).toBe(true);
  });

  it('grows the rows and the panel when there is no room, keeping a centred graphic centred', async () => {
    const { addField } = await import('../src/services/gtzip/fields.js');
    const root = doc(640);
    const [g] = repeatGroups(root);
    const r = addField(root, { name: 'STATUS', sample: 'FINISHED', group: g.id });
    const grow = box(r.root, 'ROWBG 1')[2] - 800;
    expect(grow).toBeGreaterThan(80);
    expect(box(r.root, 'PANEL')[2]).toBe(900 + grow);
    // centred: everything moved back by half the growth, the sponsor bar stays in the middle
    expect(box(r.root, 'PANEL')[0]).toBeCloseTo(510 - grow / 2, 3);
    expect(box(r.root, 'SPONSORS')[0]).toBeCloseTo(510, 3);
    expect(r.bands.map((b) => b.name).sort()).toEqual(['PANEL', 'ROWBG 1', 'ROWBG 2']);
    const s = box(r.root, 'STATUS 1');
    expect(s[0]).toBeGreaterThan(box(r.root, 'RACE 1')[0] + 640);
  });
});

describe('gtzip drawing tools', () => {
  const doc = (): GtNode => ({ tag: 'Composition', attrs: { Width: '1920', Height: '1080' }, children: [] });
  const abs = (r: GtNode, name: string) => { const e = elements(r).find((x) => x.node.attrs.Name === name)!; const [x, y] = vec(e.node.attrs.Location); return [e.origin[0] + x, e.origin[1] + y]; };
  it('adds new elements with unique names, groups them into a layer and back without moving them', () => {
    let r = doc();
    r = insertElements(r, [makeElement('Rectangle', uniqueName(r, 'Box'), [100, 50, 200, 80])]).root;
    r = insertElements(r, [makeElement('TextBlock', uniqueName(r, 'Box'), [120, 60, 160, 40], { text: 'HELLO' })]).root;
    expect(elements(r).map((e) => e.node.attrs.Name)).toEqual(['Box', 'Box 2']);
    const lay = insertElements(r, [makeElement('Layer', 'L', [300, 200, 0, 0])]);
    r = moveElements(lay.root, [[1]], lay.added[0]).root;
    expect(abs(r, 'Box 2')).toEqual([120, 60]);
    expect(vec(elements(r).find((e) => e.node.attrs.Name === 'Box 2')!.node.attrs.Location).slice(0, 2)).toEqual([-180, -140]);
    const g = groupElements(r, [[0]]);
    expect(abs(g.root, 'Box')).toEqual([100, 50]);
    const gl = elements(g.root).find((e) => e.node.tag === 'Layer' && e.node.attrs.Name === 'Group')!.node;
    expect([gl.attrs.Location, gl.attrs.Dimensions]).toEqual(['100,50,0', '200,80,0']);
    expect(elements(g.root).find((e) => e.node.attrs.Name === 'Box')!.parentPath).toEqual(g.layer);
    const u = ungroup(g.root, g.layer);
    expect(elements(u.root).filter((e) => e.node.tag === 'Layer').map((e) => e.node.attrs.Name)).toEqual(['L']);
    expect(abs(u.root, 'Box')).toEqual([100, 50]);
    expect(() => moveElements(u.root, [elements(u.root).find((e) => e.node.attrs.Name === 'L')!.path], elements(u.root).find((e) => e.node.attrs.Name === 'L')!.path)).toThrow();
  });
  it('cuts a layer to its elements', () => {
    let r = doc();
    const lay = insertElements(r, [makeElement('Layer', 'L', [0, 0, 0, 0], { compSize: [1920, 1080] })]);
    r = insertElements(lay.root, [makeElement('Rectangle', 'A', [300, 200, 50, 40]), makeElement('Rectangle', 'B', [400, 260, 20, 20])], lay.added[0]).root;
    r = fitLayer(r, lay.added[0]);
    const l = elements(r).find((e) => e.node.attrs.Name === 'L')!.node;
    expect([l.attrs.Location, l.attrs.Dimensions]).toEqual(['300,200,0', '120,80,0']);
    expect(abs(r, 'B')).toEqual([400, 260]);
  });
  it('pastes copies with the next free names', () => {
    let r = doc();
    r = insertElements(r, [makeElement('Rectangle', 'BAR 1', [0, 0, 10, 10])]).root;
    const p = pasteElements(r, [elements(r)[0].node], null, 10, 10);
    expect(elements(p.root).map((e) => e.node.attrs.Name)).toEqual(['BAR 1', 'BAR 2']);
    expect(abs(p.root, 'BAR 2')).toEqual([10, 10]);
  });
});

describe('race flags', () => {
  it('come with the app and are copied into the assets folder', async () => {
    const os = await import('node:os');
    const { seedRaceFlags } = await import('../src/app.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flags-'));
    seedRaceFlags(dir);
    const files = fs.readdirSync(path.join(dir, 'race-flags'));
    expect(files).toContain('AP_postponed.png');
    expect(files.length).toBeGreaterThanOrEqual(28);
  });

});

describe('layer size', () => {
  it('a resized layer is cut, not squeezed: its composition takes its size (vMix scales a composition into its layer)', () => {
    const { root } = parseXml(`<Composition Width="1920" Height="1080"><Layer Name="Photo group" Dimensions="1920,1025,0" Location="0,0,0"><Layer.Composition><Composition Width="1920" Height="1080"><Rectangle Name="Rectangle1" Dimensions="300,298,0" Location="559,727,0" /></Composition></Layer.Composition></Layer></Composition>`);
    expect(syncLayerSizes(root)).toBe(1);
    const comp = () => root.children[0].children[0].children[0];
    expect(comp().attrs).toMatchObject({ Width: '1920', Height: '1025' });
    // the mask keeps its place: nothing inside moves
    expect(comp().children[0].attrs.Location).toBe('559,727,0');
    setVec(root.children[0], 'Dimensions', 800, 600);
    expect(comp().attrs).toMatchObject({ Width: '800', Height: '600' });
    expect(syncLayerSizes(root)).toBe(0);
  });
});
