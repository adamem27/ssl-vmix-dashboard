import fs from 'node:fs';
import path from 'node:path';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AssetCtx, previewFile } from './assets.js';
import { badRequest, notFound } from './errors.js';
import { deleteFlagVideo, Draw, DRAW_INPUT, DRAW_MATCHBOARD_INPUT, DRAW_MATCHBOARD_REL, drawConfigSchema, flagVideoPath, headerPath, saveFlagVideo, saveHeader } from './draw.js';
import { parseVmixXml, vmixUrl } from './vmixResults.js';
import { imagePath } from './graphicSets.js';
import type { MatchboardExporter } from './matchboard/matchboard.js';

const VIDEO_TYPES: Record<string, string> = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' };
/** A video file with byte ranges (the browser seeks and streams it instead of loading it whole). */
function sendRange(req: FastifyRequest, reply: FastifyReply, file: string) {
  const size = fs.statSync(file).size;
  reply.header('Accept-Ranges', 'bytes').header('Cache-Control', 'max-age=3600').type(VIDEO_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (!m || (!m[1] && !m[2])) return reply.header('Content-Length', size).send(fs.createReadStream(file));
  let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start >= size || start > end) return reply.code(416).header('Content-Range', `bytes */${size}`).send();
  start = Math.max(0, start); end = Math.max(start, end);
  return reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`).header('Content-Length', end - start + 1).send(fs.createReadStream(file, { start, end }));
}

/** Paths the DRAW output page (a vMix Browser input) reads without logging in: the draw is shown in public anyway. */
export const isDrawOutputPath = (pathname: string) => pathname === '/draw/output' || pathname.startsWith('/api/draw/output');

/** DRAW tab: the pool and the draw's steps, the output page's data, the vMix input and the Companion page. */
export function registerDrawRoutes(app: FastifyInstance, ctx: AssetCtx, draw: Draw, fetcher: typeof fetch = fetch, matchboard?: MatchboardExporter) {
  const vmix = async (q: string) => {
    const base = vmixUrl(ctx.db);
    let res;
    try { res = await fetcher(`${base}/api/${q}`, { signal: AbortSignal.timeout(4000) }); } catch { throw badRequest(`vMix does not answer at ${base}.`); }
    if (!res.ok) throw badRequest(`vMix answered ${res.status}.`);
    return res.text();
  };
  app.get('/api/draw', async () => ({ ...draw.view(), companion: draw.companionStatus() }));
  app.put('/api/draw/config', async (req) => draw.setConfig(drawConfigSchema.partial().parse(req.body)));
  app.get('/api/draw/qualified', async () => ({ teamIds: draw.qualified() }));
  const act = async (req: any) => {
    const a = String(req.query?.a ?? (req.body as Record<string, unknown> | null)?.a ?? '').trim();
    if (!a) throw badRequest('Add ?a=<action>, e.g. ?a=team:1 or ?a=group:A');
    return draw.run(a);
  };
  app.get('/api/draw/do', act);
  app.post('/api/draw/do', act);

  // ---------- output page (public) ----------
  app.get('/api/draw/output', async (_req, reply) => { reply.header('Cache-Control', 'no-store'); return draw.output(); });
  app.get<{ Params: { teamId: string } }>('/api/draw/output/flag/:teamId', async (req, reply) => {
    const id = draw.flagFile(req.params.teamId);
    const f = id ? previewFile(ctx, id) : null;
    if (!f) throw notFound('Flag');
    return reply.type(f.mime).header('Cache-Control', 'max-age=60').send(fs.createReadStream(f.path));
  });
  app.get<{ Params: { teamId: string } }>('/api/draw/output/video/:teamId', async (req, reply) => {
    const f = flagVideoPath(ctx.assetsDir, req.params.teamId);
    if (!f) throw notFound('Flag video');
    return sendRange(req, reply, f);
  });
  app.get('/api/draw/output/header.png', async (_req, reply) => reply.type('image/png').header('Cache-Control', 'no-cache').send(fs.createReadStream(headerPath(ctx.assetsDir))));

  app.post('/api/draw/header', async (req: any) => {
    const file = await req.file();
    if (!file) throw badRequest('No file was uploaded.');
    saveHeader(ctx.assetsDir, await file.toBuffer());
    draw.touch(); // the output reloads the picture
    return { ok: true };
  });
  app.delete('/api/draw/header', async () => { saveHeader(ctx.assetsDir, null); draw.touch(); return { ok: true }; });

  // ---------- flag animations: one video per team ----------
  app.post<{ Params: { teamId: string } }>('/api/draw/video/:teamId', async (req: any) => {
    const teamId = String(req.params.teamId);
    if (!draw.allTeams().some((t) => t.id === teamId)) throw notFound('Team');
    const file = await req.file({ limits: { fileSize: 2 * 1024 * 1024 * 1024 } });
    if (!file) throw badRequest('No file was uploaded.');
    await saveFlagVideo(ctx.assetsDir, teamId, file.filename, file.file);
    draw.touch();
    return { ok: true };
  });
  app.delete<{ Params: { teamId: string } }>('/api/draw/video/:teamId', async (req) => { deleteFlagVideo(ctx.assetsDir, req.params.teamId); draw.touch(); return { ok: true }; });

  // ---------- the matchboard with the teams drawn (its own PNG and vMix input) ----------
  const mbFile = path.join(ctx.assetsDir, ...DRAW_MATCHBOARD_REL.split('/'));
  const mbStatus = { lastWriteAt: null as string | null, error: null as string | null };
  const renderBoard = async () => {
    if (!matchboard) throw badRequest('The matchboard is not available here.');
    try {
      const buf = await matchboard.renderBuffer(draw.matchboardState());
      fs.mkdirSync(path.dirname(mbFile), { recursive: true });
      fs.writeFileSync(mbFile + '.tmp', buf); fs.renameSync(mbFile + '.tmp', mbFile);
      mbStatus.lastWriteAt = new Date().toISOString(); mbStatus.error = null;
    } catch (e) { mbStatus.error = (e as Error).message; throw e; }
    // the vMix input showing it reads the file again (vMix may be off: nothing then)
    try {
      const have = parseVmixXml(await vmix('')).find((x) => x.title === DRAW_MATCHBOARD_INPUT);
      if (have) await vmix(`?Function=SetImage&Input=${encodeURIComponent(have.key)}&Value=${encodeURIComponent(imagePath(ctx.db, ctx.assetsDir, DRAW_MATCHBOARD_REL))}`);
    } catch { /* vMix off */ }
    return boardStatus();
  };
  const boardStatus = () => ({ ...mbStatus, file: mbFile, vmixPath: imagePath(ctx.db, ctx.assetsDir, DRAW_MATCHBOARD_REL), exists: fs.existsSync(mbFile), input: DRAW_MATCHBOARD_INPUT });
  let mbTimer: ReturnType<typeof setTimeout> | null = null;
  draw.onPicks = () => {
    if (!matchboard) return;
    if (mbTimer) clearTimeout(mbTimer);
    mbTimer = setTimeout(() => { mbTimer = null; void renderBoard().catch(() => {}); }, 1500);
    mbTimer.unref?.();
  };
  app.get('/api/draw/matchboard', async () => boardStatus());
  app.post('/api/draw/matchboard', async () => renderBoard());
  app.get('/api/draw/matchboard.png', async (_req, reply) => {
    if (!fs.existsSync(mbFile)) await renderBoard();
    return reply.type('image/png').header('Cache-Control', 'no-store').send(fs.createReadStream(mbFile));
  });
  app.post('/api/draw/matchboard-input', async () => {
    if (!fs.existsSync(mbFile)) await renderBoard();
    const file = imagePath(ctx.db, ctx.assetsDir, DRAW_MATCHBOARD_REL);
    const before = parseVmixXml(await vmix(''));
    const have = before.find((x) => x.title === DRAW_MATCHBOARD_INPUT);
    if (have) { await vmix(`?Function=SetImage&Input=${encodeURIComponent(have.key)}&Value=${encodeURIComponent(file)}`); return { added: false, input: DRAW_MATCHBOARD_INPUT, image: file }; }
    await vmix(`?Function=AddInput&Value=${encodeURIComponent(`Image|${file}`)}`);
    const fresh = parseVmixXml(await vmix('')).find((x) => !before.some((b) => b.key === x.key));
    if (!fresh) throw badRequest(`vMix did not add the picture (${file}). Check the vMix assets folder in Settings → Files and paths.`);
    await vmix(`?Function=SetInputName&Input=${encodeURIComponent(fresh.key)}&Value=${DRAW_MATCHBOARD_INPUT}`);
    return { added: true, input: DRAW_MATCHBOARD_INPUT, image: file };
  });

  // ---------- vMix: a Browser input showing the output page ----------
  app.post('/api/draw/vmix-input', async (req: any) => {
    const url = String((req.body as { url?: string } | null)?.url ?? '').trim();
    if (!/^https?:\/\/\S+$/.test(url)) throw badRequest('Send { url: "http://…/draw/output" }, the address vMix can open.');
    const call = vmix;
    const titleOf = parseVmixXml;
    const before = titleOf(await call(''));
    const have = before.find((x) => x.title === DRAW_INPUT);
    if (have) {
      await call(`?Function=BrowserNavigate&Input=${encodeURIComponent(have.key)}&Value=${encodeURIComponent(url)}`);
      return { added: false, input: DRAW_INPUT };
    }
    await call(`?Function=AddInput&Value=${encodeURIComponent(`Browser|${url}`)}`);
    const fresh = titleOf(await call('')).find((x) => !before.some((b) => b.key === x.key));
    if (fresh) await call(`?Function=SetInputName&Input=${encodeURIComponent(fresh.key)}&Value=${DRAW_INPUT}`);
    return { added: true, input: DRAW_INPUT, renamed: !!fresh };
  });

  // ---------- Companion ----------
  app.post('/api/draw/labels', async () => draw.pushLabels(true));
  app.get('/api/draw/companion.companionconfig', async (req: any, reply) => {
    const base = String(req.query?.base ?? '') || `${req.protocol}://${req.headers.host}`;
    reply.header('Content-Disposition', `attachment; filename="ssl-page${draw.config.companionPage}-draw.companionconfig"`);
    reply.type('application/json');
    return JSON.stringify(draw.companionPage(base), null, 2);
  });
}
