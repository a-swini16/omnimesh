import { Hono } from 'hono';
import { isPlaceholderUrl, OMNIMESH_VERSION, sha256Hex, timingSafeEqual, type OmniMeshConfig } from '@omnimesh/core';
import { MemoryHealthStore, type HealthStore } from './health-store.js';
import { MemoryQuotaTracker, type QuotaTracker } from './quota-tracker.js';
import { prepareBufferedRequest, fetchWithTimeout, BodyTooLargeError, DEFAULT_MAX_BODY_BYTES } from './dispatcher.js';
import { MemoryRateLimiter, type RateLimiter } from './rate-limiter.js';
import { RouterTelemetry } from './telemetry.js';
import { registerDashboard } from './dashboard.js';
import { getAllProviders } from '@omnimesh/providers';

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
  telemetry?: RouterTelemetry;
  /** Local demo cluster only: the dashboard shows its simulate-outage controls */
  demo?: boolean;
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
  /** Key for quota counting: one provider account shares one quota across its deployments */
  quotaKey: string;
  quota?: { requestsPerDay?: number; requestsPerMonth?: number };
}

// Statuses that mean the node or its provider is down/out of quota, not that one endpoint is buggy
const HARD_FAILURE_STATUSES = new Set([429, 502, 503, 504]);
// Methods whose app-level 5xx may be retried on another node
const READ_METHODS = new Set(['GET', 'HEAD']);

/** Request credential headers that make a response user-specific. */
function credentialHeaders(request: Request): string[] {
  return ['Authorization', 'Cookie'].filter((h) => request.headers.has(h));
}

