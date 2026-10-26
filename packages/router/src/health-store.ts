import type { NodeHealthInfo } from '@omnimesh/core';
import type { CheckSnapshot } from './checks.js';

export interface HealthStore {
  isNodeHealthy(url: string, circuitTtlMs: number): Promise<boolean>;
  markNodeDead(url: string, reason?: string): Promise<void>;
  markNodeHealthy(url: string, latencyMs?: number): Promise<void>;
  getAllNodeHealth(): Promise<Record<string, NodeHealthInfo>>;
  /** Stop sending traffic to a node until `until` (ms since epoch), e.g. to test failover. */
  pauseNode(url: string, until: number): Promise<void>;
  resumeNode(url: string): Promise<void>;
  /** Paused node URLs and when each pause ends (expired pauses are left out) */
  getPaused(): Promise<Record<string, number>>;
  saveChecks(snapshot: CheckSnapshot): Promise<void>;
  /** `fresh` skips any read cache (use before writing a merged snapshot back) */
  getChecks(fresh?: boolean): Promise<CheckSnapshot | null>;
  reset?(): Promise<void>;
}

/** Pauses that have not ended yet (the same object when none ended, so the hot path does not allocate) */
function activePauses(paused: Record<string, number>, now = Date.now()): Record<string, number> {
  const entries = Object.entries(paused);
  return entries.every(([, until]) => until > now) ? paused : Object.fromEntries(entries.filter(([, until]) => until > now));
}

function without(paused: Record<string, number>, url: string): Record<string, number> {
  const copy = { ...paused };
  delete copy[url];
  return copy;
}

/**
 * Fast in-memory health store for single-instance, local dev, or fallback.
 */
export class MemoryHealthStore implements HealthStore {
  private deadNodes = new Map<string, { deadSince: number; reason?: string; probeStartedAt?: number }>();
  private healthyNodes = new Map<string, { lastChecked: number; latencyMs?: number }>();
  private paused: Record<string, number> = {};
  private checks: CheckSnapshot | null = null;

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

  /** Record an outage another router instance reported (e.g. via KV), unless a newer one is already known. */
  adoptDead(url: string, deadSince: number, reason?: string): void {
    const known = this.deadNodes.get(url);
    if (known && known.deadSince >= deadSince) return;
    this.deadNodes.set(url, { deadSince, reason: reason ?? 'reported by another router instance' });
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

  async pauseNode(url: string, until: number): Promise<void> {
    this.paused = { ...activePauses(this.paused), [url]: until };
  }

  async resumeNode(url: string): Promise<void> {
    this.paused = activePauses(without(this.paused, url));
  }

  async getPaused(): Promise<Record<string, number>> {
    return activePauses(this.paused);
  }

  async saveChecks(snapshot: CheckSnapshot): Promise<void> {
    this.checks = snapshot;
  }

  async getChecks(): Promise<CheckSnapshot | null> {
    return this.checks;
  }

  async reset(): Promise<void> {
    this.deadNodes.clear();
    this.healthyNodes.clear();
    this.paused = {};
    this.checks = null;
  }
}

const PAUSED_KEY = 'omnimesh:paused';
const CHECKS_KEY = 'omnimesh:checks';

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
  private pausedCache: { value: Record<string, number>; fetchedAt: number } | null = null;
  private checksCache: { value: CheckSnapshot | null; fetchedAt: number } | null = null;

  constructor(kvNamespace: any, options: { readCacheMs?: number } = {}) {
    this.kv = kvNamespace;
    this.memoryFallback = new MemoryHealthStore();
    this.readCacheMs = options.readCacheMs ?? 10_000;
  }

  private key(url: string): string {
    return `health:dead:${encodeURIComponent(url)}`;
  }

  async isNodeHealthy(url: string, circuitTtlMs: number): Promise<boolean> {
    if (this.kv) {
      try {
        let entry = this.readCache.get(url);
        if (!entry || Date.now() - entry.fetchedAt > this.readCacheMs) {
          const raw = await this.kv.get(this.key(url));
          entry = { deadSince: raw ? Number(raw) : null, fetchedAt: Date.now() };
          this.readCache.set(url, entry);
        }
        // Feed outages seen by other instances into local state, so the TTL and the single half-open
        // probe apply here too instead of every instance resuming full traffic at once
        if (entry.deadSince !== null) this.memoryFallback.adoptDead(url, entry.deadSince);
      } catch {
        // KV unavailable: fall back to what this instance knows
      }
    }
    return this.memoryFallback.isNodeHealthy(url, circuitTtlMs);
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

  private async readJson<T>(key: string): Promise<T | null> {
    const raw = await this.kv.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  /** Read-modify-write of the one pause record. Pauses are rare operator actions, so races are negligible. */
  private async writePaused(change: (paused: Record<string, number>) => Record<string, number>): Promise<void> {
    let current: Record<string, number> = {};
    try {
      current = (await this.readJson<Record<string, number>>(PAUSED_KEY)) ?? {};
    } catch {
      // Start from what this instance knows
      current = await this.memoryFallback.getPaused();
    }
    const next = activePauses(change(current));
    this.pausedCache = { value: next, fetchedAt: Date.now() };
    const latest = Math.max(0, ...Object.values(next));
    if (Object.keys(next).length === 0) await this.kv.delete(PAUSED_KEY);
    // Let the record expire a minute after the last pause ends (60 s is the KV minimum)
    else await this.kv.put(PAUSED_KEY, JSON.stringify(next), { expirationTtl: Math.max(60, Math.ceil((latest - Date.now()) / 1000) + 60) });
  }

  async pauseNode(url: string, until: number): Promise<void> {
    // This instance stops at once even if KV is unavailable; others follow within the read cache window
    await this.memoryFallback.pauseNode(url, until);
    if (this.kv) await this.writePaused((p) => ({ ...p, [url]: until }));
  }

  async resumeNode(url: string): Promise<void> {
    await this.memoryFallback.resumeNode(url);
    if (this.kv) {
      await this.writePaused((p) => without(p, url));
    }
  }

  async getPaused(): Promise<Record<string, number>> {
    if (!this.kv) return this.memoryFallback.getPaused();
    if (!this.pausedCache || Date.now() - this.pausedCache.fetchedAt >= this.readCacheMs) {
      try {
        this.pausedCache = { value: (await this.readJson<Record<string, number>>(PAUSED_KEY)) ?? {}, fetchedAt: Date.now() };
      } catch {
        return this.memoryFallback.getPaused();
      }
    }
    return activePauses(this.pausedCache.value);
  }

  async saveChecks(snapshot: CheckSnapshot): Promise<void> {
    await this.memoryFallback.saveChecks(snapshot);
    this.checksCache = { value: snapshot, fetchedAt: Date.now() };
    if (!this.kv) return;
    try {
      await this.kv.put(CHECKS_KEY, JSON.stringify(snapshot));
    } catch {
      // Best effort: the next run writes again
    }
  }

  async getChecks(fresh = false): Promise<CheckSnapshot | null> {
    if (!this.kv) return this.memoryFallback.getChecks();
    if (fresh || !this.checksCache || Date.now() - this.checksCache.fetchedAt >= this.readCacheMs) {
      try {
        this.checksCache = { value: await this.readJson<CheckSnapshot>(CHECKS_KEY), fetchedAt: Date.now() };
      } catch {
        return this.memoryFallback.getChecks();
      }
    }
    return this.checksCache.value;
  }
}
