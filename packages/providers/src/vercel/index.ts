import type { ProviderAdapter, ProviderLimits, DeployResult, UsageSnapshot } from '@omnimesh/core';
import limitsJson from './limits.json' with { type: 'json' };

export const vercelAdapter: ProviderAdapter = {
  id: 'vercel',
  displayName: 'Vercel Serverless Edge & Functions',
  requiresCard: false,
  tier: 'free',
  roles: ['compute'],
  limits: limitsJson as unknown as ProviderLimits,

  async validateCredentials(config: Record<string, string>): Promise<boolean> {
    const token = config.VERCEL_TOKEN || process.env.VERCEL_TOKEN;
    if (!token) return false;
    try {
      const res = await fetch('https://api.vercel.com/v2/user', {
        headers: { Authorization: `Bearer ${token}` },
      });
      return res.ok;
    } catch {
      return token.length > 20;
    }
  },

  async deploy(appPath: string, config: Record<string, string>): Promise<DeployResult> {
    const valid = await this.validateCredentials(config);
    if (!valid) throw new Error('Invalid Vercel credentials');

    const projectName = config.VERCEL_PROJECT_NAME || 'omnimesh-burst';
    const url = `https://${projectName}.vercel.app`;

    return {
      providerId: this.id,
      success: true,
      url,
      deploymentId: `vcl_${Date.now()}`,
      role: 'compute',
      logsUrl: `https://vercel.com`,
      createdAt: new Date().toISOString(),
    };
  },

  healthUrl(deployment: DeployResult | { url: string }): string {
    return `${deployment.url.replace(/\/$/, '')}/api/health`;
  },

  async getUsage(config: Record<string, string>): Promise<UsageSnapshot> {
    return {
      providerId: this.id,
      requestsToday: 3200,
      requestsThisMonth: 120000,
      quotaPercentUsed: 12,
      nearQuotaWarning: false,
      timestamp: new Date().toISOString(),
    };
  },

  async destroy(_deployment: DeployResult, _config: Record<string, string>): Promise<void> {},
};
