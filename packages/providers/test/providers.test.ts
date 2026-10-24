import { describe, it, expect } from 'vitest';
import {
  getAllProviders,
  getNoCardProviders,
  getCardProviders,
  getProvider,
} from '../src/index.js';

describe('OmniMesh Provider Adapter Registry & Verified Limits', () => {
  it('loads all registered provider adapters', () => {
    const providers = getAllProviders();
    expect(providers.length).toBeGreaterThanOrEqual(10);

    const ids = providers.map((p) => p.id);
    expect(ids).toContain('cloudflare');
    expect(ids).toContain('koyeb');
    expect(ids).toContain('render');
    expect(ids).toContain('vercel');
    expect(ids).toContain('netlify');
    expect(ids).toContain('deno-deploy');
    expect(ids).toContain('neon');
    expect(ids).toContain('supabase');
    expect(ids).toContain('upstash');
    expect(ids).toContain('oracle');
    expect(ids).toContain('cloudflare-r2');
  });

  it('guarantees every provider has verified limits with source URL and date', () => {
    const providers = getAllProviders();
    for (const provider of providers) {
      expect(provider.limits).toBeDefined();
      expect(provider.limits.lastVerified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(provider.limits.sourceUrl).toMatch(/^https?:\/\//);
      expect(typeof provider.displayName).toBe('string');
      expect(typeof provider.requiresCard).toBe('boolean');
      expect(['free', 'trial-credit', 'paid']).toContain(provider.tier);
    }
  });

  it('correctly filters no-card providers', () => {
    const noCard = getNoCardProviders();
    expect(noCard.length).toBeGreaterThanOrEqual(7);

    const ids = noCard.map((p) => p.id);
    expect(ids).toContain('cloudflare');
    expect(ids).toContain('koyeb');
    expect(ids).toContain('render');
    expect(ids).toContain('vercel');
    expect(ids).toContain('netlify');
    expect(ids).toContain('neon');
    expect(ids).toContain('upstash');
    expect(ids).toContain('supabase');

    // Oracle, R2, Railway must NEVER be in no-card
    expect(ids).not.toContain('oracle');
    expect(ids).not.toContain('cloudflare-r2');
    expect(ids).not.toContain('railway');
  });

  it('correctly tags Oracle and R2 as requiring a card', () => {
    const oracle = getProvider('oracle');
    expect(oracle?.requiresCard).toBe(true);

    const r2 = getProvider('cloudflare-r2');
    expect(r2?.requiresCard).toBe(true);

    const cardProviders = getCardProviders();
    const cardIds = cardProviders.map((p) => p.id);
    expect(cardIds).toContain('oracle');
    expect(cardIds).toContain('cloudflare-r2');
  });

  it('accurately identifies sleeping providers (Render)', () => {
    const render = getProvider('render');
    expect(render?.limits.sleepsIfIdle).toBe(true);
    expect(render?.limits.idleSleepMinutes).toBe(15);
  });

  it('validates Koyeb adapter credential validator', async () => {
    const koyeb = getProvider('koyeb');
    expect(await koyeb?.validateCredentials({})).toBe(false);
    expect(await koyeb?.validateCredentials({ KOYEB_API_TOKEN: 'koyeb_api_token_sample_key' })).toBe(true);
  });

  it('validates Upstash adapter credential validator', async () => {
    const upstash = getProvider('upstash');
    expect(await upstash?.validateCredentials({})).toBe(false);
    expect(
      await upstash?.validateCredentials({
        UPSTASH_REDIS_REST_URL: 'https://sample.upstash.io',
        UPSTASH_REDIS_REST_TOKEN: 'valid_token_sample_123',
      })
    ).toBe(true);
  });
});
