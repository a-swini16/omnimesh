import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { gatewayAuth, idempotency, healthHandler } from '@omnimesh/node';

const app = new Hono();

app.use('*', gatewayAuth());
app.get('/health', healthHandler({ providerId: 'webhook-service' }));

// Idempotent webhook receiver
// Even if external payment gateway retries 5 times, OmniMesh processes it exactly once
app.post('/webhooks/payment', idempotency(), async (c) => {
  const event = await c.req.json() as any;
  const eventId = c.req.header('Idempotency-Key') || event.id;

  console.log(`[OmniMesh Webhook] Successfully processed event: ${eventId}`);

  return c.json({
    received: true,
    eventId,
    processedAt: new Date().toISOString(),
  });
});

const port = Number(process.env.PORT) || 3002;
console.log(`[OmniMesh Webhook Receiver] Running on port ${port}...`);

serve({ fetch: app.fetch, port });
