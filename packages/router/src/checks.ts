import { isPlaceholderUrl, nodeHealthPath, OMNIMESH_VERSION, type OmniMeshConfig } from '@omnimesh/core';
import { getProvider } from '@omnimesh/providers';

/** online: answered below 500. error: answered 500 (the app says something is wrong). down: no usable answer. */
export type CheckState = 'online' | 'error' | 'down';
/**
 * locked: the server refuses requests that did not come through the router.
 * open: anyone who learns its address can call it directly and skip the router's protection.
 */
export type LockLevel = 'locked' | 'open' | 'unknown';

export interface NodeCheck {
  state: CheckState;
  /** Status the health path answered with the gateway secret; null when nothing answered */
  status: number | null;
  latencyMs: number | null;
  reason: string | null;
  lock: LockLevel;
  at: number;
}

/** schedule: the router's own cron. manual: the owner pressed Check now. watcher: the GitHub watcher asked. */
export type CheckTrigger = 'schedule' | 'manual' | 'watcher';

export interface CheckSnapshot {
  /** When the last run finished */
  at: number;
  trigger: CheckTrigger;
  /** When a scheduled run last happened; null until the cron has run once */
  lastScheduledAt: number | null;
  /** When the GitHub watcher last asked for a check; missing until it has run once */
  lastWatcherAt?: number | null;
  /** Latest result per node URL (kept across runs for nodes a run skipped) */
  nodes: Record<string, NodeCheck>;
}

export interface CheckTarget {
  url: string;
  /** First route and label this server appears under (for events) */
  pool: string;
  label: string;
  healthPath: string;
  /** Free servers that sleep when idle: checking them on a timer would keep them awake */
  sleepsIfIdle: boolean;
  /** Set per server: check (and so keep awake) on the schedule or not, whatever keepAlive says */
  keepAwake?: boolean;
}

/**
 * The name of every server in a route: its label, else its cloud, else node-N. Copies on the same cloud
 * get -2, -3, so pause, resume and the dashboard can tell them apart.
 */
export function nodeLabels(nodes: Array<string | { label?: string; providerId?: string }>): string[] {
  const used = new Map<string, number>();
  return nodes.map((n, i) => {
    const base = (typeof n === 'string' ? undefined : n.label ?? n.providerId) || `node-${i + 1}`;
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
  });
}

/**
 * Statuses meaning the server or its provider is down or out of quota (same rule as live traffic):
 * 429 and 502-504, plus Cloudflare's own "could not reach the server" answers (521-526, 530), which a
 * server behind Cloudflare (a tunnel, Render) returns when the app itself is not running.
 */
export const DOWN_STATUSES = new Set([429, 502, 503, 504, 521, 522, 523, 524, 525, 526, 530]);
const USER_AGENT = `OmniMesh-HealthCheck/${OMNIMESH_VERSION}`;
/** Cloudflare free Workers allow 50 outgoing requests per run; each server takes up to 2 */
export const MAX_CHECKED_NODES = 20;
export const SCHEDULE_CRON = '*/5 * * * *';
/**
 * Asked without the gateway secret to learn the lock level. No app serves it, so a locked app (gatewayAuth on
 * every path) answers 401/403 and an open one answers 404, whether or not the app leaves /health public.
 */
export const LOCK_PROBE_PATH = '/.well-known/omnimesh-lock-check';

/** Every distinct server in the config, once, with the path used to check it. */
export function checkTargets(config: OmniMeshConfig): CheckTarget[] {
  const seen = new Map<string, CheckTarget>();
  for (const [pool, nodes] of Object.entries(config.pools)) {
    const labels = nodeLabels(nodes);
    nodes.forEach((n, i) => {
      const url = (typeof n === 'string' ? n : n.url).replace(/\/$/, '');
      if (seen.has(url) || isPlaceholderUrl(url)) return;
      const providerId = typeof n === 'string' ? undefined : n.providerId;
      const keepAwake = typeof n === 'string' ? undefined : n.keepAwake;
      seen.set(url, {
        url,
        pool,
        label: labels[i],
        healthPath: nodeHealthPath(n),
        sleepsIfIdle: Boolean(providerId && getProvider(providerId)?.limits.sleepsIfIdle),
        ...(keepAwake === undefined ? {} : { keepAwake }),
      });
    });
  }
  return [...seen.values()];
}

