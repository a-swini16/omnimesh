import { createRouterApp } from './router.js';
import { KvHealthStore } from './health-store.js';
import { runKeepAlive } from './cron.js';
import { checkTargets, recordDownServers, runChecks } from './checks.js';
import { CloudflareRateLimiter } from './rate-limiter.js';
import { parseOmniMeshConfigYaml } from '@omnimesh/core';

export * from './router.js';
export * from './health-store.js';
export * from './quota-tracker.js';
export * from './dispatcher.js';
export * from './cron.js';
export * from './rate-limiter.js';
export * from './telemetry.js';
export * from './checks.js';

// One router per isolate: rebuilding it per request would reset the in-memory circuit breaker
// and re-parse the config inside the 10ms CPU budget
let cached: { key: string; app: ReturnType<typeof createRouterApp> } | null = null;
let warnedNoSharedLimiter = false;

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

    const key = `${env.OMNIMESH_CONFIG_YAML}\n${env.GATEWAY_SECRET}\n${env.OMNIMESH_APP ?? ''}`;
    if (!cached || cached.key !== key) {
      const config = parseOmniMeshConfigYaml(env.OMNIMESH_CONFIG_YAML);
      if (config.rateLimit.enabled && !env.RATE_LIMITER && !warnedNoSharedLimiter) {
        warnedNoSharedLimiter = true;
        console.warn(
          '[OmniMesh] rateLimit is enabled but the RATE_LIMITER binding is missing, so limits are counted ' +
          'per isolate and a distributed bot gets far more requests. Add it from packages/router/wrangler.toml.example.'
        );
      }
      cached = {
        key,
        app: createRouterApp({
          config,
          gatewaySecret: env.GATEWAY_SECRET,
          statusToken: env.OMNIMESH_STATUS_TOKEN,
          healthStore: env.OMNIMESH_KV ? new KvHealthStore(env.OMNIMESH_KV) : undefined,
          rateLimiter: env.RATE_LIMITER ? new CloudflareRateLimiter(env.RATE_LIMITER) : undefined,
          appInfo: env.OMNIMESH_APP,
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

    // Health checks every few minutes, shared through KV so the dashboard shows the same answer
    // whichever router instance serves it. One KV write per run keeps well inside the free 1,000/day.
    if (!env.OMNIMESH_CONFIG_YAML || !env.GATEWAY_SECRET || env.GATEWAY_SECRET.length < 32 || !env.OMNIMESH_KV) return;
    const config = parseOmniMeshConfigYaml(env.OMNIMESH_CONFIG_YAML);
    const store = new KvHealthStore(env.OMNIMESH_KV, { readCacheMs: 0 });
    const previous = await store.getChecks(true);
    const { snapshot, checked } = await runChecks({
      targets: checkTargets(config),
      gatewaySecret: env.GATEWAY_SECRET,
      trigger: 'schedule',
      previous,
      includeSleepers: config.keepAlive.enabled,
    });
    await store.saveChecks(snapshot);
    await recordDownServers(store, previous, checked);
  },
};
