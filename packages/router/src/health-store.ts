import type { NodeHealthInfo } from '@omnimesh/core';

export interface HealthStore {
  isNodeHealthy(url: string, circuitTtlMs: number): Promise<boolean>;
  markNodeDead(url: string, reason?: string): Promise<void>;
  markNodeHealthy(url: string, latencyMs?: number): Promise<void>;
  getAllNodeHealth(): Promise<Record<string, NodeHealthInfo>>;
  reset?(): Promise<void>;
}

/**
 * Fast in-memory health store for single-instance, local dev, or fallback.
 */
export class MemoryHealthStore implements HealthStore {
  private deadNodes = new Map<string, { deadSince: number; reason?: string; probeStartedAt?: number }>();
  private healthyNodes = new Map<string, { lastChecked: number; latencyMs?: number }>();

  /** How long a granted probe holds the half-open slot if it never reports back */
  constructor(private probeTimeoutMs = 10_000) {}

  async isNodeHealthy(url: string, circuitTtlMs: number): Promise<boolean> {
    const dead = this.deadNodes.get(url);
    if (!dead) return true;

    const now = Date.now();
    if (now - dead.deadSince <= circuitTtlMs) return false;

    // Half-open: let exactly one request probe the node. Everyone else keeps skipping it until the
    // probe succeeds (markNodeHealthy closes the circuit) or fails (markNodeDead re-opens it).
    // A probe that never reports back (e.g. not attempted) frees the slot after probeTimeoutMs.
    if (dead.probeStartedAt !== undefined && now - dead.probeStartedAt < this.probeTimeoutMs) return false;
    dead.probeStartedAt = now;
    return true;
  }

  async markNodeDead(url: string, reason?: string): Promise<void> {
    this.deadNodes.set(url, { deadSince: Date.now(), reason });
    this.healthyNodes.delete(url);
  }

  async markNodeHealthy(url: string, latencyMs?: number): Promise<void> {
    this.deadNodes.delete(url);
    this.healthyNodes.set(url, { lastChecked: Date.now(), latencyMs });
  }

  async getAllNodeHealth(): Promise<Record<string, NodeHealthInfo>> {
    const result: Record<string, NodeHealthInfo> = {};

    for (const [url, info] of this.healthyNodes.entries()) {
      result[url] = {
        url,
        status: 'healthy',
        lastChecked: info.lastChecked,
        latencyMs: info.latencyMs,
        consecutiveFailures: 0,
      };
    }

    for (const [url, info] of this.deadNodes.entries()) {
      result[url] = {
        url,
        status: 'dead',
        lastChecked: info.deadSince,
        deadSince: info.deadSince,
        consecutiveFailures: 1,
        failureReason: info.reason,
      };
    }

    return result;
  }

  async reset(): Promise<void> {
    this.deadNodes.clear();
    this.healthyNodes.clear();
  }
}

/**
 * Cloudflare KV Health Store
 * Shares node health across all global Cloudflare Worker isolates
 */
export class KvHealthStore implements HealthStore {
  private kv: any;
  private memoryFallback: MemoryHealthStore;
  // KV free tier: 100k reads and 1k writes per day. Cache reads briefly per isolate and
  // only write on state changes, otherwise busy routers exhaust KV within minutes.
  private readCache = new Map<string, { deadSince: number | null; fetchedAt: number }>();
  private readCacheMs: number;

  constructor(kvNamespace: any, options: { readCacheMs?: number } = {}) {
    this.kv = kvNamespace;
    this.memoryFallback = new MemoryHealthStore();
    this.readCacheMs = options.readCacheMs ?? 10_000;
  }

  private key(url: string): string {
    return `health:dead:${encodeURIComponent(url)}`;
  }

  async isNodeHealthy(url: string, circuitTtlMs: number): Promise<boolean> {
    if (!(await this.memoryFallback.isNodeHealthy(url, circuitTtlMs))) return false;
    if (!this.kv) return true;

    try {
      let entry = this.readCache.get(url);
      if (!entry || Date.now() - entry.fetchedAt > this.readCacheMs) {
        const raw = await this.kv.get(this.key(url));
        entry = { deadSince: raw ? Number(raw) : null, fetchedAt: Date.now() };
        this.readCache.set(url, entry);
      }
      return entry.deadSince === null || Date.now() - entry.deadSince > circuitTtlMs;
    } catch {
      return true;
    }
  }

  async markNodeDead(url: string, reason?: string): Promise<void> {
    const cached = this.readCache.get(url);
    await this.memoryFallback.markNodeDead(url, reason);
    const now = Date.now();
    this.readCache.set(url, { deadSince: now, fetchedAt: now });
    // Another isolate already published this outage
    if (!this.kv || (cached?.deadSince && now - cached.deadSince < 30_000)) return;

    try {
      // Auto-expire after 60s in KV (the KV minimum)
      await this.kv.put(this.key(url), String(now), { expirationTtl: 60 });
    } catch {
      // Best effort KV write
    }
  }

  async markNodeHealthy(url: string, latencyMs?: number): Promise<void> {
    await this.memoryFallback.markNodeHealthy(url, latencyMs);
    const cached = this.readCache.get(url);
    // Only clear KV when this isolate believed the node was dead; never write on every success
    if (!this.kv || !cached?.deadSince) return;
    this.readCache.set(url, { deadSince: null, fetchedAt: Date.now() });

    try {
      await this.kv.delete(this.key(url));
    } catch {
      // Best effort KV delete
    }
  }

  async getAllNodeHealth(): Promise<Record<string, NodeHealthInfo>> {
    return this.memoryFallback.getAllNodeHealth();
  }
}
