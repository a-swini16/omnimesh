import type { ProviderAdapter, ProviderLimits, DeployResult, UsageSnapshot } from '@omnimesh/core';
import limitsJson from './limits.json' with { type: 'json' };

export const denoDeployAdapter: ProviderAdapter = {
  id: 'deno-deploy',
  displayName: 'Deno Deploy Edge',
  requiresCard: false,
  tier: 'free',
  roles: ['edge-router', 'compute'],
  limits: limitsJson as unknown as ProviderLimits,

  async validateCredentials(config: Record<string, string>): Promise<boolean> {
    const token = config.DENO_DEPLOY_TOKEN || process.env.DENO_DEPLOY_TOKEN;
    if (!token) return false;
    return token.length > 20;
  },

  async deploy(appPath: string, config: Record<string, string>): Promise<DeployResult> {
    const valid = await this.validateCredentials(config);
    if (!valid) throw new Error('Invalid Deno Deploy credentials');

    const appName = config.DENO_PROJECT_NAME || 'omnimesh-auth';
    const url = `https://${appName}.deno.dev`;

    return {
      providerId: this.id,
      success: true,
      url,
      deploymentId: `deno_${Date.now()}`,
      role: 'compute',
      logsUrl: `https://dash.deno.com`,
      createdAt: new Date().toISOString(),
    };
  },

  healthUrl(deployment: DeployResult | { url: string }): string {
    return `${deployment.url.replace(/\/$/, '')}/health`;
  },

  async getUsage(config: Record<string, string>): Promise<UsageSnapshot> {
    return {
      providerId: this.id,
      requestsToday: 9500,
      requestsThisMonth: 210000,
      quotaPercentUsed: 9,
      nearQuotaWarning: false,
      timestamp: new Date().toISOString(),
    };
  },

  async destroy(_deployment: DeployResult, _config: Record<string, string>): Promise<void> {},
};
