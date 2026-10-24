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
  private deadNodes = new Map<string, { deadSince: number; reason?: string }>();
  private healthyNodes = new Map<string, { lastChecked: number; latencyMs?: number }>();

  async isNodeHealthy(url: string, circuitTtlMs: number): Promise<boolean> {
    const dead = this.deadNodes.get(url);
    if (!dead) return true;

    if (Date.now() - dead.deadSince > circuitTtlMs) {
      // Circuit breaker half-open: give node a chance to recover
      this.deadNodes.delete(url);
      return true;
    }
    return false;
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

  constructor(kvNamespace: any) {
    this.kv = kvNamespace;
    this.memoryFallback = new MemoryHealthStore();
  }

  async isNodeHealthy(url: string, circuitTtlMs: number): Promise<boolean> {
    if (!this.kv) return this.memoryFallback.isNodeHealthy(url, circuitTtlMs);

    try {
      const key = `health:dead:${encodeURIComponent(url)}`;
      const deadSinceStr = await this.kv.get(key);
      if (!deadSinceStr) return true;

      const deadSince = Number(deadSinceStr);
      if (Date.now() - deadSince > circuitTtlMs) {
        await this.kv.delete(key);
        return true;
      }
      return false;
    } catch {
      return this.memoryFallback.isNodeHealthy(url, circuitTtlMs);
    }
  }

  async markNodeDead(url: string, reason?: string): Promise<void> {
    await this.memoryFallback.markNodeDead(url, reason);
    if (!this.kv) return;

    try {
      const key = `health:dead:${encodeURIComponent(url)}`;
      // Auto-expire after 60s in KV
      await this.kv.put(key, String(Date.now()), { expirationTtl: 60 });
    } catch {
      // Best effort KV write
    }
  }

  async markNodeHealthy(url: string, latencyMs?: number): Promise<void> {
    await this.memoryFallback.markNodeHealthy(url, latencyMs);
    if (!this.kv) return;

    try {
      const key = `health:dead:${encodeURIComponent(url)}`;
      await this.kv.delete(key);
    } catch {
      // Best effort KV delete
    }
  }

  async getAllNodeHealth(): Promise<Record<string, NodeHealthInfo>> {
    return this.memoryFallback.getAllNodeHealth();
  }
}
