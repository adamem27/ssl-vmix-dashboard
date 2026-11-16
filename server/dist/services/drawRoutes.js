import fs from 'node:fs';
import { previewFile } from './assets.js';
import { badRequest, notFound } from './errors.js';
import { DRAW_INPUT, drawConfigSchema, headerPath, saveHeader } from './draw.js';
import { parseVmixXml, vmixUrl } from './vmixResults.js';
/** Paths the DRAW output page (a vMix Browser input) reads without logging in: the draw is shown in public anyway. */
export const isDrawOutputPath = (pathname) => pathname === '/draw/output' || pathname.startsWith('/api/draw/output');
/** DRAW tab: the pool and the draw's steps, the output page's data, the vMix input and the Companion page. */
export function registerDrawRoutes(app, ctx, draw, fetcher = fetch) {
    app.get('/api/draw', async () => ({ ...draw.view(), companion: draw.companionStatus() }));
    app.put('/api/draw/config', async (req) => draw.setConfig(drawConfigSchema.partial().parse(req.body)));
    app.get('/api/draw/qualified', async () => ({ teamIds: draw.qualified() }));
    const act = async (req) => {
        const a = String(req.query?.a ?? req.body?.a ?? '').trim();
        if (!a)
            throw badRequest('Add ?a=<action>, e.g. ?a=team:1 or ?a=group:A');
        return draw.run(a);
    };
    app.get('/api/draw/do', act);
    app.post('/api/draw/do', act);
    // ---------- output page (public) ----------
    app.get('/api/draw/output', async (_req, reply) => { reply.header('Cache-Control', 'no-store'); return draw.output(); });
    app.get('/api/draw/output/flag/:teamId', async (req, reply) => {
        const id = draw.flagFile(req.params.teamId);
        const f = id ? previewFile(ctx, id) : null;
        if (!f)
            throw notFound('Flag');
        return reply.type(f.mime).header('Cache-Control', 'max-age=60').send(fs.createReadStream(f.path));
    });
    app.get('/api/draw/output/header.png', async (_req, reply) => reply.type('image/png').header('Cache-Control', 'no-cache').send(fs.createReadStream(headerPath(ctx.assetsDir))));
    app.post('/api/draw/header', async (req) => {
        const file = await req.file();
        if (!file)
            throw badRequest('No file was uploaded.');
        saveHeader(ctx.assetsDir, await file.toBuffer());
        draw.touch(); // the output reloads the picture
        return { ok: true };
    });
    app.delete('/api/draw/header', async () => { saveHeader(ctx.assetsDir, null); draw.touch(); return { ok: true }; });
    // ---------- vMix: a Browser input showing the output page ----------
    app.post('/api/draw/vmix-input', async (req) => {
        const url = String(req.body?.url ?? '').trim();
        if (!/^https?:\/\/\S+$/.test(url))
            throw badRequest('Send { url: "http://…/draw/output" }, the address vMix can open.');
        const base = vmixUrl(ctx.db);
        const call = async (q) => {
            let res;
            try {
                res = await fetcher(`${base}/api/${q}`, { signal: AbortSignal.timeout(4000) });
            }
            catch {
                throw badRequest(`vMix does not answer at ${base}.`);
            }
            if (!res.ok)
                throw badRequest(`vMix answered ${res.status}.`);
            return res.text();
        };
        const titleOf = parseVmixXml;
        const before = titleOf(await call(''));
        const have = before.find((x) => x.title === DRAW_INPUT);
        if (have) {
            await call(`?Function=BrowserNavigate&Input=${encodeURIComponent(have.key)}&Value=${encodeURIComponent(url)}`);
            return { added: false, input: DRAW_INPUT };
        }
        await call(`?Function=AddInput&Value=${encodeURIComponent(`Browser|${url}`)}`);
        const fresh = titleOf(await call('')).find((x) => !before.some((b) => b.key === x.key));
        if (fresh)
            await call(`?Function=SetInputName&Input=${encodeURIComponent(fresh.key)}&Value=${DRAW_INPUT}`);
        return { added: true, input: DRAW_INPUT, renamed: !!fresh };
    });
    // ---------- Companion ----------
    app.post('/api/draw/labels', async () => draw.pushLabels(true));
    app.get('/api/draw/companion.companionconfig', async (req, reply) => {
        const base = String(req.query?.base ?? '') || `${req.protocol}://${req.headers.host}`;
        reply.header('Content-Disposition', `attachment; filename="ssl-page${draw.config.companionPage}-draw.companionconfig"`);
        reply.type('application/json');
        return JSON.stringify(draw.companionPage(base), null, 2);
    });
}
