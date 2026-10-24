import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { gatewayAuth, idempotency, healthHandler, omniErrorHandler } from '@omnimesh/node';

const app = new Hono();
app.onError(omniErrorHandler);

// 1. Enforce Fail-Closed Gateway Authentication (blocks direct bypass)
app.use('*', gatewayAuth());

// 2. Health Endpoint for Edge Router Probes & GitHub Keep-Alive
app.get('/health', healthHandler());

// 3. Idempotent API endpoints
const items = [
  { id: '1', title: 'Federate Cloudflare & Koyeb', completed: true },
  { id: '2', title: 'Verify sub-3s auto failover', completed: true },
];

app.get('/api/todos', (c) => {
  return c.json({
    data: items,
    provider: process.env.OMNIMESH_PROVIDER || 'local-node',
  });
});

app.post('/api/todos', idempotency(), async (c) => {
  const body = await c.req.json() as { title: string };
  const newItem = {
    id: String(items.length + 1),
    title: body.title,
    completed: false,
  };
  items.push(newItem);
  return c.json(newItem, 201);
});

const port = Number(process.env.PORT) || 3000;
console.log(`[OmniMesh Compute Node] Running on port ${port}...`);

serve({ fetch: app.fetch, port });
