import { Hono } from 'hono';
import type { OmniMeshConfig } from '@omnimesh/core';
import { MemoryHealthStore, type HealthStore } from './health-store.js';
import { MemoryQuotaTracker, type QuotaTracker } from './quota-tracker.js';
import { prepareBufferedRequest, fetchWithTimeout } from './dispatcher.js';

export interface RouterOptions {
  config: OmniMeshConfig;
  gatewaySecret?: string;
  healthStore?: HealthStore;
  quotaTracker?: QuotaTracker;
}

export function createRouterApp(options: RouterOptions) {
  const { config } = options;
  const healthStore = options.healthStore || new MemoryHealthStore();
  const quotaTracker = options.quotaTracker || new MemoryQuotaTracker();

  // Validate gateway secret fail-closed
  const gatewaySecret = options.gatewaySecret || config.gatewaySecret || process.env.GATEWAY_SECRET;
  if (!gatewaySecret || gatewaySecret.length < 32) {
    throw new Error(
      '[OmniMesh Security Violation] GATEWAY_SECRET must be at least 32 characters long. ' +
      'Fail-closed policy prevents running edge router without strong origin secret.'
    );
  }

  const app = new Hono();

  // Diagnostic health endpoint for the router itself
  app.get('/_omnimesh/status', async (c) => {
    const health = await healthStore.getAllNodeHealth();
    return c.json({
      status: 'active',
      profile: config.profile,
      domain: config.domain,
      routerConfig: config.router,
      nodes: health,
      timestamp: new Date().toISOString(),
    });
  });

  // Main HTTP proxy and auto-failover handler
  app.all('*', async (c) => {
    const request = c.req.raw;
    const url = new URL(request.url);
    const pathname = url.pathname;

    // 1. Resolve matching pool by longest path prefix match
    const matchedPrefix =
      Object.keys(config.pools)
        .filter((prefix) => pathname.startsWith(prefix))
        .sort((a, b) => b.length - a.length)[0] || '/api';

    const rawCandidates = config.pools[matchedPrefix] || config.pools['/api'] || [];
    if (!rawCandidates || rawCandidates.length === 0) {
      return c.json(
        {
          error: `No upstream nodes configured for path '${pathname}' in pool '${matchedPrefix}'.`,
          code: 'ERR_NO_POOL_CANDIDATES',
        },
        502
      );
    }

    // Normalize candidates to array of URLs
    const candidates: string[] = rawCandidates.map((c) =>
      typeof c === 'string' ? c : c.url
    );

    // 2. Prepare buffered request (buffer body if <= maxBufferBytes)
    const bufferedReq = await prepareBufferedRequest(
      request,
      config.router.maxBufferBytes
    );

    // 3. Inspect health store & order candidates
    const circuitTtlMs = config.router.circuitTtlMs;
    const healthyCandidates: string[] = [];
    const deadCandidates: string[] = [];

    for (const nodeUrl of candidates) {
      const isHealthy = await healthStore.isNodeHealthy(nodeUrl, circuitTtlMs);
      if (isHealthy) {
        healthyCandidates.push(nodeUrl);
      } else {
        deadCandidates.push(nodeUrl);
      }
    }

    // Try healthy candidates first; if none, fall back to dead ones as last resort
    const candidateQueue =
      healthyCandidates.length > 0
        ? [...healthyCandidates, ...deadCandidates]
        : [...deadCandidates];

    // 4. Failover Dispatch Loop
    const startTime = Date.now();
    let attempts = 0;
    const maxAttempts = Math.min(config.router.maxAttempts, candidateQueue.length);
    const totalBudgetMs = config.router.totalBudgetMs;
    let lastError: { status: number; message: string; nodeUrl: string } | null = null;

    for (const baseUrl of candidateQueue) {
      const elapsed = Date.now() - startTime;
      const remainingBudget = totalBudgetMs - elapsed;

      // Check if total budget exhausted or max attempts reached
      if (remainingBudget <= 100 || attempts >= maxAttempts) {
        break;
      }

      attempts += 1;
      const targetUrl = `${baseUrl.replace(/\/$/, '')}${pathname}${url.search}`;
      const timeoutForThisAttempt = Math.min(config.router.timeoutMs, remainingBudget);

      // Clone headers for upstream
      const upstreamHeaders = new Headers(bufferedReq.headers);
      upstreamHeaders.set('X-Forwarded-Host', url.host);
      upstreamHeaders.set('X-Forwarded-Proto', url.protocol.replace(':', ''));
      upstreamHeaders.set('X-Gateway-Secret', gatewaySecret);

      try {
        const response = await fetchWithTimeout(
          targetUrl,
          {
            method: bufferedReq.method,
            headers: upstreamHeaders,
            body: bufferedReq.bodyBuffer
              ? bufferedReq.bodyBuffer.slice(0)
              : (bufferedReq.body as any),
            redirect: 'manual',
          },
          timeoutForThisAttempt
        );

        // Treat 5xx and 429 as node failures to trigger failover
        if (response.status >= 500 || response.status === 429) {
          const reason = `HTTP_${response.status}`;
          await healthStore.markNodeDead(baseUrl, reason);
          lastError = { status: response.status, message: reason, nodeUrl: baseUrl };

          // CRITICAL SAFETY CHECK: If mutating request without Idempotency-Key, DO NOT retry!
          if (!bufferedReq.canRetry) {
            return c.json(
              {
                error: `Upstream node ${baseUrl} failed with status ${response.status}. Retry prevented to protect against duplicate writes. Attach 'Idempotency-Key' header to enable automatic failover for mutating requests.`,
                code: 'ERR_IDEMPOTENCY_REQUIRED_ON_FAILURE',
                node: baseUrl,
                attempts,
              },
              503
            );
          }

          continue; // Safe to retry next candidate
        }

        // SUCCESS! (200-499 excluding 429)
        const latency = Date.now() - startTime;
        await healthStore.markNodeHealthy(baseUrl, latency);

        // Copy response headers and attach OmniMesh telemetry
        const resHeaders = new Headers(response.headers);
        resHeaders.set('X-Omni-Node', baseUrl);
        resHeaders.set('X-Omni-Attempts', String(attempts));
        resHeaders.set('X-Omni-Latency-Ms', String(latency));

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: resHeaders,
        });
      } catch (err: any) {
        // Network timeout, connection refused, or DNS failure
        const isTimeout = err.name === 'AbortError' || err.message?.includes('aborted');
        const reason = isTimeout ? `Timeout_${timeoutForThisAttempt}ms` : `NetError: ${err.message}`;
        await healthStore.markNodeDead(baseUrl, reason);
        lastError = { status: 504, message: reason, nodeUrl: baseUrl };

        // CRITICAL SAFETY CHECK: If mutating request without Idempotency-Key, DO NOT retry!
        if (!bufferedReq.canRetry) {
          return c.json(
            {
              error: `Upstream node ${baseUrl} timed out or failed to respond. Retry prevented to protect against duplicate transactions. Attach 'Idempotency-Key' header to enable automatic failover.`,
              code: 'ERR_IDEMPOTENCY_REQUIRED_ON_TIMEOUT',
              node: baseUrl,
              attempts,
            },
            503
          );
        }

        // Safe to retry next candidate
        continue;
      }
    }

    // All attempts exhausted or budget exceeded
    const totalElapsed = Date.now() - startTime;
    return c.json(
      {
        error: 'All federated free-tier nodes are temporarily unavailable or exceeded the failover budget.',
        code: 'ERR_FAILOVER_EXHAUSTED',
        pool: matchedPrefix,
        attempts,
        totalElapsedMs: totalElapsed,
        budgetMs: totalBudgetMs,
        lastFailure: lastError,
        hint: 'OmniMesh will automatically probe healthy nodes. Check status at /_omnimesh/status.',
      },
      503
    );
  });

  return app;
}
