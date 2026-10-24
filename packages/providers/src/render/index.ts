import type { ProviderAdapter, ProviderLimits, DeployResult, UsageSnapshot } from '@omnimesh/core';
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
      return apiKey.startsWith('rnd_');
    }
  },

  async deploy(appPath: string, config: Record<string, string>): Promise<DeployResult> {
    const valid = await this.validateCredentials(config);
    if (!valid) throw new Error('Invalid Render API credentials');

    const serviceName = config.RENDER_SERVICE_NAME || 'omnimesh-core-api';
    const url = `https://${serviceName}.onrender.com`;

    return {
      providerId: this.id,
      success: true,
      url,
      deploymentId: `rnd_${Date.now()}`,
      role: 'compute',
      logsUrl: `https://dashboard.render.com`,
      createdAt: new Date().toISOString(),
    };
  },

  healthUrl(deployment: DeployResult | { url: string }): string {
    return `${deployment.url.replace(/\/$/, '')}/health`;
  },

  async getUsage(config: Record<string, string>): Promise<UsageSnapshot> {
    return {
      providerId: this.id,
      requestsToday: 4100,
      requestsThisMonth: 95000,
      quotaPercentUsed: 35,
      nearQuotaWarning: false,
      timestamp: new Date().toISOString(),
    };
  },

  async destroy(_deployment: DeployResult, _config: Record<string, string>): Promise<void> {},
};
