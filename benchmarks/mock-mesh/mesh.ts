/**
 * Five mock providers for local load and chaos tests, so nothing burns real free-tier quota.
 * All run in one process and share one idempotency store and one orders table, standing in for
 * the shared Upstash Redis and Postgres that real nodes use.
 *
 * Control a node (gateway secret required):  POST /__mock/mode  {"kind":"ok"}
 *   kinds: ok | latency {ms} (delay after the handler ran, i.e. "wrote, then timed out")
 *          | hang (never answers) | status {status} | drop (reset the connection)
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { gatewayAuth, idempotency, MemoryIdempotencyStore, healthHandler } from '@omnimesh/node';

const SECRET = process.env.GATEWAY_SECRET;
if (!SECRET) throw new Error('GATEWAY_SECRET is required');

export const PROVIDERS = ['koyeb', 'render', 'vercel', 'netlify', 'deno'] as const;
export const BASE_PORT = 4101;

type Mode = { kind: 'ok' | 'latency' | 'hang' | 'status' | 'drop'; ms?: number; status?: number };

const sharedStore = new MemoryIdempotencyStore(200_000);
const orders = new Map<string, number>(); // idempotency key -> times the order was executed

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const never = () => new Promise<never>(() => {});

function createNode(name: string) {
  let mode: Mode = { kind: 'ok' };
  let served = 0;
  const app = new Hono();

  app.use('*', gatewayAuth({ secret: SECRET }));
  app.get('/health', healthHandler({ providerId: name }));
  app.post('/__mock/mode', async (c) => {
    mode = await c.req.json();
    return c.json({ name, mode });
  });
  app.get('/__mock/stats', (c) => {
    const counts = [...orders.values()];
    return c.json({
      name,
      served,
      mode,
      orders: { executions: counts.reduce((a, b) => a + b, 0), distinctKeys: counts.length, duplicates: counts.filter((n) => n > 1).length },
    });
  });

  app.use('/api/*', async (c, next) => {
    if (mode.kind === 'hang') return never();
    if (mode.kind === 'status') return c.text(`${name} failing`, (mode.status ?? 500) as any);
    if (mode.kind === 'drop') {
      (c.env as any).incoming.socket.destroy();
      return never();
    }
    await next();
    if (mode.kind === 'latency') await sleep(mode.ms ?? 0);
    served++;
  });

  app.get('/api/data', (c) => c.json({ node: name }));

  // A typical app endpoint: returns the caller's own data and sets no cache headers
  app.get('/api/me', (c) => c.json({ user: (c.req.header('authorization') || '').replace('Bearer ', ''), node: name }));

  // Mirrors examples/rest-api: parses JSON without guarding against malformed input
  app.post('/api/items', async (c) => c.json({ received: await c.req.json(), node: name }, 201));

  app.post('/api/orders', idempotency({ store: sharedStore }), (c) => {
    const key = c.req.header('idempotency-key') || 'no-key';
    orders.set(key, (orders.get(key) ?? 0) + 1);
    return c.json({ orderId: key, node: name }, 201);
  });

  return app;
}

PROVIDERS.forEach((name, i) => {
  serve({ fetch: createNode(name).fetch, port: BASE_PORT + i });
});
console.log(`mock mesh: ${PROVIDERS.map((p, i) => `${p}:${BASE_PORT + i}`).join(' ')}`);
