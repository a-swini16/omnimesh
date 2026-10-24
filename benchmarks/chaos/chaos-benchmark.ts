import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createRouterApp } from '@omnimesh/router';
import { gatewayAuth } from '@omnimesh/node';
import type { OmniMeshConfig } from '@omnimesh/core';

async function runBenchmark() {
  const SECRET = 's3cr3t_gateway_token_min_32_characters_long_for_security';
  let node1Alive = true;

  const app1 = new Hono();
  app1.use('*', gatewayAuth({ secret: SECRET }));
  app1.get('/api/ping', (c) => {
    if (!node1Alive) return c.text('node 1 dead', 500);
    return c.json({ node: 'node1' });
  });

  const app2 = new Hono();
  app2.use('*', gatewayAuth({ secret: SECRET }));
  app2.get('/api/ping', (c) => c.json({ node: 'node2' }));

  let p1: number, p2: number;
  const s1 = await new Promise<any>((resolve) => {
    const s = serve({ fetch: app1.fetch, port: 0 }, (info) => {
      p1 = info.port;
      resolve(s);
    });
  });

  const s2 = await new Promise<any>((resolve) => {
    const s = serve({ fetch: app2.fetch, port: 0 }, (info) => {
      p2 = info.port;
      resolve(s);
    });
  });

  const config: OmniMeshConfig = {
    profile: 'no-card',
    domain: 'bench.mesh.local',
    router: {
      timeoutMs: 2500,
      maxAttempts: 3,
      totalBudgetMs: 6000,
      circuitTtlMs: 30000,
      maxBufferBytes: 1048576,
      healthCheckIntervalSeconds: 60,
    },
    pools: {
      '/api': [`http://127.0.0.1:${p1}`, `http://127.0.0.1:${p2}`],
    },
    database: { mode: 'managed', primary: 'neon', connectionUrlEnv: 'DATABASE_URL' },
    cache: { provider: 'memory', urlEnv: 'REDIS_URL' },
    storage: { provider: 'supabase' },
    keepAlive: { enabled: false, intervalMinutes: 14, targets: [] },
    rateLimit: { enabled: false, requestsPerMinute: 120 },
  };

  const router = createRouterApp({ config, gatewaySecret: SECRET });

  // 1. Steady-state latency (100 requests)
  const steadyLatencies: number[] = [];
  for (let i = 0; i < 100; i++) {
    const t0 = performance.now();
    await router.request('/api/ping');
    steadyLatencies.push(performance.now() - t0);
  }

  // 2. Kill Node 1 and measure failover request
  node1Alive = false;
  const tFailoverStart = performance.now();
  const failoverRes = await router.request('/api/ping');
  const failoverDurationMs = performance.now() - tFailoverStart;

  // 3. Post-failover circuit breaker latency (100 requests skipping dead node)
  const breakerLatencies: number[] = [];
  for (let i = 0; i < 100; i++) {
    const t0 = performance.now();
    await router.request('/api/ping');
    breakerLatencies.push(performance.now() - t0);
  }

  s1.close();
  s2.close();

  // Helper stats
  const p95 = (arr: number[]) => {
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.95)].toFixed(2);
  };
  const avg = (arr: number[]) => (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2);

  const report = {
    steadyStateAvgMs: avg(steadyLatencies),
    steadyStateP95Ms: p95(steadyLatencies),
    failoverStatus: failoverRes.status,
    failoverDurationSeconds: (failoverDurationMs / 1000).toFixed(3),
    circuitBreakerAvgMs: avg(breakerLatencies),
    circuitBreakerP95Ms: p95(breakerLatencies),
    attemptsOnFailover: failoverRes.headers.get('X-Omni-Attempts'),
    servingNodeOnFailover: failoverRes.headers.get('X-Omni-Node'),
  };

  console.log(JSON.stringify(report, null, 2));
}

runBenchmark();
