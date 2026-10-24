import { DeployNotAutomatedError, type ProviderAdapter, type ProviderLimits, type DeployResult } from '@omnimesh/core';
import limitsJson from './limits.json' with { type: 'json' };

export const renderAdapter: ProviderAdapter = {
  id: 'render',
  displayName: 'Render Cloud Application Hosting',
  requiresCard: false,
  tier: 'free',
  roles: ['compute'],
  limits: limitsJson as unknown as ProviderLimits,

  async validateCredentials(config: Record<string, string>): Promise<boolean> {
    const apiKey = config.RENDER_API_KEY || process.env.RENDER_API_KEY;
    if (!apiKey) return false;
    try {
      const res = await fetch('https://api.render.com/v1/owners', {
        headers: { Authorization: `Bearer ${apiKey}` },
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
    return `${deployment.url.replace(/\/$/, '')}/health`;
  },

  async destroy(_deployment: DeployResult, _config: Record<string, string>): Promise<void> {},
};
