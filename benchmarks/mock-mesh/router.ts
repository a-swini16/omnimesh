/** The real OmniMesh router on the Node adapter, in front of the mock mesh. */
import { serve } from '@hono/node-server';
import { createRouterApp } from '@omnimesh/router';
import { validateOmniMeshConfig } from '@omnimesh/core';

const PROVIDERS = ['koyeb', 'render', 'vercel', 'netlify', 'deno'];
const koyebQuota = process.env.KOYEB_DAILY_QUOTA ? Number(process.env.KOYEB_DAILY_QUOTA) : undefined;

const config = validateOmniMeshConfig({
  domain: 'localhost',
  router: { timeoutMs: 2500, maxAttempts: 3, totalBudgetMs: 6000, circuitTtlMs: 30000, maxBufferBytes: 1048576 },
  pools: {
    '/api': PROVIDERS.map((providerId, i) => ({
      url: `http://127.0.0.1:${4101 + i}`,
      providerId,
      ...(providerId === 'koyeb' && koyebQuota ? { requestsPerDay: koyebQuota } : {}),
    })),
  },
  // All load comes from one IP here, so the per-IP limiter would only measure itself
  rateLimit: { enabled: false, requestsPerMinute: 120 },
});

const app = createRouterApp({ config });
serve({ fetch: app.fetch, port: 8788 }, () => console.log('router on :8788'));
