import type { Context, Next } from 'hono';

export interface StoredResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
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
    this.url = (url || process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_URL || '').replace(/\/$/, '');
    this.token = token || process.env.UPSTASH_REDIS_REST_TOKEN || '';
  }

  private isConfigured(): boolean {
    return Boolean(this.url && this.token);
  }

  private async exec(command: any[]): Promise<any> {
    if (!this.isConfigured()) return null;
    const res = await fetch(`${this.url}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(command),
    });
    const json = await res.json() as { result: any; error?: string };
    if (json.error) throw new Error(`Upstash error: ${json.error}`);
    return json.result;
  }

  async get(key: string): Promise<StoredResponse | null> {
    if (!this.isConfigured()) return null;
    const raw = await this.exec(['GET', `omnimesh:idemp:${key}`]);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async lock(key: string, ttlSeconds: number): Promise<boolean> {
    if (!this.isConfigured()) return true;
    const result = await this.exec(['SET', `omnimesh:lock:${key}`, '1', 'EX', ttlSeconds, 'NX']);
    return result === 'OK';
  }

  async set(key: string, data: StoredResponse, ttlSeconds: number): Promise<void> {
    if (!this.isConfigured()) return;
    await this.exec(['SET', `omnimesh:idemp:${key}`, JSON.stringify(data), 'EX', ttlSeconds]);
    await this.unlock(key);
  }

  async unlock(key: string): Promise<void> {
    if (!this.isConfigured()) return;
    await this.exec(['DEL', `omnimesh:lock:${key}`]);
  }
}

export interface IdempotencyOptions {
  store?: IdempotencyStore;
  ttlSeconds?: number;
  lockTtlSeconds?: number;
}

export function idempotency(options: IdempotencyOptions = {}) {
  const store = options.store || new MemoryIdempotencyStore();
  const ttlSeconds = options.ttlSeconds || 86400; // 24 hours
  const lockTtlSeconds = options.lockTtlSeconds || 30;

  return async function idempotencyMiddleware(c: Context, next: Next) {
    const key = c.req.header('idempotency-key') || c.req.header('Idempotency-Key');
    if (!key) {
      return next();
    }

    // Check if result already cached
    const cached = await store.get(key);
    if (cached) {
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
      return c.json(
        {
          error: 'Conflict: An in-flight request with this Idempotency-Key is currently executing.',
          code: 'ERR_IDEMPOTENCY_IN_FLIGHT',
        },
        409
      );
    }

    try {
      await next();

      // Only cache successful or client error responses, not temporary 5xx errors
      const status = c.res.status;
      if (status >= 200 && status < 500) {
        const cloned = c.res.clone();
        const bodyText = await cloned.text();
        const headers: Record<string, string> = {};
        cloned.headers.forEach((v, k) => {
          headers[k] = v;
        });

        await store.set(key, { status, headers, body: bodyText }, ttlSeconds);
      } else {
        await store.unlock(key);
      }
    } catch (err) {
      await store.unlock(key);
      throw err;
    }
  };
}
