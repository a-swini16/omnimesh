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
        return c.text('Primary node internal server error', 500);
      }
      return c.json({ source: 'node1-primary', message: 'Hello from Node 1' });
    });
    app1.post('/api/orders', (c) => {
      if (node1ShouldFail) {
        return c.text('Primary node crashed during order', 500);
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
    expect(res.headers.get('X-Omni-Node')).toBe(url1);
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
    expect(res.headers.get('X-Omni-Node')).toBe(url2);
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
    expect(res2.headers.get('X-Omni-Node')).toBe(url2);
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
    expect(res.headers.get('X-Omni-Node')).toBe(url3);
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
    expect(res.headers.get('X-Omni-Node')).toBe(url2);
    expect(res.headers.get('X-Omni-Attempts')).toBe('2');
  });

  it('rejects direct calls to mock backends missing X-Gateway-Secret with 403', async () => {
    const directRes = await fetch(`${url1}/api/data`);
    expect(directRes.status).toBe(403);
    const json = await directRes.json() as any;
    expect(json.code).toBe('ERR_GATEWAY_SECRET_INVALID');
  });
});
