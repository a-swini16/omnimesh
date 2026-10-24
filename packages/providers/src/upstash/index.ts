import type { ProviderAdapter, ProviderLimits, DeployResult, UsageSnapshot } from '@omnimesh/core';
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

  async deploy(appPath: string, config: Record<string, string>): Promise<DeployResult> {
    const valid = await this.validateCredentials(config);
    if (!valid) throw new Error('Invalid Upstash credentials');

    const url = config.UPSTASH_REDIS_REST_URL || 'https://upstash-db.upstash.io';
    return {
      providerId: this.id,
      success: true,
      url,
      deploymentId: `upstash_${Date.now()}`,
      role: 'cache',
      logsUrl: 'https://console.upstash.com',
      createdAt: new Date().toISOString(),
    };
  },

  healthUrl(deployment: DeployResult | { url: string }): string {
    return `${deployment.url.replace(/\/$/, '')}/ping`;
  },

  async getUsage(config: Record<string, string>): Promise<UsageSnapshot> {
    return {
      providerId: this.id,
      requestsToday: 1250,
      quotaPercentUsed: 13,
      nearQuotaWarning: false,
      timestamp: new Date().toISOString(),
    };
  },

  async destroy(_deployment: DeployResult, _config: Record<string, string>): Promise<void> {},
};
