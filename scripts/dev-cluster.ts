/**
 * OmniMesh Local Development Cluster
 *
 * Runs:
 * 1. Three mock compute nodes (Koyeb :4001, Render :4002, Vercel :4003)
 * 2. OmniMesh Edge Router (:8788) with auto-failover and live telemetry
 * 3. Live Web Dashboard at http://localhost:8788/_omnimesh/dashboard
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createRouterApp } from '@omnimesh/router';
import { validateOmniMeshConfig } from '@omnimesh/core';
import { gatewayAuth, healthHandler, omniErrorHandler } from '@omnimesh/node';

const GATEWAY_SECRET = process.env.GATEWAY_SECRET || 'dev-secret-omnimesh-gateway-key-32chars';
const STATUS_TOKEN = process.env.STATUS_TOKEN || 'dev-token';

const NODES = [
  { name: 'koyeb', port: 4001, alive: true },
  { name: 'render', port: 4002, alive: true },
  { name: 'vercel', port: 4003, alive: true },
];

const todos = [
  { id: '1', title: 'Federate Cloudflare & Koyeb', completed: true },
  { id: '2', title: 'Verify sub-3s auto failover', completed: true },
  { id: '3', title: 'Scale across multi-cloud free tiers', completed: false },
];

// Start 3 compute nodes
const nodeServers: any[] = [];
for (const node of NODES) {
  const app = new Hono();
  app.onError(omniErrorHandler);
  app.use('*', gatewayAuth({ secret: GATEWAY_SECRET }));

  app.use('*', async (c, next) => {
    if (!node.alive) {
      return c.text(`${node.name} simulated outage`, 502);
    }
    await next();
  });

  app.get('/health', healthHandler({ providerId: node.name }));

  app.get('/api/todos', (c) => {
    return c.json({
      success: true,
      provider: node.name,
      port: node.port,
      items: todos,
    });
  });

  app.post('/api/todos', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const newItem = {
      id: String(todos.length + 1),
      title: body.title || 'Untitled task',
      completed: false,
    };
    todos.push(newItem);
    return c.json({ success: true, provider: node.name, item: newItem }, 201);
  });

  const server = serve({ fetch: app.fetch, port: node.port });
  nodeServers.push(server);
}

// Router configuration
const config = validateOmniMeshConfig({
  domain: 'localhost',
  router: {
    timeoutMs: 1500,
    maxAttempts: 3,
    totalBudgetMs: 5000,
    circuitTtlMs: 10000,
    maxBufferBytes: 1048576,
  },
  pools: {
    '/api': NODES.map((n) => ({
      url: `http://127.0.0.1:${n.port}`,
      providerId: n.name,
      requestsPerDay: 500,
    })),
  },
  rateLimit: { enabled: false, requestsPerMinute: 120 },
});

// Create edge router with dashboard enabled
const routerApp = createRouterApp({
  config,
  gatewaySecret: GATEWAY_SECRET,
  statusToken: STATUS_TOKEN,
});

const routerServer = serve({ fetch: routerApp.fetch, port: 8788 }, () => {
  console.log(`
===================================================================
  🚀 OmniMesh Local Cluster Running!
===================================================================

  🌐 Edge Router:     http://localhost:8788
  📊 Live Dashboard:  http://localhost:8788/_omnimesh/dashboard
  🔑 Status Token:    ${STATUS_TOKEN}

  📡 Active Compute Nodes:
     • Koyeb:   http://localhost:4001 (Active)
     • Render:  http://localhost:4002 (Active)
     • Vercel:  http://localhost:4003 (Active)

  🧪 Try it in another terminal or browser:
     curl http://localhost:8788/api/todos
     curl -X POST http://localhost:8788/api/todos -H "Content-Type: application/json" -d '{"title":"Test Item"}'

===================================================================
`);
});

// Clean shutdown on Ctrl+C
process.on('SIGINT', () => {
  console.log('\nShutting down OmniMesh local cluster...');
  routerServer.close();
  nodeServers.forEach((s) => s.close());
  process.exit(0);
});
