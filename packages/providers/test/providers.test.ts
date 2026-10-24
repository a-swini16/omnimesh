import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
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
    ).toBe(false); // unreachable/fake endpoint must never count as valid
  });

  it('[H-5] never reports a deploy or usage numbers that did not really happen', async () => {
    const fakeCreds: Record<string, string> = {
      KOYEB_API_TOKEN: 'koyeb_api_token_sample_key', RENDER_API_KEY: 'rnd_sample_key_1234567890',
      VERCEL_TOKEN: 'v'.repeat(24), NETLIFY_AUTH_TOKEN: 'n'.repeat(24), CLOUDFLARE_API_TOKEN: 'c'.repeat(24),
      CF_TUNNEL_TOKEN: 'tunnel', ORACLE_HOST: 'oracle.example.com', __MOCK__: 'true',
    };
    for (const provider of getAllProviders()) {
      // Usage must come from the provider's API; hardcoded numbers mislead quota decisions
      expect(provider.getUsage, `${provider.id}.getUsage`).toBeUndefined();
      const result = await provider.deploy('.', fakeCreds).then((r) => r, (e: Error) => e);
      expect(result, `${provider.id}.deploy`).toBeInstanceOf(Error);
      expect((result as Error).message, provider.id).toMatch(/omnimesh deploy|wrangler|dashboard|Git|docker compose/i);
    }
  });

  it('[M-8] Oracle docker-compose: pinned images, no public ports, least privilege', () => {
    const file = path.resolve(__dirname, '../src/oracle/docker-compose.yml');
    const compose = YAML.parse(fs.readFileSync(file, 'utf-8'));
    for (const [name, svc] of Object.entries<any>(compose.services)) {
      if (svc.image) {
        const tag = svc.image.split('/').pop().split(':')[1];
        expect(tag, `${name} image tag`).toBeTruthy();
        expect(tag, `${name} image tag`).not.toBe('latest');
      }
      expect(svc.ports, `${name} must not publish ports (Cloudflare Tunnel only)`).toBeUndefined();
      expect(svc.security_opt, `${name} security_opt`).toContain('no-new-privileges:true');
    }
    const api = compose.services['core-api'];
    expect(api.user, 'core-api must not run as root').toMatch(/^\$\{?[A-Z_:-]*\d+|^\d+/);
    expect(api.read_only).toBe(true);
    expect(api.cap_drop).toContain('ALL');
  });
});
