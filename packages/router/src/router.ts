import { Hono } from 'hono';
import type { OmniMeshConfig } from '@omnimesh/core';
import { MemoryHealthStore, type HealthStore } from './health-store.js';
import { MemoryQuotaTracker, type QuotaTracker } from './quota-tracker.js';
import { prepareBufferedRequest, fetchWithTimeout, BodyTooLargeError } from './dispatcher.js';
import { MemoryRateLimiter, type RateLimiter } from './rate-limiter.js';

export interface RouterOptions {
  config: OmniMeshConfig;
  gatewaySecret?: string;
  healthStore?: HealthStore;
  quotaTracker?: QuotaTracker;
  rateLimiter?: RateLimiter;
  /** Bearer token for /_omnimesh/status. Without it the endpoint returns 404. */
  statusToken?: string;
  /** Random source for weighted selection (injectable for tests). */
  random?: () => number;
}

// Headers that describe a single hop and must not be forwarded, plus ones the router owns
const STRIPPED_REQUEST_HEADERS = [
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer',
  'host', 'x-gateway-secret', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip',
];

interface Candidate {
  url: string;
  label: string;
  providerId?: string;
  weight: number;
  isBackup: boolean;
}

// Statuses that mean the node or its provider is down/out of quota, not that one endpoint is buggy
const HARD_FAILURE_STATUSES = new Set([429, 502, 503, 504]);

/**
 * Weighted random order without replacement (Efraimidis-Spirakis): each node gets
 * key = u^(1/weight) and higher keys go first, so a weight-4 node leads ~4x as often as weight-1.
 */
export function weightedOrder<T extends { weight: number }>(nodes: T[], random: () => number = Math.random): T[] {
  return nodes
    .map((n) => ({ n, key: Math.pow(random(), 1 / n.weight) }))
    .sort((a, b) => b.key - a.key)
    .map((x) => x.n);
}

function readEnv(name: string): string | undefined {
  return typeof process !== 'undefined' ? process.env?.[name] : undefined;
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < Math.max(ab.length, bb.length); i++) {
    diff |= (ab[i % ab.length] ?? 0) ^ (bb[i % bb.length] ?? 0);
  }
  return diff === 0;
}

/** A path belongs to a pool only on a segment boundary: /api and /api/x match /api, /apiary does not. */
export function matchPool(pathname: string, prefixes: string[]): string | undefined {
  return prefixes
    .filter((p) => pathname === p || pathname.startsWith(p.endsWith('/') ? p : `${p}/`))
    .sort((a, b) => b.length - a.length)[0];
}

