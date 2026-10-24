import type { ProviderAdapter, ProviderLimits, DeployResult, UsageSnapshot } from '@omnimesh/core';
import limitsJson from './limits.json' with { type: 'json' };

export const flyioAdapter: ProviderAdapter = {
  id: 'flyio',
  displayName: 'Fly.io Global Application Platform',
  requiresCard: true,
  tier: 'paid',
  roles: ['compute'],
  limits: limitsJson as unknown as ProviderLimits,

  async validateCredentials(config: Record<string, string>): Promise<boolean> {
    const token = config.FLY_API_TOKEN || process.env.FLY_API_TOKEN;
    return Boolean(token && token.length > 20);
  },

  async deploy(appPath: string, config: Record<string, string>): Promise<DeployResult> {
    const valid = await this.validateCredentials(config);
    if (!valid) throw new Error('Invalid Fly.io API token');

    const appName = config.FLY_APP_NAME || 'omnimesh-fly';
    const url = `https://${appName}.fly.dev`;

    return {
      providerId: this.id,
      success: true,
      url,
      deploymentId: `fly_${Date.now()}`,
      role: 'compute',
      logsUrl: 'https://fly.io/dashboard',
      createdAt: new Date().toISOString(),
    };
  },

  healthUrl(deployment: DeployResult | { url: string }): string {
    return `${deployment.url.replace(/\/$/, '')}/health`;
  },

  async destroy(_deployment: DeployResult, _config: Record<string, string>): Promise<void> {},
};
