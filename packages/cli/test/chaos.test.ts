import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { gatewayAuth } from '@omnimesh/node';
import { validateOmniMeshConfig } from '@omnimesh/core';
import { createRouterApp } from '@omnimesh/router';
import { runChaos } from '../src/commands/chaos.js';
import type { Deps } from '../src/up/http.js';

const SECRET = 's3cr3t_gateway_token_min_32_characters_long_for_security';
const TOKEN = 'status-token-for-tests-0123456789abcdef';

// A real router over HTTP in front of two real servers; the test runs the same requests a user's deployment gets
describe('omnimesh chaos: a real failover test on a running mesh', () => {
  const servers: any[] = [];
  const logs: string[] = [];
  let renderBroken = false;
  const deps: Deps = { fetch: (u, i) => fetch(u, i), sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))), log: (m) => logs.push(m) };

  const start = (fetchImpl: any) =>
    new Promise<string>((resolve) => {
      servers.push(serve({ fetch: fetchImpl, port: 0, hostname: '127.0.0.1' }, (info) => resolve(`http://127.0.0.1:${info.port}`)));
    });
  const node = (name: string, broken = () => false) => {
    const app = new Hono();
    app.use('*', gatewayAuth({ secret: SECRET }));
    app.get('/health', (c) => (broken() ? c.text('down', 503) : c.json({ name })));
    return start(app.fetch);
  };
  const mesh = async (nodes: Array<{ url: string; providerId: string }>) => {
    const config = validateOmniMeshConfig({ profile: 'no-card', domain: 'x.test', defaultPool: '/', pools: { '/': nodes } });
    return start(createRouterApp({ config, gatewaySecret: SECRET, statusToken: TOKEN }).fetch);
  };

  let koyeb = '';
  let render = '';
  beforeAll(async () => {
    koyeb = await node('koyeb');
    render = await node('render', () => renderBroken);
  });
  afterAll(() => servers.forEach((s) => s.close()));

  it('pauses the answering server, shows the other cloud taking over, then resumes it', async () => {
    const routerUrl = await mesh([{ url: koyeb, providerId: 'koyeb' }, { url: render, providerId: 'render' }]);
    const result = await runChaos({ routerUrl, token: TOKEN, deps, seconds: 30 });
    expect(result).toMatchObject({ ok: true, pool: '/', paused: 'koyeb', answeredBy: { render: 10 } });
    expect(result.summary).toMatch(/If koyeb goes down, your users are moved to render/);

    // The pause was lifted: koyeb answers again and the status shows no pause
    const res = await fetch(`${routerUrl}/health`);
    expect(res.headers.get('x-omni-node')).toBe('koyeb');
    const status = await (await fetch(`${routerUrl}/_omnimesh/status`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
    expect(status.pools[0].nodes.every((n: any) => n.pausedUntil === null)).toBe(true);
    expect(status.events.map((e: any) => e.kind)).toEqual(expect.arrayContaining(['paused', 'resumed']));
  });

  it('reports failure honestly when the other cloud cannot answer', async () => {
    renderBroken = true;
    try {
      const routerUrl = await mesh([{ url: koyeb, providerId: 'koyeb' }, { url: render, providerId: 'render' }]);
      const result = await runChaos({ routerUrl, token: TOKEN, deps, seconds: 30, switchTimeoutMs: 2000 });
      expect(result.ok).toBe(false);
      expect(result.summary).toMatch(/Failover did not work: no other server could answer, so the router had to use koyeb/);
      // Users were still served by the paused server while the test ran
      expect((await fetch(`${routerUrl}/health`)).status).toBe(200);
    } finally {
      renderBroken = false;
    }
  });

  it('refuses to test with one server and with a wrong sign-in key', async () => {
    const single = await mesh([{ url: koyeb, providerId: 'koyeb' }]);
    expect((await runChaos({ routerUrl: single, token: TOKEN, deps })).summary).toMatch(/only one server/);
    expect((await runChaos({ routerUrl: single, token: 'wrong', deps })).summary).toMatch(/did not accept the sign-in key/);
  });
});
