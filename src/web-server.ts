import type { FastifyInstance } from 'fastify';
import staticPlugin from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
export async function serveWeb(app: FastifyInstance, root: string) {
  app.addHook('onSend', async (req, reply, payload) => {
    const path = req.url.split('?')[0];
    const immutable = req.method === 'GET' && reply.statusCode === 200 && /^\/(?:admin\/)?assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2?)$/.test(path);
    reply.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-store');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    return payload;
  });
  const manifestFile = join(root, '.vite', 'manifest.json');
  const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : null;
  const entry = manifest?.['index.html']?.file;
  app.get('/api/web-version', async () => ({ entry: typeof entry === 'string' ? `/${entry}` : null }));
  for (const path of ['/admin', '/admin/', '/pay', '/pay/']) app.get(path, async (_req, reply) => reply.type('text/html').send(readFileSync(join(root, 'index.html'))));
  await app.register(staticPlugin, { root, index: 'index.html', dotfiles: 'deny', cacheControl: false, etag: false, lastModified: false });
}
