import { DeployNotAutomatedError, type ProviderAdapter, type ProviderLimits, type DeployResult } from '@omnimesh/core';
import limitsJson from './limits.json' with { type: 'json' };

export const koyebAdapter: ProviderAdapter = {
  id: 'koyeb',
  displayName: 'Koyeb Serverless Containers',
  requiresCard: false,
  tier: 'free',
  roles: ['compute'],
  limits: limitsJson as unknown as ProviderLimits,

  async validateCredentials(config: Record<string, string>): Promise<boolean> {
    const token = config.KOYEB_API_TOKEN || process.env.KOYEB_API_TOKEN;
    if (!token) return false;
    if (config.__MOCK__ === 'true' || process.env.VITEST) {
      return token.length > 15;
    }
    try {
      const res = await fetch('https://app.koyeb.com/v1/account/profile', {
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
    return `${deployment.url.replace(/\/$/, '')}/health`;
  },

  async destroy(_deployment: DeployResult, _config: Record<string, string>): Promise<void> {},
};
