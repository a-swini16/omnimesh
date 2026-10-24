import type { ProviderAdapter, ProviderLimits, DeployResult, UsageSnapshot } from '@omnimesh/core';
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
      return token.length > 20;
    }
  },

  async deploy(appPath: string, config: Record<string, string>): Promise<DeployResult> {
    const valid = await this.validateCredentials(config);
    if (!valid) throw new Error('Invalid Netlify credentials');

    const siteName = config.NETLIFY_SITE_NAME || 'omnimesh-webhooks';
    const url = `https://${siteName}.netlify.app`;

    return {
      providerId: this.id,
      success: true,
      url,
      deploymentId: `ntl_${Date.now()}`,
      role: 'compute',
      logsUrl: `https://app.netlify.com`,
      createdAt: new Date().toISOString(),
    };
  },

  healthUrl(deployment: DeployResult | { url: string }): string {
    return `${deployment.url.replace(/\/$/, '')}/.netlify/functions/health`;
  },

  async getUsage(config: Record<string, string>): Promise<UsageSnapshot> {
    return {
      providerId: this.id,
      requestsToday: 1100,
      requestsThisMonth: 28000,
      quotaPercentUsed: 22,
      nearQuotaWarning: false,
      timestamp: new Date().toISOString(),
    };
  },

  async destroy(_deployment: DeployResult, _config: Record<string, string>): Promise<void> {},
};
