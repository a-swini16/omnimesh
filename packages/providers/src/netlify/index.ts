import { DeployNotAutomatedError, type ProviderAdapter, type ProviderLimits, type DeployResult } from '@omnimesh/core';
import limitsJson from './limits.json' with { type: 'json' };

export const netlifyAdapter: ProviderAdapter = {
  id: 'netlify',
  displayName: 'Netlify Functions & Webhooks',
  requiresCard: false,
  tier: 'free',
  roles: ['compute'],
  limits: limitsJson as unknown as ProviderLimits,

  async validateCredentials(config: Record<string, string>): Promise<boolean> {
    const token = config.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_AUTH_TOKEN;
    if (!token) return false;
    try {
      const res = await fetch('https://api.netlify.com/api/v1/user', {
        headers: { Authorization: `Bearer ${token}` },
      });
      return res.ok;
    } catch {
      return false; // unreachable API means unverified, never valid
    }
  },

  async deploy(): Promise<DeployResult> {
    throw new DeployNotAutomatedError(this.displayName, 'Connect this repo in the provider dashboard (Git auto-deploy on push); `omnimesh deploy` then verifies /health on every node.');
  },

  healthUrl(deployment: DeployResult | { url: string }): string {
    return `${deployment.url.replace(/\/$/, '')}/.netlify/functions/health`;
  },

  async destroy(_deployment: DeployResult, _config: Record<string, string>): Promise<void> {},
};
