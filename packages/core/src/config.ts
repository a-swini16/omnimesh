import { z } from 'zod';
import * as YAML from 'yaml';
import { ConfigValidationError } from './errors.js';

/**
 * Generated example URLs use the reserved `.invalid` TLD (RFC 2606): it never resolves, so nobody
 * can own a placeholder host and receive the gateway secret before the developer fills in real URLs.
 */
export const PLACEHOLDER_HOST_SUFFIX = '.replace-me.invalid';

export function isPlaceholderUrl(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith('.invalid');
  } catch {
    return false;
  }
}

export const CandidateNodeSchema = z.union([
  z.string().url(),
  z.object({
    url: z.string().url(),
    providerId: z.string().optional(),
    weight: z.number().int().min(1).max(100).default(1),
    isBackup: z.boolean().default(false),
    // Free-tier request quota for this provider account; the router moves traffic away at 95%
    requestsPerDay: z.number().int().positive().optional(),
    requestsPerMonth: z.number().int().positive().optional(),
  }),
]);

export const OmniMeshConfigSchema = z.object({
  profile: z.enum(['no-card', 'with-card', 'custom']).default('no-card'),
  domain: z.string().min(1).default('api.replace-me.invalid'),
  gatewaySecret: z
    .string()
    .min(32, 'Gateway secret must be at least 32 characters for fail-closed security')
    .optional(),
  router: z
    .object({
      timeoutMs: z.number().int().positive().default(2500),
      maxAttempts: z.number().int().min(1).max(10).default(3),
      totalBudgetMs: z.number().int().positive().default(6000),
      circuitTtlMs: z.number().int().positive().default(30000),
      maxBufferBytes: z.number().int().positive().default(1048576), // 1MB safe payload buffer
      // Hard cap on any request body, streamed or buffered (default 10 MB); larger bodies get 413
      maxBodyBytes: z.number().int().positive().optional(),
      healthCheckIntervalSeconds: z.number().int().positive().default(60),
      // priority: config order (failover only). weighted: spread load across healthy non-backup nodes by weight.
      strategy: z.enum(['priority', 'weighted']).optional(),
      // Deprecated and ignored: app-level 5xx no longer open a circuit (only timeouts, connection
      // errors, 429 and 502-504 do). Kept so existing configs still validate.
      failureThreshold: z.number().int().min(1).max(20).optional(),
    })
    .default({
      timeoutMs: 2500,
      maxAttempts: 3,
      totalBudgetMs: 6000,
      circuitTtlMs: 30000,
      maxBufferBytes: 1048576,
      healthCheckIntervalSeconds: 60,
    }),
  // Pool for paths that match no prefix. Defaults to '/api' (architecture §5); null answers 404 instead.
  defaultPool: z.string().nullable().optional(),
  pools: z
    .record(z.string(), z.array(CandidateNodeSchema))
    .default({
      '/auth': ['https://auth-service.deno.dev.replace-me.invalid', 'https://auth-service.vercel.app.replace-me.invalid'],
      '/api': [
        'https://core-api.koyeb.app.replace-me.invalid',
        'https://core-api.onrender.com.replace-me.invalid',
        'https://core-api.vercel.app.replace-me.invalid',
      ],
      '/heavy': ['https://core-api.koyeb.app.replace-me.invalid', 'https://core-api.onrender.com.replace-me.invalid'],
      '/webhooks': ['https://webhooks.netlify.app.replace-me.invalid', 'https://webhooks.vercel.app.replace-me.invalid'],
    }),
  database: z
    .object({
      mode: z.enum(['managed', 'self-hosted']).default('managed'),
      primary: z.string().default('neon'),
      replica: z.string().optional(),
      connectionUrlEnv: z.string().default('DATABASE_URL'),
    })
    .default({
      mode: 'managed',
      primary: 'neon',
      connectionUrlEnv: 'DATABASE_URL',
    }),
  cache: z
    .object({
      provider: z.enum(['upstash', 'redis', 'memory']).default('upstash'),
      urlEnv: z.string().default('REDIS_URL'),
      tokenEnv: z.string().optional(),
    })
    .default({
      provider: 'upstash',
      urlEnv: 'REDIS_URL',
    }),
  storage: z
    .object({
      provider: z.enum(['supabase', 'r2', 'none']).default('supabase'),
    })
    .default({
      provider: 'supabase',
    }),
  keepAlive: z
    .object({
      enabled: z.boolean().default(false),
      intervalMinutes: z.number().int().min(1).max(60).default(14),
      targets: z.array(z.string().url()).default([]),
    })
    .default({
      enabled: false,
      intervalMinutes: 14,
      targets: [],
    }),
  rateLimit: z
    .object({
      enabled: z.boolean().default(true),
      requestsPerMinute: z.number().int().positive().default(120),
    })
    .default({
      enabled: true,
      requestsPerMinute: 120,
    }),
});

