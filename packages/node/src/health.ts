import type { Context } from 'hono';

export interface HealthCheckOptions {
  providerId?: string;
  nodeId?: string;
  checkDatabase?: () => Promise<boolean>;
  checkRedis?: () => Promise<boolean>;
}

export function healthHandler(options: HealthCheckOptions = {}) {
  const startTime = Date.now();
  const providerId = options.providerId || process.env.OMNIMESH_PROVIDER || 'local';
  const nodeId = options.nodeId || process.env.OMNIMESH_NODE_ID || `node-${Math.random().toString(36).substring(2, 7)}`;

  return async function handleHealth(c: Context) {
    let dbStatus = 'not_configured';
    let redisStatus = 'not_configured';
    let isHealthy = true;

    if (options.checkDatabase) {
      try {
        const ok = await options.checkDatabase();
        dbStatus = ok ? 'connected' : 'error';
        if (!ok) isHealthy = false;
      } catch (err: any) {
        dbStatus = `error: ${err.message}`;
        isHealthy = false;
      }
    }

    if (options.checkRedis) {
      try {
        const ok = await options.checkRedis();
        redisStatus = ok ? 'connected' : 'error';
        if (!ok) isHealthy = false;
      } catch (err: any) {
        redisStatus = `error: ${err.message}`;
        if (!options.checkDatabase) isHealthy = false; // Degraded
      }
    }

    const payload = {
      status: isHealthy ? 'healthy' : 'degraded',
      provider: providerId,
      nodeId,
      uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString(),
      services: {
        database: dbStatus,
        redis: redisStatus,
      },
      memory: typeof process !== 'undefined' && process.memoryUsage ? process.memoryUsage() : undefined,
    };

    return c.json(payload, isHealthy ? 200 : 503);
  };
}
