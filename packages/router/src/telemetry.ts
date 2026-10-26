export type RouterEventKind = 'node_down' | 'node_up' | 'failover' | 'outage' | 'quota_limit' | 'paused' | 'resumed';

export interface RouterEvent {
  at: number;
  kind: RouterEventKind;
  node?: string;
  pool?: string;
  detail?: string;
  /** How many identical events were collapsed into this one */
  count: number;
}

interface NodeCounters {
  requests: number;
  errors: number;
  lastLatencyMs?: number;
}

const COALESCE_MS = 5_000;

/**
 * Live counters for the status API and dashboard. Memory is bounded: latency samples and events
 * live in fixed-size rings. On Cloudflare each isolate keeps its own copy, so numbers describe
 * the router instance that answered, not the whole mesh.
 */
export class RouterTelemetry {
  readonly startedAt = Date.now();
  readonly totals = { requests: 0, succeeded: 0, failed: 0, failovers: 0, rateLimited: 0, rejected: 0 };
  private latencies: number[] = [];
  private latencyIndex = 0;
  private events: RouterEvent[] = [];
  private nodes = new Map<string, NodeCounters>();
  private down = new Set<string>();
  private overQuota = new Set<string>();

  constructor(private maxSamples = 1000, private maxEvents = 200) {}

  private node(url: string): NodeCounters {
    let n = this.nodes.get(url);
    if (!n) {
      n = { requests: 0, errors: 0 };
      this.nodes.set(url, n);
    }
    return n;
  }

  private push(event: Omit<RouterEvent, 'at' | 'count'>): void {
    const now = Date.now();
    const last = this.events[this.events.length - 1];
    if (last && last.kind === event.kind && last.node === event.node && last.pool === event.pool && now - last.at < COALESCE_MS) {
      last.count += 1;
      last.at = now;
      last.detail = event.detail ?? last.detail;
      return;
    }
    this.events.push({ ...event, at: now, count: 1 });
    if (this.events.length > this.maxEvents) this.events.shift();
  }

  /** Record an owner action (pause, resume) in the event list. */
  note(event: Omit<RouterEvent, 'at' | 'count'>): void {
    this.push(event);
  }

  attemptFailed(url: string, label: string, pool: string, reason: string, opensCircuit: boolean): void {
    const n = this.node(url);
    n.requests += 1;
    n.errors += 1;
    if (opensCircuit && !this.down.has(url)) {
      this.down.add(url);
      this.push({ kind: 'node_down', node: label, pool, detail: reason });
    }
  }

  /** A health check result: records the moment a server stops or starts answering, like live traffic does. */
  checkFinished(url: string, label: string, pool: string, online: boolean, reason?: string): void {
    if (!online && !this.down.has(url)) {
      this.down.add(url);
      this.push({ kind: 'node_down', node: label, pool, detail: reason ? `health check: ${reason}` : 'health check failed' });
    } else if (online && this.down.delete(url)) {
      this.push({ kind: 'node_up', node: label, pool, detail: 'health check' });
    }
  }

  attemptSucceeded(url: string, label: string, pool: string, latencyMs: number): void {
    const n = this.node(url);
    n.requests += 1;
    n.lastLatencyMs = latencyMs;
    if (this.down.delete(url)) this.push({ kind: 'node_up', node: label, pool });
  }

  /** Called on every routing decision for a node with a quota; records only the moment it switches. */
  quotaChecked(url: string, label: string, pool: string, canAccept: boolean): void {
    if (canAccept) {
      this.overQuota.delete(url);
    } else if (!this.overQuota.has(url)) {
      this.overQuota.add(url);
      this.push({ kind: 'quota_limit', node: label, pool, detail: 'reached 95% of its free quota; traffic moved to the next node' });
    }
  }

  /** One finished client request through the proxy loop. */
  requestFinished(ok: boolean, latencyMs: number, attempts: number, pool: string, servedBy?: string): void {
    this.totals.requests += 1;
    if (ok) this.totals.succeeded += 1;
    else this.totals.failed += 1;
    if (ok && attempts > 1) {
      this.totals.failovers += 1;
      this.push({ kind: 'failover', node: servedBy, pool, detail: `served after ${attempts} attempts` });
    }
    if (!ok && servedBy === undefined) this.push({ kind: 'outage', pool, detail: 'no node could answer' });

    if (this.latencies.length < this.maxSamples) this.latencies.push(latencyMs);
    else this.latencies[this.latencyIndex++ % this.maxSamples] = latencyMs;
  }

  nodeCounters(url: string): NodeCounters {
    return this.nodes.get(url) ?? { requests: 0, errors: 0 };
  }

  latency(): { p50: number; p95: number; p99: number; samples: number } {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const at = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);
    return { p50: at(0.5), p95: at(0.95), p99: at(0.99), samples: sorted.length };
  }

  recentEvents(limit = 50): RouterEvent[] {
    return this.events.slice(-limit).reverse();
  }
}