export type OmniMeshConfig = z.infer<typeof OmniMeshConfigSchema>;

export function validateOmniMeshConfig(input: unknown): OmniMeshConfig {
  const result = OmniMeshConfigSchema.safeParse(input);
  if (!result.success) {
    throw new ConfigValidationError(
      `Invalid OmniMesh configuration: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
      result.error.issues
    );
  }
  return result.data;
}

export function parseOmniMeshConfigYaml(yamlString: string): OmniMeshConfig {
  try {
    const raw = YAML.parse(yamlString);
    return validateOmniMeshConfig(raw);
  } catch (err: unknown) {
    if (err instanceof ConfigValidationError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigValidationError(`Failed to parse YAML config: ${message}`);
  }
}

export function stringifyOmniMeshConfigYaml(config: OmniMeshConfig): string {
  return YAML.stringify(config, { indent: 2 });
}

export function generateDefaultConfig(profile: 'no-card' | 'with-card' = 'no-card'): OmniMeshConfig {
  if (profile === 'no-card') {
    return {
      profile: 'no-card',
      domain: 'api.replace-me.invalid',
      router: {
        timeoutMs: 2500,
        maxAttempts: 3,
        totalBudgetMs: 6000,
        circuitTtlMs: 30000,
        maxBufferBytes: 1048576,
        healthCheckIntervalSeconds: 60,
      },
      pools: {
        '/auth': ['https://auth-service.deno.dev.replace-me.invalid', 'https://auth-service.vercel.app.replace-me.invalid', 'https://webhooks.netlify.app.replace-me.invalid'],
        '/api': ['https://core-api.koyeb.app.replace-me.invalid', 'https://core-api.onrender.com.replace-me.invalid', 'https://core-api.vercel.app.replace-me.invalid'],
        '/heavy': ['https://core-api.koyeb.app.replace-me.invalid', 'https://core-api.onrender.com.replace-me.invalid'],
        '/webhooks': ['https://webhooks.netlify.app.replace-me.invalid', 'https://webhooks.vercel.app.replace-me.invalid'],
      },
      database: {
        mode: 'managed',
        primary: 'neon',
        connectionUrlEnv: 'DATABASE_URL',
      },
      cache: {
        provider: 'upstash',
        urlEnv: 'REDIS_URL',
      },
      storage: {
        provider: 'supabase',
      },
      keepAlive: {
        enabled: true,
        intervalMinutes: 14,
        targets: ['https://core-api.onrender.com.replace-me.invalid/health', 'https://core-api.koyeb.app.replace-me.invalid/health'],
      },
      rateLimit: {
        enabled: true,
        requestsPerMinute: 120,
      },
    };
  }

  // with-card profile (Includes Oracle ARM VM, R2)
  return {
    profile: 'with-card',
    domain: 'api.replace-me.invalid',
    router: {
      timeoutMs: 2500,
      maxAttempts: 3,
      totalBudgetMs: 6000,
      circuitTtlMs: 30000,
      maxBufferBytes: 1048576,
      healthCheckIntervalSeconds: 60,
    },
    pools: {
      '/auth': ['https://auth-service.deno.dev.replace-me.invalid', 'https://auth-service.vercel.app.replace-me.invalid', 'https://oracle-tunnel.replace-me.invalid'],
      '/api': ['https://oracle-tunnel.replace-me.invalid', 'https://core-api.koyeb.app.replace-me.invalid', 'https://core-api.onrender.com.replace-me.invalid', 'https://core-api.vercel.app.replace-me.invalid'],
      '/heavy': ['https://oracle-tunnel.replace-me.invalid', 'https://core-api.koyeb.app.replace-me.invalid'],
      '/webhooks': ['https://webhooks.netlify.app.replace-me.invalid', 'https://oracle-tunnel.replace-me.invalid'],
    },
    database: {
      mode: 'self-hosted',
      primary: 'oracle',
      replica: 'neon',
      connectionUrlEnv: 'DATABASE_URL',
    },
    cache: {
      provider: 'upstash',
      urlEnv: 'REDIS_URL',
    },
    storage: {
      provider: 'r2',
    },
    keepAlive: {
      enabled: false,
      intervalMinutes: 14,
      targets: ['https://core-api.onrender.com.replace-me.invalid/health'],
    },
    rateLimit: {
      enabled: true,
      requestsPerMinute: 120,
    },
  };
}
