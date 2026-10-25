import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createRouterApp } from '../src/router.js';
import { gatewayAuth } from '@omnimesh/node';
import { validateOmniMeshConfig } from '@omnimesh/core';

const SECRET = 'g'.repeat(40);
const TOKEN = 't'.repeat(40);
const auth = { headers: { Authorization: `Bearer ${TOKEN}` } };

describe('live status API and dashboard', () => {
  let server: any;
  let url = '';
  let fail = false;

  beforeAll(async () => {
    const app = new Hono();
    app.use('*', gatewayAuth({ secret: SECRET }));
    app.get('/api/data', (c) => (fail ? c.text('down', 503) : c.json({ ok: true })));
    await new Promise<void>((r) => {
      server = serve({ fetch: app.fetch, port: 0 }, (info) => {
        url = `http://127.0.0.1:${info.port}`;
        r();
      });
    });
  });
  afterAll(() => server?.close());

  const make = () =>
    createRouterApp({
      config: validateOmniMeshConfig({
        pools: {
          '/api': [{ url, providerId: 'koyeb', requestsPerDay: 1000 }],
        },
        rateLimit: { enabled: false, requestsPerMinute: 60 },
      }),
      gatewaySecret: SECRET,
      statusToken: TOKEN,
    });

  it('reports pools, node state, quota use, totals and latency', async () => {
    fail = false;
    const router = make();
    for (let i = 0; i < 5; i++) await router.request('/api/data');
    const s = (await (await router.request('/_omnimesh/status', auth)).json()) as any;

    expect(s.totals.requests).toBe(5);
    expect(s.totals.succeeded).toBe(5);
    expect(s.latency.p95).toBeGreaterThanOrEqual(0);
    const node = s.pools[0].nodes[0];
    expect(s.pools[0].prefix).toBe('/api');
    expect(node).toMatchObject({ label: 'koyeb', state: 'healthy', requests: 5, errors: 0 });
    expect(node.quota).toMatchObject({ requestsPerDay: 1000, usedToday: 5 });
  });

  it('records node-down and outage events, coalescing repeats', async () => {
    const router = make();
    await router.request('/api/data');
    fail = true;
    for (let i = 0; i < 4; i++) await router.request('/api/data');
    fail = false;
    const s = (await (await router.request('/_omnimesh/status', auth)).json()) as any;
    const kinds = s.events.map((e: any) => e.kind);
    expect(kinds).toContain('node_down');
    const outage = s.events.find((e: any) => e.kind === 'outage');
    expect(outage.count).toBe(4); // repeats within a few seconds collapse into one line
    expect(s.pools[0].nodes[0].state).toBe('down');
    expect(s.totals.failed).toBe(4);
  });

  it('serves the dashboard and its assets only when a status token is configured, with a strict CSP', async () => {
    const router = make();
    const res = await router.request('/_omnimesh/dashboard');
    expect(res.status).toBe(200);
    const html = await res.text();
    const csp = res.headers.get('Content-Security-Policy') || '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(html).toContain('<script src="/_omnimesh/dashboard/app.js" defer></script>');
    expect(html).not.toContain(url); // node URLs only come from the authenticated API

    for (const [path, type] of [['app.js', 'text/javascript'], ['app.css', 'text/css']]) {
      const asset = await router.request(`/_omnimesh/dashboard/${path}`);
      expect(asset.status, path).toBe(200);
      expect(asset.headers.get('Content-Type'), path).toContain(type);
      expect(asset.headers.get('X-Content-Type-Options')).toBe('nosniff');
    }

    const noToken = createRouterApp({
      config: validateOmniMeshConfig({ pools: { '/api': [url] } }),
      gatewaySecret: SECRET,
    });
    for (const path of ['/_omnimesh/dashboard', '/_omnimesh/dashboard/app.js', '/_omnimesh/catalog']) {
      expect((await noToken.request(path)).status, path).toBe(404);
    }
  });

  it('dashboard script never injects markup and renders the down banner only for down nodes', async () => {
    const js = await (await make().request('/_omnimesh/dashboard/app.js')).text();
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
    expect(js).toMatch(/if \(n\.state === 'down'\) \{\s*list\.push/);
  });

  it('catalog lists every provider with card requirement and limits, behind the token', async () => {
    const router = make();
    expect((await router.request('/_omnimesh/catalog')).status).toBe(404);
    const c = (await (await router.request('/_omnimesh/catalog', auth)).json()) as any;
    const oracle = c.providers.find((p: any) => p.id === 'oracle');
    expect(oracle).toMatchObject({ requiresCard: true, tier: 'free' });
    expect(c.providers.find((p: any) => p.id === 'koyeb').requiresCard).toBe(false);
    expect(c.providers.every((p: any) => /^\d{4}-\d{2}-\d{2}$/.test(p.limits.lastVerified))).toBe(true);
  });

  it('status reports version, shared-state wiring and router settings for the setup checklist', async () => {
    const s = (await (await make().request('/_omnimesh/status', auth)).json()) as any;
    expect(s.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(s.sharing).toEqual({ health: 'per-instance', rateLimit: 'per-instance' });
    expect(s.routerConfig).toMatchObject({ strategy: 'priority', defaultPool: '/api', maxBodyBytes: 10 * 1024 * 1024 });
    expect(s.keepAlive).toEqual({ enabled: false });
  });

  it('generated dashboard assets match the sources (run pnpm build:dashboard)', async () => {
    const { renderAssetsModule } = await import('../scripts/build-dashboard.mjs');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const generated = fs.readFileSync(path.resolve(__dirname, '../src/dashboard-assets.generated.ts'), 'utf-8');
    expect(generated).toBe(renderAssetsModule());
  });

  it('records a quota_limit event when a provider reaches its free quota and traffic moves on', async () => {
    fail = false;
    const router = createRouterApp({
      config: validateOmniMeshConfig({
        pools: { '/api': [{ url, providerId: 'netlify', requestsPerDay: 20 }, { url: `${url}/b`, providerId: 'vercel' }] },
        rateLimit: { enabled: false, requestsPerMinute: 60 },
      }),
      gatewaySecret: SECRET,
      statusToken: TOKEN,
    });
    for (let i = 0; i < 25; i++) await router.request('/api/data');
    const s = (await (await router.request('/_omnimesh/status', auth)).json()) as any;
    const ev = s.events.filter((e: any) => e.kind === 'quota_limit');
    expect(ev).toHaveLength(1); // once per switch, not once per request
    expect(ev[0].node).toBe('netlify');
  });

});
