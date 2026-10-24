import { createRouterApp } from './router.js';
import { KvHealthStore } from './health-store.js';
import { runKeepAlive } from './cron.js';
import { CloudflareRateLimiter } from './rate-limiter.js';
import { parseOmniMeshConfigYaml } from '@omnimesh/core';

export * from './router.js';
export * from './health-store.js';
export * from './quota-tracker.js';
export * from './dispatcher.js';
export * from './cron.js';
export * from './rate-limiter.js';

// One router per isolate: rebuilding it per request would reset the in-memory circuit breaker
// and re-parse the config inside the 10ms CPU budget
let cached: { key: string; app: ReturnType<typeof createRouterApp> } | null = null;

/**
 * Cloudflare Worker Default Export
 */
export default {
  async fetch(request: Request, env: any, ctx: any): Promise<Response> {
    // Fail closed: the built-in defaults point at placeholder hostnames we do not own,
    // and the router would send them the gateway secret
    if (!env.OMNIMESH_CONFIG_YAML) {
      return new Response(JSON.stringify({ error: 'Router not configured', code: 'ERR_NO_CONFIG' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const key = `${env.OMNIMESH_CONFIG_YAML}\n${env.GATEWAY_SECRET}`;
    if (!cached || cached.key !== key) {
      const config = parseOmniMeshConfigYaml(env.OMNIMESH_CONFIG_YAML);
      cached = {
        key,
        app: createRouterApp({
          config,
          gatewaySecret: env.GATEWAY_SECRET,
          statusToken: env.OMNIMESH_STATUS_TOKEN,
          healthStore: env.OMNIMESH_KV ? new KvHealthStore(env.OMNIMESH_KV) : undefined,
          rateLimiter: env.RATE_LIMITER ? new CloudflareRateLimiter(env.RATE_LIMITER) : undefined,
        }),
      };
    }
    const router = cached.app;

    return router.fetch(request, env, ctx);
  },

  async scheduled(event: any, env: any, _ctx: any): Promise<void> {
    const targets = env.KEEP_ALIVE_TARGETS ? env.KEEP_ALIVE_TARGETS.split(',') : [];
    if (targets.length > 0) {
      await runKeepAlive({
        targets,
        gatewaySecret: env.GATEWAY_SECRET,
      });
    }
  },
};