export function createRouterApp(options: RouterOptions) {
  const { config } = options;
  const healthStore = options.healthStore || new MemoryHealthStore();
  const quotaTracker = options.quotaTracker || new MemoryQuotaTracker();
  const rateLimiter = options.rateLimiter || new MemoryRateLimiter(config.rateLimit.requestsPerMinute, 60_000);
  const statusToken = options.statusToken || readEnv('OMNIMESH_STATUS_TOKEN');
  const random = options.random || Math.random;
  const strategy = config.router.strategy ?? 'priority';
  const failureThreshold = config.router.failureThreshold ?? 3;
  // Consecutive soft (app-level 5xx) failures per node, counted per router instance
  const softFailures = new Map<string, number>();

  // Validate gateway secret fail-closed
  const gatewaySecret = options.gatewaySecret || config.gatewaySecret || readEnv('GATEWAY_SECRET');
  if (!gatewaySecret || gatewaySecret.length < 32) {
    throw new Error(
      '[OmniMesh Security Violation] GATEWAY_SECRET must be at least 32 characters long. ' +
      'Fail-closed policy prevents running edge router without strong origin secret.'
    );
  }

  // Resolve pools once and refuse to send the gateway secret over plain HTTP to a remote host
  const pools: Record<string, Candidate[]> = {};
  for (const [prefix, nodes] of Object.entries(config.pools)) {
    pools[prefix] = nodes.map((n, i) => {
      const url = typeof n === 'string' ? n : n.url;
      const providerId = typeof n === 'string' ? undefined : n.providerId;
      const weight = typeof n === 'string' ? 1 : n.weight ?? 1;
      const isBackup = typeof n === 'string' ? false : n.isBackup ?? false;
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && !isLoopback(parsed.hostname)) {
        throw new Error(`[OmniMesh Security Violation] Upstream ${parsed.host} in pool ${prefix} must use https://`);
      }
      return { url: url.replace(/\/$/, ''), providerId, weight, isBackup, label: providerId || `node-${i + 1}` };
    });
  }
  const prefixes = Object.keys(pools);

  const app = new Hono();

  // Diagnostic endpoint: lists internal node URLs, so it is only served to operators holding the status token
  app.get('/_omnimesh/status', async (c) => {
    const auth = c.req.header('authorization') || '';
    if (!statusToken || !timingSafeEqual(auth, `Bearer ${statusToken}`)) {
      return c.json({ error: 'Not Found' }, 404);
    }
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
    const clientIp = request.headers.get('cf-connecting-ip') || 'unknown';

    // 0. Per-client rate limit, so one bot cannot burn the whole free-tier quota
    if (config.rateLimit.enabled) {
      const { allowed, retryAfterSeconds } = await rateLimiter.hit(clientIp);
      if (!allowed) {
        c.header('Retry-After', String(retryAfterSeconds));
        return c.json({ error: 'Too Many Requests', code: 'ERR_RATE_LIMITED' }, 429);
      }
    }

    // 1. Resolve matching pool by longest segment-aligned prefix
    const matchedPrefix = matchPool(pathname, prefixes) ?? (pools['/api'] ? '/api' : undefined);
    const candidates = matchedPrefix ? pools[matchedPrefix] : [];
    if (!candidates || candidates.length === 0) {
      return c.json({ error: 'No upstream configured for this path.', code: 'ERR_NO_POOL_CANDIDATES' }, 502);
    }

    // 2. Prepare buffered request (buffer body if <= maxBufferBytes)
    let bufferedReq;
    try {
      bufferedReq = await prepareBufferedRequest(request, config.router.maxBufferBytes);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        return c.json({ error: 'Request body too large.', code: 'ERR_BODY_TOO_LARGE' }, 413);
      }
      return c.json({ error: 'Could not read request body.', code: 'ERR_BAD_REQUEST_BODY' }, 400);
    }

    // 3. Inspect health store & quotas, order candidates
    const circuitTtlMs = config.router.circuitTtlMs;
    const healthyCandidates: Candidate[] = [];
    const deadCandidates: Candidate[] = [];

    for (const node of candidates) {
      const isHealthy =
        (await healthStore.isNodeHealthy(node.url, circuitTtlMs)) &&
        (!node.providerId || (await quotaTracker.canAcceptTraffic(node.providerId)));
      (isHealthy ? healthyCandidates : deadCandidates).push(node);
    }

    // Healthy primaries (by priority or weight), then healthy backups, then open circuits as a last resort
    const primaries = healthyCandidates.filter((n) => !n.isBackup);
    const backups = healthyCandidates.filter((n) => n.isBackup);
    const candidateQueue = [
      ...(strategy === 'weighted' ? weightedOrder(primaries, random) : primaries),
      ...backups,
      ...deadCandidates,
    ];

    // 4. Failover Dispatch Loop
    const startTime = Date.now();
    let attempts = 0;
    const maxAttempts = Math.min(config.router.maxAttempts, candidateQueue.length);
    const totalBudgetMs = config.router.totalBudgetMs;
    let lastFailure: string | null = null;

    for (const node of candidateQueue) {
      const elapsed = Date.now() - startTime;
      const remainingBudget = totalBudgetMs - elapsed;

      // Check if total budget exhausted or max attempts reached
      if (remainingBudget <= 100 || attempts >= maxAttempts) {
        break;
      }

      attempts += 1;
      const targetUrl = `${node.url}${pathname}${url.search}`;
      const timeoutForThisAttempt = Math.min(config.router.timeoutMs, remainingBudget);

      const upstreamHeaders = new Headers(bufferedReq.headers);
      for (const h of STRIPPED_REQUEST_HEADERS) upstreamHeaders.delete(h);
      upstreamHeaders.set('X-Forwarded-Host', url.host);
      upstreamHeaders.set('X-Forwarded-Proto', url.protocol.replace(':', ''));
      upstreamHeaders.set('X-Forwarded-For', clientIp);
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
            // Required by Node's fetch when streaming a request body
            ...(bufferedReq.body && !bufferedReq.bodyBuffer ? { duplex: 'half' } : {}),
          } as RequestInit,
          timeoutForThisAttempt
        );

        // Treat 5xx and 429 as node failures to trigger failover
        if (response.status >= 500 || response.status === 429) {
          // Release the connection; we are not going to read this body
          await response.body?.cancel().catch(() => {});
          lastFailure = `HTTP_${response.status}`;
          // A plain 500 is often one buggy endpoint: only open the circuit after repeated failures,
          // otherwise a single bad route could mark every node in the pool dead
          const failures = (softFailures.get(node.url) ?? 0) + 1;
          if (HARD_FAILURE_STATUSES.has(response.status) || failures >= failureThreshold) {
            softFailures.delete(node.url);
            await healthStore.markNodeDead(node.url, lastFailure);
          } else {
            softFailures.set(node.url, failures);
          }

          // CRITICAL SAFETY CHECK: If mutating request without Idempotency-Key, DO NOT retry!
          if (!bufferedReq.canRetry) {
            return c.json(
              {
                error: `Upstream failed with status ${response.status}. Retry prevented to protect against duplicate writes. Attach 'Idempotency-Key' header to enable automatic failover for mutating requests.`,
                code: 'ERR_IDEMPOTENCY_REQUIRED_ON_FAILURE',
                node: node.label,
                attempts,
              },
              503
            );
          }

          continue; // Safe to retry next candidate
        }

        // SUCCESS! (200-499 excluding 429)
        const latency = Date.now() - startTime;
        softFailures.delete(node.url);
        await healthStore.markNodeHealthy(node.url, latency);
        if (node.providerId) await quotaTracker.recordRequest(node.providerId);

        // Copy response headers and attach OmniMesh telemetry (labels only, never upstream URLs)
        const resHeaders = new Headers(response.headers);
        resHeaders.delete('x-gateway-secret');
        resHeaders.set('X-Omni-Node', node.label);
        resHeaders.set('X-Omni-Attempts', String(attempts));
        resHeaders.set('X-Omni-Latency-Ms', String(latency));

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: resHeaders,
        });
      } catch (err: any) {
        // Network timeout, connection refused, or DNS failure
        const isTimeout = err.name === 'AbortError' || err.name === 'TimeoutError' || err.message?.includes('aborted');
        lastFailure = isTimeout ? `Timeout_${timeoutForThisAttempt}ms` : 'NetworkError';
        await healthStore.markNodeDead(node.url, isTimeout ? lastFailure : `NetError: ${err.message}`);

        // CRITICAL SAFETY CHECK: If mutating request without Idempotency-Key, DO NOT retry!
        if (!bufferedReq.canRetry) {
          return c.json(
            {
              error: `Upstream timed out or failed to respond. Retry prevented to protect against duplicate transactions. Attach 'Idempotency-Key' header to enable automatic failover.`,
              code: 'ERR_IDEMPOTENCY_REQUIRED_ON_TIMEOUT',
              node: node.label,
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
        lastFailure,
      },
      503
    );
  });

  return app;
}
