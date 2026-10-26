/**
 * Local preview for checking the dashboard by hand: the real router (same code as the Worker)
 * in front of two small real apps on this computer. Nothing here is shown to users.
 *   GATEWAY_SECRET=... OMNIMESH_STATUS_TOKEN=... npx tsx benchmarks/local-view.ts
 * Break or fix an app:  curl -XPOST localhost:4201/__break   /  curl -XPOST localhost:4201/__fix
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { gatewayAuth } from '@omnimesh/node';
import { validateOmniMeshConfig } from '@omnimesh/core';
import { createRouterApp } from '@omnimesh/router';

const SECRET = process.env.GATEWAY_SECRET!;
const TOKEN = process.env.OMNIMESH_STATUS_TOKEN!;
if (!SECRET || !TOKEN) throw new Error('GATEWAY_SECRET and OMNIMESH_STATUS_TOKEN are required');

function app(name: string, port: number, locked: boolean) {
  let broken = false;
  const a = new Hono();
  a.post('/__break', (c) => ((broken = true), c.text('broken')));
  a.post('/__fix', (c) => ((broken = false), c.text('fixed')));
  if (locked) a.use('*', gatewayAuth({ secret: SECRET }));
  a.use('*', async (c, next) => (broken ? c.text('down', 503) : next()));
  a.get('/health', (c) => c.json({ ok: true, name }));
  a.get('/', (c) => c.json({ hello: 'from ' + name }));
  serve({ fetch: a.fetch, port, hostname: '127.0.0.1' });
  return `http://127.0.0.1:${port}`;
}

const config = validateOmniMeshConfig({
  profile: 'no-card',
  domain: '127.0.0.1:8787',
  defaultPool: '/',
  pools: { '/': [{ url: app('koyeb', 4201, true), providerId: 'koyeb' }, { url: app('render', 4202, false), providerId: 'render' }] },
});
const router = createRouterApp({
  config,
  gatewaySecret: SECRET,
  statusToken: TOKEN,
  appInfo: JSON.stringify({ repo: 'me/shop-api', repoUrl: 'https://github.com/me/shop-api', branch: 'main', runtime: 'node', deployedAt: new Date().toISOString() }),
});
// Print every request that goes on to the apps, so the counts on the dashboard can be traced
const logged = (req: Request) => {
  const path = new URL(req.url).pathname;
  if (!path.startsWith('/_omnimesh')) console.log(req.method, path, '-', req.headers.get('sec-fetch-dest') ?? '', req.headers.get('purpose') ?? '');
  return router.fetch(req);
};
serve({ fetch: logged, port: 8787, hostname: '127.0.0.1' }, () => console.log('router on http://127.0.0.1:8787'));