/** Copy the upstream response and attach OmniMesh telemetry (labels only, never upstream URLs). */
function withTelemetry(
  response: Response,
  node: Candidate,
  attempts: number,
  latencyMs: number,
  credentials: string[] = [],
  publicUrl?: (internal: string) => string | null
): Response {
  const headers = new Headers(response.headers);
  headers.delete('x-gateway-secret');
  // Redirects built from a node's own address would reveal the raw backend URL (and bypass the router)
  if (publicUrl) {
    for (const h of ['location', 'content-location']) {
      const value = headers.get(h);
      const rewritten = value ? publicUrl(value) : null;
      if (rewritten) headers.set(h, rewritten);
    }
  }
  if (credentials.length > 0) {
    // A response to a logged-in user must never be stored by a shared cache (CDN, proxy) and served
    // to someone else, even if the app forgot cache headers or said "public"
    const cc = (headers.get('cache-control') || '').toLowerCase();
    if (!cc.includes('private') && !cc.includes('no-store')) headers.set('Cache-Control', 'private, no-store');
    const vary = new Set((headers.get('vary') || '').split(',').map((v) => v.trim()).filter(Boolean));
    for (const h of credentials) vary.add(h);
    headers.set('Vary', [...vary].join(', '));
  }
  headers.set('X-Omni-Node', node.label);
  headers.set('X-Omni-Attempts', String(attempts));
  headers.set('X-Omni-Latency-Ms', String(latencyMs));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

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
  const telemetry = options.telemetry || new RouterTelemetry();
  if (config.router.failureThreshold !== undefined) {
    console.warn('[OmniMesh] router.failureThreshold is ignored: app-level 5xx never open a circuit (only timeouts, connection errors, 429 and 502-504 do). Remove it from the config.');
  }

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
      const quota =
        typeof n !== 'string' && (n.requestsPerDay || n.requestsPerMonth)
          ? { requestsPerDay: n.requestsPerDay, requestsPerMonth: n.requestsPerMonth }
          : undefined;
      if (isPlaceholderUrl(url)) {
        throw new Error(
          `[OmniMesh] Pool ${prefix} still contains the placeholder URL ${url}. ` +
          'Replace it with your deployed app URL in omnimesh.config.yaml (run `omnimesh doctor`).'
        );
      }
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && !isLoopback(parsed.hostname)) {
        throw new Error(`[OmniMesh Security Violation] Upstream ${parsed.host} in pool ${prefix} must use https://`);
      }
      return {
        url: url.replace(/\/$/, ''),
        providerId,
        weight,
        isBackup,
        quota,
        quotaKey: providerId || url,
        label: providerId || `node-${i + 1}`,
      };
    });
  }
  const prefixes = Object.keys(pools);
  const defaultPool = config.defaultPool === undefined ? '/api' : config.defaultPool;
  const internalOrigins = new Set(Object.values(pools).flat().map((n) => new URL(n.url).origin));
  /** Map an absolute URL on any mesh node onto the public origin; null when it is not internal. */
  const toPublic = (publicOrigin: string) => (value: string): string | null => {
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return null; // relative redirects are already safe
    try {
      const target = new URL(value);
      if (!internalOrigins.has(target.origin)) return null;
      return `${publicOrigin}${target.pathname}${target.search}${target.hash}`;
    } catch {
      return null;
    }
  };

  const app = new Hono();

  const isOperator = (authHeader: string | undefined) =>
    Boolean(statusToken) && timingSafeEqual(authHeader || '', `Bearer ${statusToken}`);

  // Diagnostic endpoint: lists internal node URLs, so it is only served to operators holding the status token
  app.get('/_omnimesh/status', async (c) => {
    if (!isOperator(c.req.header('authorization'))) {
      return c.json({ error: 'Not Found' }, 404);
    }
    const health = await healthStore.getAllNodeHealth();
    const poolSnapshots = await Promise.all(
      Object.entries(pools).map(async ([prefix, nodes]) => ({
        prefix,
        isDefault: prefix === defaultPool,
        nodes: await Promise.all(
          nodes.map(async (n) => {
            const h = health[n.url];
            const counters = telemetry.nodeCounters(n.url);
            const usage = n.quota ? await quotaTracker.getUsage(n.quotaKey, n.quota) : undefined;
            return {
              label: n.label,
              providerId: n.providerId ?? null,
              url: n.url,
              weight: n.weight,
              isBackup: n.isBackup,
              state: h ? (h.status === 'dead' ? 'down' : 'healthy') : 'unknown',
              failureReason: h?.status === 'dead' ? h.failureReason ?? null : null,
              lastChecked: h?.lastChecked ?? null,
              latencyMs: counters.lastLatencyMs ?? h?.latencyMs ?? null,
              requests: counters.requests,
              errors: counters.errors,
              quota: n.quota
                ? {
                    requestsPerDay: n.quota.requestsPerDay ?? null,
                    requestsPerMonth: n.quota.requestsPerMonth ?? null,
                    usedToday: usage?.requestsToday ?? 0,
                    usedThisMonth: usage?.requestsThisMonth ?? 0,
                    percentUsed: usage?.quotaPercentUsed ?? 0,
                  }
                : null,
            };
          })
        ),
      }))
    );
    return c.json({
      status: 'active',
      profile: config.profile,
      domain: config.domain,
      instance: { startedAt: new Date(telemetry.startedAt).toISOString(), uptimeSeconds: Math.floor((Date.now() - telemetry.startedAt) / 1000) },
      version: OMNIMESH_VERSION,
      demo: Boolean(options.demo),
      routerConfig: {
        ...config.router,
        maxBodyBytes: config.router.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
        strategy,
        defaultPool,
        rateLimit: config.rateLimit,
      },
      // Whether state is shared by every router instance or kept per instance (dashboard setup checks)
      sharing: {
        health: healthStore instanceof MemoryHealthStore ? 'per-instance' : 'shared',
        rateLimit: rateLimiter instanceof MemoryRateLimiter ? 'per-instance' : 'shared',
      },
      keepAlive: { enabled: config.keepAlive.enabled },
      totals: telemetry.totals,
      latency: telemetry.latency(),
      pools: poolSnapshots,
      events: telemetry.recentEvents(),
      timestamp: new Date().toISOString(),
    });
  });

  // Provider catalog for the dashboard: free-tier limits, card requirement, roles (static data)
  app.get('/_omnimesh/catalog', (c) => {
    if (!isOperator(c.req.header('authorization'))) return c.json({ error: 'Not Found' }, 404);
    return c.json({
      providers: getAllProviders().map((p) => ({
        id: p.id,
        displayName: p.displayName,
        requiresCard: p.requiresCard,
        tier: p.tier,
        roles: p.roles,
        limits: p.limits,
      })),
    });
  });

  // Operator dashboard; hidden entirely when no status token is configured
  registerDashboard(app, () => Boolean(statusToken));

  // Main HTTP proxy and auto-failover handler
  app.all('*', async (c) => {
    const request = c.req.raw;
    const url = new URL(request.url);
    const pathname = url.pathname;
    const clientIp = request.headers.get('cf-connecting-ip') || 'unknown';
    const credentials = credentialHeaders(request);

    // 0. Per-client rate limit, so one bot cannot burn the whole free-tier quota
    if (config.rateLimit.enabled) {
      // Limit per IP, and per caller so one token used from many IPs is still one client.
      // Callers are keyed by a hash so raw tokens never reach the limiter's storage.
      const auth = request.headers.get('authorization');
      const keys = [`ip:${clientIp}`, ...(auth ? [`user:${await sha256Hex(auth)}`] : [])];
      for (const key of keys) {
        const { allowed, retryAfterSeconds } = await rateLimiter.hit(key);
        if (!allowed) {
          telemetry.totals.rateLimited += 1;
          c.header('Retry-After', String(retryAfterSeconds));
          return c.json({ error: 'Too Many Requests', code: 'ERR_RATE_LIMITED' }, 429);
        }
      }
    }

    // Router-owned namespace: never forwarded to nodes
    if (pathname === '/_omnimesh' || pathname.startsWith('/_omnimesh/')) {
      return c.json({ error: 'Not Found', code: 'ERR_NO_ROUTE' }, 404);
    }

    // 1. Resolve matching pool by longest segment-aligned prefix, else the configured default pool
    const matchedPrefix = matchPool(pathname, prefixes) ?? (defaultPool && pools[defaultPool] ? defaultPool : undefined);
    if (!matchedPrefix) {
      return c.json({ error: 'Not Found', code: 'ERR_NO_ROUTE' }, 404);
    }
    const candidates = pools[matchedPrefix];
    if (!candidates || candidates.length === 0) {
      return c.json({ error: 'No upstream configured for this path.', code: 'ERR_NO_POOL_CANDIDATES' }, 502);
    }

    // 2. Prepare buffered request (buffer body if <= maxBufferBytes)
    let bufferedReq;
    try {
      bufferedReq = await prepareBufferedRequest(request, config.router.maxBufferBytes, config.router.maxBodyBytes);
    } catch (err) {
      telemetry.totals.rejected += 1;
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
      const quotaOk = !node.quota || (await quotaTracker.canAcceptTraffic(node.quotaKey, node.quota));
      if (node.quota) telemetry.quotaChecked(node.url, node.label, matchedPrefix, quotaOk);
      const isHealthy = quotaOk && (await healthStore.isNodeHealthy(node.url, circuitTtlMs));
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
    // A read's app-level 5xx is kept so that, if no node does better, the client gets the app's real answer
    let lastAppError: { response: Response; node: Candidate } | null = null;

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

        // Provider-level failures (429, 502-504) mean the node is down or out of quota: open its circuit.
        // Other 5xx (e.g. 500) are the app's own answer, often to bad input from one client, so they never
        // open a circuit; otherwise ~10 malformed requests could mark every node dead.
        const isHardFailure = HARD_FAILURE_STATUSES.has(response.status);
        if (isHardFailure || response.status >= 500) {
          lastFailure = `HTTP_${response.status}`;

          telemetry.attemptFailed(node.url, node.label, matchedPrefix, lastFailure, isHardFailure);
          if (!isHardFailure && !READ_METHODS.has(bufferedReq.method)) {
            // An app error on a write is final: pass it through unchanged instead of replaying it on more nodes
            telemetry.requestFinished(false, Date.now() - startTime, attempts, matchedPrefix, node.label);
            return withTelemetry(response, node, attempts, Date.now() - startTime, credentials, toPublic(url.origin));
          }

          // The provider served (and counts) this request even though it failed
          if (node.quota) await quotaTracker.recordRequest(node.quotaKey);
          if (isHardFailure) {
            // Release the connection; we are not going to read this body
            await response.body?.cancel().catch(() => {});
            await healthStore.markNodeDead(node.url, lastFailure);
          } else {
            await lastAppError?.response.body?.cancel().catch(() => {});
            lastAppError = { response, node };
          }

          // CRITICAL SAFETY CHECK: If mutating request without Idempotency-Key, DO NOT retry!
          if (!bufferedReq.canRetry) {
            telemetry.requestFinished(false, Date.now() - startTime, attempts, matchedPrefix, node.label);
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
        await lastAppError?.response.body?.cancel().catch(() => {});
        const latency = Date.now() - startTime;
        await healthStore.markNodeHealthy(node.url, latency);
        if (node.quota) await quotaTracker.recordRequest(node.quotaKey);
        telemetry.attemptSucceeded(node.url, node.label, matchedPrefix, latency);
        telemetry.requestFinished(true, latency, attempts, matchedPrefix, node.label);

        return withTelemetry(response, node, attempts, latency, credentials, toPublic(url.origin));
      } catch (err: any) {
        // Network timeout, connection refused, or DNS failure
        const isTimeout = err.name === 'AbortError' || err.name === 'TimeoutError' || err.message?.includes('aborted');
        lastFailure = isTimeout ? `Timeout_${timeoutForThisAttempt}ms` : 'NetworkError';
        // A timed-out request reached the provider and counts against its quota; a refused connection did not
        if (isTimeout && node.quota) await quotaTracker.recordRequest(node.quotaKey);
        await healthStore.markNodeDead(node.url, isTimeout ? lastFailure : `NetError: ${err.message}`);
        telemetry.attemptFailed(node.url, node.label, matchedPrefix, lastFailure, true);

        // CRITICAL SAFETY CHECK: If mutating request without Idempotency-Key, DO NOT retry!
        if (!bufferedReq.canRetry) {
          telemetry.requestFinished(false, Date.now() - startTime, attempts, matchedPrefix, node.label);
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
    if (lastAppError) {
      // The nodes were up and the app itself failed: pass its answer through instead of reporting an outage
      telemetry.requestFinished(false, totalElapsed, attempts, matchedPrefix, lastAppError.node.label);
      return withTelemetry(lastAppError.response, lastAppError.node, attempts, totalElapsed, credentials, toPublic(url.origin));
    }
    telemetry.requestFinished(false, totalElapsed, attempts, matchedPrefix);
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
