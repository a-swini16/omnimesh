export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  hit(key: string): Promise<RateLimitResult>;
}

/**
 * Fixed-window limiter kept in isolate memory.
 * Each router instance counts on its own, so the effective global limit is roughly
 * limit x instances; pair it with a Cloudflare WAF rate-limit rule (or pass a shared
 * RateLimiter) when you need one exact limit across every instance.
 */
export class MemoryRateLimiter implements RateLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private limit: number,
    private windowMs: number,
    private maxKeys = 50000
  ) {}

  async hit(key: string): Promise<RateLimitResult> {
    const now = Date.now();
    let entry = this.windows.get(key);
    if (!entry || now >= entry.resetAt) {
      if (this.windows.size >= this.maxKeys) this.sweep(now);
      entry = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(key, entry);
    }
    entry.count += 1;
    return {
      allowed: entry.count <= this.limit,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }

  private sweep(now: number): void {
    for (const [k, v] of this.windows) if (now >= v.resetAt) this.windows.delete(k);
    if (this.windows.size >= this.maxKeys) this.windows.clear();
  }
}

/**
 * Adapter for the Cloudflare Workers rate limiting binding (`[[ratelimits]]` in wrangler.toml).
 * Counters are shared by every isolate in a Cloudflare location and cost no KV/Upstash quota,
 * so this is the default shared limiter for free-tier meshes.
 */
export class CloudflareRateLimiter implements RateLimiter {
  constructor(private binding: { limit(opts: { key: string }): Promise<{ success: boolean }> }) {}

  async hit(key: string): Promise<RateLimitResult> {
    const { success } = await this.binding.limit({ key });
    return { allowed: success, retryAfterSeconds: 60 };
  }
}
