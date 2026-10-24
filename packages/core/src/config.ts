import { z } from 'zod';
import * as YAML from 'yaml';
import { ConfigValidationError } from './errors.js';

export const CandidateNodeSchema = z.union([
  z.string().url(),
  z.object({
    url: z.string().url(),
    providerId: z.string().optional(),
    weight: z.number().int().min(1).max(100).default(1),
    isBackup: z.boolean().default(false),
  }),
]);

export const OmniMeshConfigSchema = z.object({
  profile: z.enum(['no-card', 'with-card', 'custom']).default('no-card'),
  domain: z.string().min(1).default('api.yourdomain.com'),
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
      healthCheckIntervalSeconds: z.number().int().positive().default(60),
    })
    .default({
      timeoutMs: 2500,
      maxAttempts: 3,
      totalBudgetMs: 6000,
      circuitTtlMs: 30000,
      maxBufferBytes: 1048576,
      healthCheckIntervalSeconds: 60,
    }),
  pools: z
    .record(z.string(), z.array(CandidateNodeSchema))
    .default({
      '/auth': ['https://auth-service.deno.dev', 'https://auth-service.vercel.app'],
      '/api': [
        'https://core-api.koyeb.app',
        'https://core-api.onrender.com',
        'https://core-api.vercel.app',
      ],
      '/heavy': ['https://core-api.koyeb.app', 'https://core-api.onrender.com'],
      '/webhooks': ['https://webhooks.netlify.app', 'https://webhooks.vercel.app'],
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
      domain: 'api.yourdomain.com',
      router: {
        timeoutMs: 2500,
        maxAttempts: 3,
        totalBudgetMs: 6000,
        circuitTtlMs: 30000,
        maxBufferBytes: 1048576,
        healthCheckIntervalSeconds: 60,
      },
      pools: {
        '/auth': ['https://auth-service.deno.dev', 'https://auth-service.vercel.app', 'https://webhooks.netlify.app'],
        '/api': ['https://core-api.koyeb.app', 'https://core-api.onrender.com', 'https://core-api.vercel.app'],
        '/heavy': ['https://core-api.koyeb.app', 'https://core-api.onrender.com'],
        '/webhooks': ['https://webhooks.netlify.app', 'https://webhooks.vercel.app'],
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
        targets: ['https://core-api.onrender.com/health', 'https://core-api.koyeb.app/health'],
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
    domain: 'api.yourdomain.com',
    router: {
      timeoutMs: 2500,
      maxAttempts: 3,
      totalBudgetMs: 6000,
      circuitTtlMs: 30000,
      maxBufferBytes: 1048576,
      healthCheckIntervalSeconds: 60,
    },
    pools: {
      '/auth': ['https://auth-service.deno.dev', 'https://auth-service.vercel.app', 'https://oracle-tunnel.yourdomain.com'],
      '/api': ['https://oracle-tunnel.yourdomain.com', 'https://core-api.koyeb.app', 'https://core-api.onrender.com', 'https://core-api.vercel.app'],
      '/heavy': ['https://oracle-tunnel.yourdomain.com', 'https://core-api.koyeb.app'],
      '/webhooks': ['https://webhooks.netlify.app', 'https://oracle-tunnel.yourdomain.com'],
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
      targets: ['https://core-api.onrender.com/health'],
    },
    rateLimit: {
      enabled: true,
      requestsPerMinute: 120,
    },
  };
}
