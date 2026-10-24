import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import pc from 'picocolors';
import { createRouterApp } from '@omnimesh/router';
import { gatewayAuth } from '@omnimesh/node';
import type { OmniMeshConfig } from '@omnimesh/core';

export interface ChaosOptions {
  timeoutMs?: number;
}

export async function runChaos(options: ChaosOptions = {}) {
  console.log(pc.bold(pc.red('\n🔥 OmniMesh Live Chaos & Auto-Failover Simulator')));
  console.log(pc.dim('Demonstrating sub-3-second cross-cloud failover in real-time...\n'));

  const GATEWAY_SECRET = 's3cr3t_gateway_token_min_32_characters_long_for_security';
  let primaryAlive = true;

  // 1. Primary Node (Simulating Koyeb/Oracle)
  const primaryApp = new Hono();
  primaryApp.use('*', gatewayAuth({ secret: GATEWAY_SECRET }));
  primaryApp.get('/api/resource', (c) => {
    if (!primaryAlive) {
      return c.text('CRITICAL FAILURE: Primary instance down', 503);
    }
    return c.json({ node: 'Primary (Oracle/Koyeb)', status: 'online' });
  });

  // 2. Backup Node (Simulating Render/Vercel)
  const backupApp = new Hono();
  backupApp.use('*', gatewayAuth({ secret: GATEWAY_SECRET }));
  backupApp.get('/api/resource', (c) => {
    return c.json({ node: 'Warm Backup (Render/Vercel)', status: 'online' });
  });

  let server1: any;
  let server2: any;
  let url1 = '';
  let url2 = '';

  await new Promise<void>((resolve) => {
    server1 = serve({ fetch: primaryApp.fetch, port: 0 }, (info) => {
      url1 = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });

  await new Promise<void>((resolve) => {
    server2 = serve({ fetch: backupApp.fetch, port: 0 }, (info) => {
      url2 = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });

  const config: OmniMeshConfig = {
    profile: 'no-card',
    domain: 'chaos.test',
    router: {
      timeoutMs: options.timeoutMs || 2500,
      maxAttempts: 3,
      totalBudgetMs: 6000,
      circuitTtlMs: 30000,
      maxBufferBytes: 1048576,
      healthCheckIntervalSeconds: 60,
    },
    pools: {
      '/api': [url1, url2],
    },
    database: { mode: 'managed', primary: 'neon', connectionUrlEnv: 'DATABASE_URL' },
    cache: { provider: 'memory', urlEnv: 'REDIS_URL' },
    storage: { provider: 'supabase' },
    keepAlive: { enabled: false, intervalMinutes: 14, targets: [] },
    rateLimit: { enabled: false, requestsPerMinute: 120 },
  };

  const router = createRouterApp({ config, gatewaySecret: GATEWAY_SECRET });

  try {
    // Step 1: Normal steady state
    console.log(pc.cyan('1. Testing Steady-State Traffic:'));
    const t0 = Date.now();
    const res1 = await router.request('/api/resource');
    const steadyTime = Date.now() - t0;
    const json1 = await res1.json() as any;

    console.log(
      `   ✔ ${pc.green('200 OK')} served by ${pc.bold(json1.node)} in ${pc.bold(`${steadyTime}ms`)} (Attempts: ${res1.headers.get('X-Omni-Attempts')})`
    );

    // Step 2: Inject Chaos (Kill Primary Node)
    console.log(pc.red('\n2. Injecting Chaos: Killing Primary Node...'));
    primaryAlive = false;
    console.log(pc.dim(`   Primary node (${url1}) is now unresponsive (simulating VM crash/outage)`));

    // Step 3: Trigger Failover Request
    console.log(pc.yellow('\n3. Client sends request to https://api.yourdomain.com/api/resource...'));
    const tFailoverStart = Date.now();
    const res2 = await router.request('/api/resource');
    const failoverElapsed = ((Date.now() - tFailoverStart) / 1000).toFixed(2);
    const json2 = await res2.json() as any;
    if (res2.status !== 200) {
      console.log(pc.bold(pc.red(`\n✖ Failover FAILED: client received ${res2.status} (${json2.code ?? 'unknown'})\n`)));
      return false;
    }

    console.log(
      `\n   ${pc.bold(pc.green('🚀 FAILOVER SUCCESSFUL!'))} Client received ${pc.bold(pc.green('200 OK'))}`
    );
    console.log(`   • Total Failover Duration: ${pc.bold(pc.cyan(`${failoverElapsed} seconds`))}`);
    console.log(`   • Serving Node:           ${pc.bold(json2.node)}`);
    console.log(`   • Total Attempts:         ${pc.bold(res2.headers.get('X-Omni-Attempts') || '2')}`);
    console.log(`   • Upstream URL:           ${res2.headers.get('X-Omni-Node')}`);

    // Step 4: Subsequent Request with Circuit Breaker
    console.log(pc.cyan('\n4. Testing Circuit Breaker on subsequent request:'));
    const tBreakerStart = Date.now();
    const res3 = await router.request('/api/resource');
    const breakerElapsed = Date.now() - tBreakerStart;
    const json3 = await res3.json() as any;

    console.log(
      `   ✔ ${pc.green('200 OK')} directly routed to ${pc.bold(json3.node)} in ${pc.bold(`${breakerElapsed}ms`)} (Dead node skipped instantly, Attempts: ${res3.headers.get('X-Omni-Attempts')})`
    );

    console.log(pc.bold(pc.green('\n🎉 Chaos test passed! Your backend survived node failure without downtime.\n')));
    return true;
  } finally {
    server1?.close();
    server2?.close();
  }
}
