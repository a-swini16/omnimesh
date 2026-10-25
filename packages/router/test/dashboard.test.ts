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

  it('serves the dashboard only when a status token is configured, with a strict CSP', async () => {
    const res = await make().request('/_omnimesh/dashboard');
    expect(res.status).toBe(200);
    const html = await res.text();
    const csp = res.headers.get('Content-Security-Policy') || '';
    const nonce = /'nonce-([A-Za-z0-9+/=_-]+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(html).not.toContain(url); // node URLs only come from the authenticated API

    const noToken = createRouterApp({
      config: validateOmniMeshConfig({ pools: { '/api': [url] } }),
      gatewaySecret: SECRET,
    });
    expect((await noToken.request('/_omnimesh/dashboard')).status).toBe(404);
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

  it('dashboard script: only nodes in state "down" produce a down banner', async () => {
    const html = await (await make().request('/_omnimesh/dashboard')).text();
    const script = html.slice(html.indexOf('function render(d)'), html.indexOf('function cell('));
    expect(script).toMatch(/if \(n\.state === 'down'\) \{\s*alerts\.push/);
  });
});
