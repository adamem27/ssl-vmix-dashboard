import fs from 'node:fs';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest } from '../errors.js';
import { generateSchema, GtzipService, saveTemplateSchema, sniffMime } from './gtzip.js';
import { SCENES } from './scenes.js';

/** /api/gtzip/… – the GTZIP generator tab. Nothing here modifies a template or an existing generated file. */
export function registerGtzipRoutes(app: FastifyInstance, svc: GtzipService) {
  const disposition = (name: string) => `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`;

  app.get('/api/gtzip', async () => ({ templates: svc.listTemplates(), outputs: svc.listOutputs(), outputsDir: svc.outputsDir, scenes: SCENES }));
  app.post('/api/gtzip/templates/from-doc', async (req) => svc.saveAsTemplate(saveTemplateSchema.parse(req.body)));
  app.post('/api/gtzip/templates', async (req) => {
    const file = await req.file();
    if (!file) throw badRequest('No file was uploaded.');
    if (!/\.gtzip$/i.test(file.filename)) throw badRequest('Upload a .gtzip file saved by GT Title Designer.');
    return svc.addTemplate(await file.toBuffer(), file.filename);
  });
  app.get<{ Params: { id: string } }>('/api/gtzip/templates/:id', async (req) => svc.template(req.params.id));
  app.patch<{ Params: { id: string } }>('/api/gtzip/templates/:id', async (req) =>
    svc.updateTemplate(req.params.id, z.object({ name: z.string().min(1).max(120).optional(), scene: z.string().max(60).nullable().optional(), variant: z.string().max(60).nullable().optional() }).parse(req.body)));
  app.delete<{ Params: { id: string } }>('/api/gtzip/templates/:id', async (req) => { svc.deleteTemplate(req.params.id); return { ok: true }; });
  app.get<{ Params: { id: string } }>('/api/gtzip/templates/:id/file', async (req, reply) => {
    const m = svc.meta(req.params.id);
    return reply.type('application/octet-stream').header('Content-Disposition', disposition(m.originalFilename || `${m.name}.gtzip`)).send(fs.createReadStream(svc.templateFile(req.params.id)));
  });
  app.get<{ Params: { id: string } }>('/api/gtzip/templates/:id/thumbnail', async (req, reply) => {
    const t = svc.thumbnailOf(req.params.id);
    if (!t) return reply.status(404).send({ error: 'No thumbnail.' });
    return reply.type('image/png').header('Cache-Control', 'private, max-age=300').send(t);
  });
  // picture for the preview: ?src=<Bitmap Source> (template resource, upload:…, asset:…)
  app.get<{ Querystring: { template?: string; src?: string } }>('/api/gtzip/image', async (req, reply) => {
    const buf = svc.image(req.query.template ? String(req.query.template) : null, String(req.query.src ?? ''));
    return reply.type(sniffMime(buf)).header('Cache-Control', 'private, max-age=3600').send(buf);
  });
  app.post('/api/gtzip/images', async (req) => {
    const file = await req.file();
    if (!file) throw badRequest('No file was uploaded.');
    return svc.saveUpload(await file.toBuffer(), file.filename);
  });
  app.get('/api/gtzip/asset-images', async () => svc.assetImages());

  app.get<{ Querystring: { name?: string } }>('/api/gtzip/free-name', async (req) => ({ name: svc.freeName(String(req.query.name ?? 'title')) }));
  app.post('/api/gtzip/generate', async (req) => svc.generate(generateSchema.parse(req.body)));
  app.get<{ Params: { name: string } }>('/api/gtzip/outputs/:name', async (req, reply) => {
    const f = svc.outputFile(req.params.name);
    return reply.type('application/octet-stream').header('Content-Disposition', disposition(f.split(/[\\/]/).pop()!)).send(fs.createReadStream(f));
  });
  app.post<{ Params: { name: string } }>('/api/gtzip/outputs/:name/to-template', async (req) => svc.outputToTemplate(req.params.name));
}