async function timedFetch(url: string, headers: Record<string, string>, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, { method: 'GET', headers, redirect: 'manual', signal: controller.signal });
    await res.body?.cancel().catch(() => {});
    return { status: res.status, latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask one server's health path, the same way the router does (with the gateway secret), then once
 * without the secret to learn whether the server only accepts traffic from the router.
 */
export async function checkNode(target: CheckTarget, gatewaySecret: string, timeoutMs: number): Promise<NodeCheck> {
  const url = `${target.url}${target.healthPath}`;
  const at = Date.now();
  let status: number;
  let latencyMs: number;
  try {
    ({ status, latencyMs } = await timedFetch(url, { 'User-Agent': USER_AGENT, 'X-Gateway-Secret': gatewaySecret }, timeoutMs));
  } catch (err: any) {
    const timedOut = err?.name === 'AbortError' || err?.name === 'TimeoutError';
    return {
      state: 'down',
      status: null,
      latencyMs: null,
      reason: timedOut ? `no answer within ${Math.round(timeoutMs / 1000)} s` : 'could not connect',
      lock: 'unknown',
      at,
    };
  }

  if (DOWN_STATUSES.has(status)) {
    const reason = status === 429 ? 'refused with 429 (rate limit or free quota used up)' : `answered ${status} (server or provider unavailable)`;
    return { state: 'down', status, latencyMs, reason, lock: 'unknown', at };
  }

  let lock: LockLevel = 'unknown';
  // A health path that needs the app's own login (401/403 even with the secret) says nothing about the lock
  if (status !== 401 && status !== 403) {
    try {
      const open = await timedFetch(`${target.url}${LOCK_PROBE_PATH}`, { 'User-Agent': USER_AGENT }, timeoutMs);
      if (open.status === 401 || open.status === 403) lock = 'locked';
      else if (open.status < 500) lock = 'open';
    } catch {
      // No answer the second time: leave it unknown
    }
  }

  if (status >= 500) return { state: 'error', status, latencyMs, reason: `health check answered ${status}`, lock, at };
  return { state: 'online', status, latencyMs, reason: null, lock, at };
}

export interface RunChecksOptions {
  targets: CheckTarget[];
  gatewaySecret: string;
  trigger: CheckTrigger;
  previous: CheckSnapshot | null;
  /** Check servers that sleep when idle on a schedule too (only when the owner turned keep-alive on) */
  includeSleepers?: boolean;
  timeoutMs?: number;
}

/** Check every server in parallel and merge the results into the previous snapshot. */
export async function runChecks(options: RunChecksOptions): Promise<{ snapshot: CheckSnapshot; checked: Record<string, NodeCheck> }> {
  const { targets, gatewaySecret, trigger, previous } = options;
  // A manual check waits long enough for a sleeping free server to wake (Render takes about a minute)
  const timeoutMs = options.timeoutMs ?? (trigger === 'schedule' ? 10_000 : 60_000);
  // Cloudflare free Workers allow 50 outgoing requests per run, so at most MAX_CHECKED_NODES servers are asked
  const due = targets.filter((t) => trigger === 'manual' || !t.sleepsIfIdle || (t.keepAwake ?? options.includeSleepers)).slice(0, MAX_CHECKED_NODES);
  const results = await Promise.all(
    due.map(async (t) => {
      const result = await checkNode(t, gatewaySecret, timeoutMs);
      // A server that is down cannot show whether it is locked; keep what the last check learned
      const before = previous?.nodes[t.url]?.lock;
      if (result.lock === 'unknown' && before && before !== 'unknown') result.lock = before;
      return [t.url, result] as const;
    })
  );
  const checked = Object.fromEntries(results);
  const known = new Set(targets.map((t) => t.url));
  const kept = Object.fromEntries(Object.entries(previous?.nodes ?? {}).filter(([url]) => known.has(url)));
  const now = Date.now();
  return {
    checked,
    snapshot: {
      at: now,
      trigger,
      lastScheduledAt: trigger === 'schedule' ? now : previous?.lastScheduledAt ?? null,
      lastWatcherAt: trigger === 'watcher' ? now : previous?.lastWatcherAt ?? null,
      nodes: { ...kept, ...checked },
    },
  };
}

/**
 * Tell the circuit breaker about servers a check found down. Only on the change from up to down: a server
 * that stays down would otherwise cost one KV write per run and exhaust the free 1,000 writes/day.
 */
export async function recordDownServers(
  store: { markNodeDead(url: string, reason?: string): Promise<void> },
  previous: CheckSnapshot | null,
  checked: Record<string, NodeCheck>
): Promise<void> {
  for (const [url, result] of Object.entries(checked)) {
    if (result.state === 'down' && previous?.nodes[url]?.state !== 'down') {
      await store.markNodeDead(url, result.reason ?? 'health check failed');
    }
  }
}
