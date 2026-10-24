import { DeployNotAutomatedError, type ProviderAdapter, type ProviderLimits, type DeployResult } from '@omnimesh/core';
import limitsJson from './limits.json' with { type: 'json' };

export const cloudflareAdapter: ProviderAdapter = {
  id: 'cloudflare',
  displayName: 'Cloudflare Workers & CDN',
  requiresCard: false,
  tier: 'free',
  roles: ['edge-router', 'cache', 'cron'],
  limits: limitsJson as unknown as ProviderLimits,

  async validateCredentials(config: Record<string, string>): Promise<boolean> {
    const token = config.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
    if (!token) return false;
    try {
      const res = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json() as { success: boolean };
      return Boolean(data.success);
    } catch {
      return false; // unreachable API means unverified, never valid
    }
  },

  async deploy(): Promise<DeployResult> {
    throw new DeployNotAutomatedError(this.displayName, 'Deploy the router with `npx wrangler deploy` in packages/router (see wrangler.toml.example).');
  },

  healthUrl(deployment: DeployResult | { url: string }): string {
    return `${deployment.url.replace(/\/$/, '')}/_omnimesh/status`;
  },

  async destroy(_deployment: DeployResult, _config: Record<string, string>): Promise<void> {},
};
