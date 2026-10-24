import { describe, it, expect, vi } from 'vitest';
import worker from '../src/index.js';

const SECRET = 's'.repeat(40);
const yaml = (domain: string) => `
domain: ${domain}
pools:
  /api:
    - https://node-1.example.com
rateLimit: { enabled: true, requestsPerMinute: 60 }
`;

describe('[H-4] Worker rate limiting is shared, per IP and per user', () => {
  it('asks the shared Cloudflare binding for both the client IP and the caller', async () => {
    const keys: string[] = [];
    const RATE_LIMITER = { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: !key.startsWith('user:') }; } };
    const env = { OMNIMESH_CONFIG_YAML: yaml('a.example.com'), GATEWAY_SECRET: SECRET, RATE_LIMITER };

    const res = await worker.fetch(
      new Request('https://a.example.com/api/x', { headers: { 'CF-Connecting-IP': '203.0.113.5', Authorization: 'Bearer abc' } }),
      env,
      {}
    );
    expect(res.status).toBe(429);
    expect(keys).toContain('ip:203.0.113.5');
    // A stolen token spread across many IPs is still limited as one caller
    expect(keys.some((k) => k.startsWith('user:'))).toBe(true);
    expect(keys.join()).not.toContain('abc'); // raw tokens are never used as limiter keys
  });

  it('warns when rate limiting is enabled but no shared binding is configured', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = { OMNIMESH_CONFIG_YAML: yaml('b.example.com'), GATEWAY_SECRET: SECRET };
    await worker.fetch(new Request('https://b.example.com/_omnimesh/status'), env, {});
    expect(warn.mock.calls.flat().join(' ')).toMatch(/RATE_LIMITER/);
    warn.mockRestore();
  });
});
