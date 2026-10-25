import type { Context, Next } from 'hono';
import { sha256Hex } from '@omnimesh/core';

export interface StoredResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** SHA-256 of the original request body, so a reused key with a different payload is caught */
  requestHash?: string;
}

export interface IdempotencyStore {
  get(key: string): Promise<StoredResponse | null>;
  lock(key: string, ttlSeconds: number): Promise<boolean>;
  set(key: string, data: StoredResponse, ttlSeconds: number): Promise<void>;
  unlock(key: string): Promise<void>;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private cache = new Map<string, { data: StoredResponse; expiresAt: number }>();
  private locks = new Map<string, number>();

  private maxEntries: number;

  constructor(maxEntries = 10000) {
    this.maxEntries = maxEntries;
  }

  // Drop expired entries (and the oldest ones past maxEntries) so memory cannot grow without bound
  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.cache) if (now > v.expiresAt) this.cache.delete(k);
    for (const [k, v] of this.locks) if (now > v) this.locks.delete(k);
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  async get(key: string): Promise<StoredResponse | null> {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  async lock(key: string, ttlSeconds: number): Promise<boolean> {
    const lockExpires = this.locks.get(key);
    if (lockExpires && Date.now() < lockExpires) {
      return false; // Already locked
    }
    this.locks.set(key, Date.now() + ttlSeconds * 1000);
    return true;
  }

  async set(key: string, data: StoredResponse, ttlSeconds: number): Promise<void> {
    if (this.cache.size >= this.maxEntries) this.sweep();
    this.cache.set(key, {
      data,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
    this.locks.delete(key);
  }

  async unlock(key: string): Promise<void> {
    this.locks.delete(key);
  }
}

/**
 * Upstash REST Redis Idempotency Store
 * Free tier compatible (10k requests/day)
 */
export class UpstashRedisIdempotencyStore implements IdempotencyStore {
  private url: string;
  private token: string;

  constructor(url?: string, token?: string) {
    this.url = (url || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
    this.token = token || process.env.UPSTASH_REDIS_REST_TOKEN || '';
    // Fail closed: a silently disabled idempotency store would let failover retries charge twice
    if (!this.url || !this.token) {
      throw new Error('[OmniMesh] UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for UpstashRedisIdempotencyStore');
    }
  }

  private async exec(command: any[]): Promise<any> {
    const res = await fetch(`${this.url}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) throw new Error(`Upstash HTTP ${res.status}`);
    const json = await res.json() as { result: any; error?: string };
    if (json.error) throw new Error(`Upstash error: ${json.error}`);
    return json.result;
  }

  async get(key: string): Promise<StoredResponse | null> {
    const raw = await this.exec(['GET', `omnimesh:idemp:${key}`]);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async lock(key: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.exec(['SET', `omnimesh:lock:${key}`, '1', 'EX', ttlSeconds, 'NX']);
    return result === 'OK';
  }

  async set(key: string, data: StoredResponse, ttlSeconds: number): Promise<void> {
    await this.exec(['SET', `omnimesh:idemp:${key}`, JSON.stringify(data), 'EX', ttlSeconds]);
    await this.unlock(key);
  }

  async unlock(key: string): Promise<void> {
    await this.exec(['DEL', `omnimesh:lock:${key}`]);
  }
}


export interface IdempotencyOptions {
  store?: IdempotencyStore;
  ttlSeconds?: number;
  lockTtlSeconds?: number;
}

/**
 * Pick the store when none is passed. Keys must live in storage shared by every node:
 * with per-process memory, a router failover retry lands on a node that has never seen
 * the key and runs the write (e.g. a payment) a second time.
 */
function resolveDefaultStore(): IdempotencyStore {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    return new UpstashRedisIdempotencyStore();
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[OmniMesh] idempotency() needs a shared store in production: set UPSTASH_REDIS_REST_URL and ' +
      'UPSTASH_REDIS_REST_TOKEN, or pass { store }. Per-process memory would let failover retries run twice.'
    );
  }
  return new MemoryIdempotencyStore();
}

export function idempotency(options: IdempotencyOptions = {}) {
  const store = options.store || resolveDefaultStore();
  const ttlSeconds = options.ttlSeconds || 86400; // 24 hours
  const lockTtlSeconds = options.lockTtlSeconds || 30;

  return async function idempotencyMiddleware(c: Context, next: Next) {
    const rawKey = c.req.header('idempotency-key');
    if (!rawKey) {
      return next();
    }
    if (rawKey.length > 255) {
      return c.json({ error: 'Idempotency-Key must be at most 255 characters', code: 'ERR_IDEMPOTENCY_KEY_INVALID' }, 400);
    }

    // Scope the key to caller + route so one client cannot replay another client's stored response
    const caller = c.req.header('authorization') || '';
    const key = await sha256Hex(`${c.req.method}\n${c.req.path}\n${caller}\n${rawKey}`);
    // Hash the raw bytes: Hono caches this read, and an arrayBuffer cache serves later text/json/arrayBuffer
    // reads unchanged (a text cache would re-encode binary bodies and corrupt them)
    const requestHash = await sha256Hex(await c.req.arrayBuffer());
    const reusedWithDifferentBody = (stored: StoredResponse) =>
      stored.requestHash !== undefined && stored.requestHash !== requestHash;
    const keyReused = () =>
      c.json(
        {
          error: 'This Idempotency-Key was already used with a different request body. Use a new key for a new request.',
          code: 'ERR_IDEMPOTENCY_KEY_REUSED',
        },
        422
      );

    // Check if result already cached
    const cached = await store.get(key);
    if (cached) {
      if (reusedWithDifferentBody(cached)) return keyReused();
      c.header('X-Omni-Idempotent-Replay', 'true');
      for (const [headerKey, headerVal] of Object.entries(cached.headers)) {
        if (!['content-length', 'transfer-encoding'].includes(headerKey.toLowerCase())) {
          c.header(headerKey, headerVal);
        }
      }
      return c.newResponse(cached.body, cached.status as any);
    }

    // Acquire execution lock
    const acquired = await store.lock(key, lockTtlSeconds);
    if (!acquired) {
      c.header('Retry-After', '1');
      return c.json(
        {
          error: 'Conflict: An in-flight request with this Idempotency-Key is currently executing.',
          code: 'ERR_IDEMPOTENCY_IN_FLIGHT',
        },
        409
      );
    }

    try {
      // Another node may have finished this key between our get() and lock()
      const finished = await store.get(key);
      if (finished) {
        await store.unlock(key);
        if (reusedWithDifferentBody(finished)) return keyReused();
        c.header('X-Omni-Idempotent-Replay', 'true');
        return c.newResponse(finished.body, finished.status as any);
      }

      await next();

      // Only cache successful or client error responses, not temporary 5xx errors
      const status = c.res.status;
      if (status >= 200 && status < 500 && status !== 409 && status !== 429) {
        const cloned = c.res.clone();
        const bodyText = await cloned.text();
        const headers: Record<string, string> = {};
        cloned.headers.forEach((v, k) => {
          // Never replay cookies: they belong to the original caller's session
          if (k.toLowerCase() !== 'set-cookie') headers[k] = v;
        });

        await store.set(key, { status, headers, body: bodyText, requestHash }, ttlSeconds);
      } else {
        await store.unlock(key);
      }
    } catch (err) {
      await store.unlock(key);
      throw err;
    }
  };
}
