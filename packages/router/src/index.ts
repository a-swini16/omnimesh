import { createRouterApp } from './router.js';
import { KvHealthStore } from './health-store.js';
import { runKeepAlive } from './cron.js';
import { parseOmniMeshConfigYaml, generateDefaultConfig, type OmniMeshConfig } from '@omnimesh/core';

export * from './router.js';
export * from './health-store.js';
export * from './quota-tracker.js';
export * from './dispatcher.js';
export * from './cron.js';

/**
 * Cloudflare Worker Default Export
 */
export default {
  async fetch(request: Request, env: any, ctx: any): Promise<Response> {
    const gatewaySecret = env.GATEWAY_SECRET;
    let config: OmniMeshConfig;

    if (env.OMNIMESH_CONFIG_YAML) {
      config = parseOmniMeshConfigYaml(env.OMNIMESH_CONFIG_YAML);
    } else {
      config = generateDefaultConfig(env.OMNIMESH_PROFILE || 'no-card');
    }

    const healthStore = env.OMNIMESH_KV ? new KvHealthStore(env.OMNIMESH_KV) : undefined;
    const router = createRouterApp({
      config,
      gatewaySecret,
      healthStore,
    });

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
