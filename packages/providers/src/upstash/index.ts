import { DeployNotAutomatedError, type ProviderAdapter, type ProviderLimits, type DeployResult } from '@omnimesh/core';
import limitsJson from './limits.json' with { type: 'json' };

export const upstashAdapter: ProviderAdapter = {
  id: 'upstash',
  displayName: 'Upstash Serverless Redis',
  requiresCard: false,
  tier: 'free',
  roles: ['cache'],
  limits: limitsJson as unknown as ProviderLimits,

  async validateCredentials(config: Record<string, string>): Promise<boolean> {
    const url = config.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_REST_URL;
    const token = config.UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) return false;
    try {
      const res = await fetch(`${url.replace(/\/$/, '')}/ping`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json() as { result: string };
      return data.result === 'PONG';
    } catch {
      return false; // unreachable API means unverified, never valid
    }
  },

  async deploy(): Promise<DeployResult> {
    throw new DeployNotAutomatedError(this.displayName, 'Create it in the provider dashboard and put its URL/credentials in .env; there is nothing to deploy.');
  },

  healthUrl(deployment: DeployResult | { url: string }): string {
    return `${deployment.url.replace(/\/$/, '')}/ping`;
  },

  async destroy(_deployment: DeployResult, _config: Record<string, string>): Promise<void> {},
};
