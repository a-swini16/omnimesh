import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createRouterApp } from '../src/router.js';
import { gatewayAuth, idempotency, healthHandler } from '@omnimesh/node';
import type { OmniMeshConfig } from '@omnimesh/core';

const TEST_SECRET = 's3cr3t_gateway_token_min_32_characters_long_for_security';

describe('OmniMesh Edge Router 3-Node Federation & Auto-Failover Gate', () => {
  let server1: any;
  let server2: any;
  let server3: any;

  let port1: number;
  let port2: number;
  let port3: number;

  let url1: string;
  let url2: string;
  let url3: string;

  let node1ShouldFail = false;
  let node2ShouldFail = false;

  beforeAll(async () => {
    // 1. Mock Node 1 (Primary - e.g. Koyeb/Oracle)
    const app1 = new Hono();
    app1.use('*', gatewayAuth({ secret: TEST_SECRET }));
    app1.get('/health', healthHandler({ providerId: 'koyeb-primary' }));
    app1.get('/api/data', (c) => {
      if (node1ShouldFail) {
        return c.text('Primary node unavailable', 503);
      }
      return c.json({ source: 'node1-primary', message: 'Hello from Node 1' });
    });
    app1.get('/api/buggy', (c) => c.text('bug in one endpoint', 500));
    app1.post('/api/buggy', (c) => c.json({ error: 'app error' }, 500));
    app1.post('/api/orders', (c) => {
      if (node1ShouldFail) {
        return c.text('Primary node crashed during order', 503);
      }
      return c.json({ orderId: 'ord_1', node: 'node1' }, 201);
    });

    // 2. Mock Node 2 (Secondary - e.g. Render warm backup)
    const app2 = new Hono();
    app2.use('*', gatewayAuth({ secret: TEST_SECRET }));
    app2.get('/health', healthHandler({ providerId: 'render-backup' }));
    app2.get('/api/data', (c) => {
      if (node2ShouldFail) {
        return c.text('Backup node 2 error', 502);
      }
      return c.json({ source: 'node2-secondary', message: 'Hello from Node 2' });
    });
    app2.post('/api/orders', (c) => {
      if (node2ShouldFail) {
        return c.text('Backup node 2 error', 502);
      }
      return c.json({ orderId: 'ord_2', node: 'node2' }, 201);
    });

    // 3. Mock Node 3 (Tertiary - e.g. Vercel serverless burst)
    const app3 = new Hono();
    app3.use('*', gatewayAuth({ secret: TEST_SECRET }));
    app3.get('/health', healthHandler({ providerId: 'vercel-burst' }));
    app3.get('/api/me', (c) => c.json({ user: c.req.header('authorization') }));
    // Apps often build absolute redirects from their own (internal) URL
    app3.get('/api/redirect', (c) => c.redirect(new URL('/api/data?x=1', c.req.url).toString(), 302));
    app3.get('/api/oauth', (c) => c.redirect('https://accounts.example.org/login?next=/api/me', 302));
    app3.get('/api/public', (c) => c.json({ ok: true }, 200, { 'Cache-Control': 'public, max-age=60' }));
    app3.get('/api/data', (c) => {
      return c.json({ source: 'node3-tertiary', message: 'Hello from Node 3' });
    });
    app3.post('/api/orders', (c) => {
      return c.json({ orderId: 'ord_3', node: 'node3' }, 201);
    });

    // Start all 3 mock backend servers on dynamic ephemeral ports
    await new Promise<void>((resolve) => {
      server1 = serve({ fetch: app1.fetch, port: 0 }, (info) => {
        port1 = info.port;
        url1 = `http://127.0.0.1:${port1}`;
        resolve();
      });
    });

    await new Promise<void>((resolve) => {
      server2 = serve({ fetch: app2.fetch, port: 0 }, (info) => {
        port2 = info.port;
        url2 = `http://127.0.0.1:${port2}`;
        resolve();
      });
    });

    await new Promise<void>((resolve) => {
      server3 = serve({ fetch: app3.fetch, port: 0 }, (info) => {
        port3 = info.port;
        url3 = `http://127.0.0.1:${port3}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    server1?.close();
    server2?.close();
    server3?.close();
  });

  it('proves steady state routes to Primary Node 1 with 1 attempt', async () => {
    const config: OmniMeshConfig = {
      profile: 'no-card',
      domain: 'api.mesh.local',
      router: {
        timeoutMs: 1500,
        maxAttempts: 3,
        totalBudgetMs: 4000,
        circuitTtlMs: 30000,
        maxBufferBytes: 1048576,
        healthCheckIntervalSeconds: 60,
      },
      pools: {
        '/api': [url1, url2, url3],
      },
      database: { mode: 'managed', primary: 'neon', connectionUrlEnv: 'DATABASE_URL' },
      cache: { provider: 'memory', urlEnv: 'REDIS_URL' },
      storage: { provider: 'supabase' },
      keepAlive: { enabled: false, intervalMinutes: 14, targets: [] },
      rateLimit: { enabled: false, requestsPerMinute: 120 },
    };

    const router = createRouterApp({ config, gatewaySecret: TEST_SECRET });

    const res = await router.request('/api/data');
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Omni-Node')).toBe('node-1');
    expect(res.headers.get('X-Omni-Attempts')).toBe('1');

    const json = await res.json() as any;
    expect(json.source).toBe('node1-primary');
  });

  it('GATE: kills Node 1 -> traffic automatically moves to Node 2 and request succeeds', async () => {
    // Kill Node 1 (simulate failure)
    node1ShouldFail = true;

    const config: OmniMeshConfig = {
      profile: 'no-card',
      domain: 'api.mesh.local',
      router: {
        timeoutMs: 1500,
        maxAttempts: 3,
        totalBudgetMs: 4000,
        circuitTtlMs: 30000,
        maxBufferBytes: 1048576,
        healthCheckIntervalSeconds: 60,
      },
      pools: {
        '/api': [url1, url2, url3],
      },
      database: { mode: 'managed', primary: 'neon', connectionUrlEnv: 'DATABASE_URL' },
      cache: { provider: 'memory', urlEnv: 'REDIS_URL' },
      storage: { provider: 'supabase' },
      keepAlive: { enabled: false, intervalMinutes: 14, targets: [] },
      rateLimit: { enabled: false, requestsPerMinute: 120 },
    };

    const router = createRouterApp({ config, gatewaySecret: TEST_SECRET });

    const res = await router.request('/api/data');
    expect(res.status).toBe(200);
    // Request succeeded on Node 2!
    expect(res.headers.get('X-Omni-Node')).toBe('node-2');
    expect(res.headers.get('X-Omni-Attempts')).toBe('2');

    const json = await res.json() as any;
    expect(json.source).toBe('node2-secondary');
  });

  it('proves circuit breaker: subsequent requests instantly skip dead Node 1 without delay', async () => {
    const config: OmniMeshConfig = {
      profile: 'no-card',
      domain: 'api.mesh.local',
      router: {
        timeoutMs: 1500,
        maxAttempts: 3,
        totalBudgetMs: 4000,
        circuitTtlMs: 30000,
        maxBufferBytes: 1048576,
        healthCheckIntervalSeconds: 60,
      },
      pools: {
        '/api': [url1, url2, url3],
      },
      database: { mode: 'managed', primary: 'neon', connectionUrlEnv: 'DATABASE_URL' },
      cache: { provider: 'memory', urlEnv: 'REDIS_URL' },
      storage: { provider: 'supabase' },
      keepAlive: { enabled: false, intervalMinutes: 14, targets: [] },
      rateLimit: { enabled: false, requestsPerMinute: 120 },
    };

    const router = createRouterApp({ config, gatewaySecret: TEST_SECRET });

    // First request trips the breaker on node1 and fails over to node2
    await router.request('/api/data');

    // Second request: Node 1 is already in circuit breaker deadNodes
    const res2 = await router.request('/api/data');
    expect(res2.status).toBe(200);
    expect(res2.headers.get('X-Omni-Node')).toBe('node-2');
    expect(res2.headers.get('X-Omni-Attempts')).toBe('1'); // Direct to Node 2 in 1 attempt!
  });

  it('proves cascade failover: kills Node 2 as well -> traffic moves to Node 3', async () => {
    node1ShouldFail = true;
    node2ShouldFail = true;

    const config: OmniMeshConfig = {
      profile: 'no-card',
      domain: 'api.mesh.local',
      router: {
        timeoutMs: 1500,
        maxAttempts: 3,
        totalBudgetMs: 4000,
        circuitTtlMs: 30000,
        maxBufferBytes: 1048576,
        healthCheckIntervalSeconds: 60,
      },
      pools: {
        '/api': [url1, url2, url3],
      },
      database: { mode: 'managed', primary: 'neon', connectionUrlEnv: 'DATABASE_URL' },
      cache: { provider: 'memory', urlEnv: 'REDIS_URL' },
      storage: { provider: 'supabase' },
      keepAlive: { enabled: false, intervalMinutes: 14, targets: [] },
      rateLimit: { enabled: false, requestsPerMinute: 120 },
    };

    const router = createRouterApp({ config, gatewaySecret: TEST_SECRET });

    const res = await router.request('/api/data');
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Omni-Node')).toBe('node-3');
    expect(res.headers.get('X-Omni-Attempts')).toBe('3');

    const json = await res.json() as any;
    expect(json.source).toBe('node3-tertiary');
  });

  it('enforces Safe Retries: POST without Idempotency-Key fails fast instead of risking duplicate payment', async () => {
    node1ShouldFail = true; // Primary node fails

    const config: OmniMeshConfig = {
      profile: 'no-card',
      domain: 'api.mesh.local',
      router: {
        timeoutMs: 1500,
        maxAttempts: 3,
        totalBudgetMs: 4000,
        circuitTtlMs: 30000,
        maxBufferBytes: 1048576,
        healthCheckIntervalSeconds: 60,
      },
      pools: {
        '/api': [url1, url2, url3],
      },
      database: { mode: 'managed', primary: 'neon', connectionUrlEnv: 'DATABASE_URL' },
      cache: { provider: 'memory', urlEnv: 'REDIS_URL' },
      storage: { provider: 'supabase' },
      keepAlive: { enabled: false, intervalMinutes: 14, targets: [] },
      rateLimit: { enabled: false, requestsPerMinute: 120 },
    };

    const router = createRouterApp({ config, gatewaySecret: TEST_SECRET });

    // POST without Idempotency-Key
    const res = await router.request('/api/orders', {
      method: 'POST',
      body: JSON.stringify({ amount: 50 }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(503);
    const json = await res.json() as any;
    expect(json.code).toBe('ERR_IDEMPOTENCY_REQUIRED_ON_FAILURE');
  });

  it('allows safe retry when Idempotency-Key is present on mutating POST request', async () => {
    node1ShouldFail = true; // Primary fails
    node2ShouldFail = false; // Secondary is healthy

    const config: OmniMeshConfig = {
      profile: 'no-card',
      domain: 'api.mesh.local',
      router: {
        timeoutMs: 1500,
        maxAttempts: 3,
        totalBudgetMs: 4000,
        circuitTtlMs: 30000,
        maxBufferBytes: 1048576,
        healthCheckIntervalSeconds: 60,
      },
      pools: {
        '/api': [url1, url2, url3],
      },
      database: { mode: 'managed', primary: 'neon', connectionUrlEnv: 'DATABASE_URL' },
      cache: { provider: 'memory', urlEnv: 'REDIS_URL' },
      storage: { provider: 'supabase' },
      keepAlive: { enabled: false, intervalMinutes: 14, targets: [] },
      rateLimit: { enabled: false, requestsPerMinute: 120 },
    };

    const router = createRouterApp({ config, gatewaySecret: TEST_SECRET });

    // POST WITH Idempotency-Key
    const res = await router.request('/api/orders', {
      method: 'POST',
      body: JSON.stringify({ amount: 50 }),
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'ord_uuid_888999',
      },
    });

    expect(res.status).toBe(201);
    expect(res.headers.get('X-Omni-Node')).toBe('node-2');
    expect(res.headers.get('X-Omni-Attempts')).toBe('2');
  });

  it('rejects direct calls to mock backends missing X-Gateway-Secret with 403', async () => {
    const directRes = await fetch(`${url1}/api/data`);
    expect(directRes.status).toBe(403);
    const json = await directRes.json() as any;
    expect(json.code).toBe('ERR_GATEWAY_SECRET_INVALID');
  });

  describe('security hardening', () => {
    const baseConfig = (): OmniMeshConfig => ({
      profile: 'no-card',
      domain: 'api.mesh.local',
      router: { timeoutMs: 1500, maxAttempts: 3, totalBudgetMs: 4000, circuitTtlMs: 30000, maxBufferBytes: 1024, healthCheckIntervalSeconds: 60 },
      pools: { '/api': [url3] },
      database: { mode: 'managed', primary: 'neon', connectionUrlEnv: 'DATABASE_URL' },
      cache: { provider: 'memory', urlEnv: 'REDIS_URL' },
      storage: { provider: 'supabase' },
      keepAlive: { enabled: false, intervalMinutes: 14, targets: [] },
      rateLimit: { enabled: false, requestsPerMinute: 120 },
    });

    it('[M-1] rewrites redirects to a node\'s own URL onto the public domain', async () => {
      const router = createRouterApp({ config: baseConfig(), gatewaySecret: TEST_SECRET });
      const res = await router.request('https://api.mesh.local/api/redirect');
      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('https://api.mesh.local/api/data?x=1');

      const external = await router.request('https://api.mesh.local/api/oauth');
      expect(external.headers.get('Location')).toBe('https://accounts.example.org/login?next=/api/me');
    });

    it('[M-9] marks responses to authenticated requests as private so no CDN shares them', async () => {
      const router = createRouterApp({ config: baseConfig(), gatewaySecret: TEST_SECRET });
      const me = await router.request('/api/me', { headers: { Authorization: 'Bearer alice' } });
      expect(me.headers.get('Cache-Control')).toBe('private, no-store');
      expect(me.headers.get('Vary')?.toLowerCase()).toContain('authorization');

      const viaCookie = await router.request('/api/me', { headers: { Cookie: 'session=abc' } });
      expect(viaCookie.headers.get('Cache-Control')).toBe('private, no-store');
      expect(viaCookie.headers.get('Vary')?.toLowerCase()).toContain('cookie');

      // Anonymous public responses keep the app's caching policy
      const pub = await router.request('/api/public');
      expect(pub.headers.get('Cache-Control')).toBe('public, max-age=60');
    });

    it('hides /_omnimesh/status unless the status token is presented', async () => {
      const router = createRouterApp({ config: baseConfig(), gatewaySecret: TEST_SECRET, statusToken: 't'.repeat(32) });
      expect((await router.request('/_omnimesh/status')).status).toBe(404);
      const ok = await router.request('/_omnimesh/status', { headers: { Authorization: `Bearer ${'t'.repeat(32)}` } });
      expect(ok.status).toBe(200);
    });

    it('never exposes upstream URLs in responses', async () => {
      const router = createRouterApp({ config: baseConfig(), gatewaySecret: TEST_SECRET });
      const res = await router.request('/api/data');
      expect(res.headers.get('X-Omni-Node')).toBe('node-1');
      expect(JSON.stringify([...res.headers])).not.toContain('127.0.0.1');
    });

    it('[H-6] rejects bodies over maxBodyBytes with 413 even when they would be streamed', async () => {
      const cfg = baseConfig();
      cfg.router.maxBodyBytes = 4096; // maxBufferBytes is 1024, so 2-4 KB bodies are streamed
      const router = createRouterApp({ config: cfg, gatewaySecret: TEST_SECRET });
      const send = (size: number) =>
        router.request('/api/orders', { method: 'POST', body: new Uint8Array(size), headers: { 'Content-Length': String(size) } });

      const tooBig = await send(8192);
      expect(tooBig.status).toBe(413);
      expect(((await tooBig.json()) as any).code).toBe('ERR_BODY_TOO_LARGE');
      expect((await send(2048)).status).toBe(201); // within the cap: streamed to the node as before
    });

    it('rejects oversized chunked bodies with 413 instead of buffering them', async () => {
      const router = createRouterApp({ config: baseConfig(), gatewaySecret: TEST_SECRET });
      const big = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(4096)); c.close(); } });
      const res = await router.request('/api/orders', { method: 'POST', body: big, duplex: 'half' } as any);
      expect(res.status).toBe(413);
    });

    it('matches pools on path segments only (/apiary is not /api)', async () => {
      const cfg = baseConfig();
      cfg.pools = { '/api': [url3], '/auth': ['http://127.0.0.1:1'] };
      const router = createRouterApp({ config: cfg, gatewaySecret: TEST_SECRET });
      expect((await router.request('/authz/x')).headers.get('X-Omni-Node')).toBe('node-1');
    });

    it('refuses plain-http remote upstreams (gateway secret would travel unencrypted)', () => {
      const cfg = baseConfig();
      cfg.pools = { '/api': ['http://core-api.example.com'] };
      expect(() => createRouterApp({ config: cfg, gatewaySecret: TEST_SECRET })).toThrow(/https/);
    });

    it('rate-limits a single client IP', async () => {
      const cfg = baseConfig();
      cfg.rateLimit = { enabled: true, requestsPerMinute: 2 };
      const router = createRouterApp({ config: cfg, gatewaySecret: TEST_SECRET });
      const h = { headers: { 'CF-Connecting-IP': '203.0.113.9' } };
      await router.request('/api/data', h);
      await router.request('/api/data', h);
      const res = await router.request('/api/data', h);
      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBeTruthy();
    });
  });

  describe('load balancing & circuit threshold', () => {
    const cfg = (pool: any[], router: Partial<OmniMeshConfig['router']> = {}): OmniMeshConfig => ({
      profile: 'no-card',
      domain: 'api.mesh.local',
      router: { timeoutMs: 1500, maxAttempts: 3, totalBudgetMs: 4000, circuitTtlMs: 30000, maxBufferBytes: 1048576, healthCheckIntervalSeconds: 60, ...router },
      pools: { '/api': pool },
      database: { mode: 'managed', primary: 'neon', connectionUrlEnv: 'DATABASE_URL' },
      cache: { provider: 'memory', urlEnv: 'REDIS_URL' },
      storage: { provider: 'supabase' },
      keepAlive: { enabled: false, intervalMinutes: 14, targets: [] },
      rateLimit: { enabled: false, requestsPerMinute: 120 },
    });

    it('weighted strategy spreads traffic across healthy nodes by weight', async () => {
      node1ShouldFail = false;
      node2ShouldFail = false;
      const router = createRouterApp({
        config: cfg([{ url: url1, weight: 1 }, { url: url2, weight: 1 }, { url: url3, weight: 8 }], { strategy: 'weighted' }),
        gatewaySecret: TEST_SECRET,
      });
      const hits: Record<string, number> = {};
      for (let i = 0; i < 200; i++) {
        const node = (await router.request('/api/data')).headers.get('X-Omni-Node')!;
        hits[node] = (hits[node] ?? 0) + 1;
      }
      expect(hits['node-3']).toBeGreaterThan(120); // ~80% expected
      expect(hits['node-1']).toBeGreaterThan(0);
      expect(hits['node-2']).toBeGreaterThan(0);
    });

    it('backup nodes only receive traffic when every primary is down', async () => {
      const healthy = createRouterApp({
        config: cfg([{ url: url3 }, { url: url1, isBackup: true }], { strategy: 'weighted' }),
        gatewaySecret: TEST_SECRET,
      });
      for (let i = 0; i < 20; i++) {
        expect((await healthy.request('/api/data')).headers.get('X-Omni-Node')).toBe('node-1');
      }

      // Port 1 refuses connections: a hard failure, so the backup takes over at once
      const primaryDown = createRouterApp({
        config: cfg([{ url: 'http://127.0.0.1:1' }, { url: url3, isBackup: true }], { strategy: 'weighted' }),
        gatewaySecret: TEST_SECRET,
      });
      expect((await primaryDown.request('/api/data')).headers.get('X-Omni-Node')).toBe('node-2');
    });

    it('[H-7] app 500s are retried for GET but never open a node\'s circuit', async () => {
      node1ShouldFail = false;
      const router = createRouterApp({ config: cfg([url1, url3]), gatewaySecret: TEST_SECRET });

      // node 1 answers 500, node 2 has no such route (404): the GET is retried once
      const first = await router.request('/api/buggy');
      expect(first.headers.get('X-Omni-Attempts')).toBe('2');
      for (let i = 0; i < 20; i++) await router.request('/api/buggy');

      // A flood of app errors (e.g. from malformed input) must not take node 1 out of rotation
      const res = await router.request('/api/data');
      expect(res.headers.get('X-Omni-Node')).toBe('node-1');
      expect(res.headers.get('X-Omni-Attempts')).toBe('1');
    });

    it('[H-7] app 500 on a write is passed through as-is, not retried (no 3x amplification)', async () => {
      node1ShouldFail = false;
      const router = createRouterApp({ config: cfg([url1, url3]), gatewaySecret: TEST_SECRET });
      const res = await router.request('/api/buggy', { method: 'POST', headers: { 'Idempotency-Key': 'k-500' }, body: '{}' });
      expect(res.status).toBe(500);
      expect(res.headers.get('X-Omni-Attempts')).toBe('1');
      expect(((await res.json()) as any).error).toBe('app error');
    });

    it('moves traffic to the next free tier before a provider quota runs out', async () => {
      node1ShouldFail = false;
      const router = createRouterApp({
        config: cfg([{ url: url1, providerId: 'netlify', requestsPerDay: 20 }, { url: url3, providerId: 'vercel' }]),
        gatewaySecret: TEST_SECRET,
      });
      const served: string[] = [];
      for (let i = 0; i < 25; i++) {
        served.push((await router.request('/api/data')).headers.get('X-Omni-Node')!);
      }
      // Diverts at 95% of the 20/day quota: 19 on netlify, then vercel takes over without any error
      expect(served.slice(0, 19).every((n) => n === 'netlify')).toBe(true);
      expect(served.slice(19).every((n) => n === 'vercel')).toBe(true);
    });
  });
});
