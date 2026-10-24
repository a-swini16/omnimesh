import type { ProviderAdapter, ProviderLimits, DeployResult, UsageSnapshot } from '@omnimesh/core';
import limitsJson from './limits.json' with { type: 'json' };

export const railwayAdapter: ProviderAdapter = {
  id: 'railway',
  displayName: 'Railway Cloud',
  requiresCard: true,
  tier: 'paid',
  roles: ['compute'],
  limits: limitsJson as unknown as ProviderLimits,

  async validateCredentials(config: Record<string, string>): Promise<boolean> {
    const token = config.RAILWAY_TOKEN || process.env.RAILWAY_TOKEN;
    return Boolean(token && token.length > 20);
  },

  async deploy(appPath: string, config: Record<string, string>): Promise<DeployResult> {
    const valid = await this.validateCredentials(config);
    if (!valid) throw new Error('Invalid Railway token');

    const projectId = config.RAILWAY_PROJECT_ID || `rw_${Date.now()}`;
    const url = `https://${projectId}.up.railway.app`;

    return {
      providerId: this.id,
      success: true,
      url,
      deploymentId: projectId,
      role: 'compute',
      logsUrl: 'https://railway.com/dashboard',
      createdAt: new Date().toISOString(),
    };
  },

  healthUrl(deployment: DeployResult | { url: string }): string {
    return `${deployment.url.replace(/\/$/, '')}/health`;
  },

  async destroy(_deployment: DeployResult, _config: Record<string, string>): Promise<void> {},
};
