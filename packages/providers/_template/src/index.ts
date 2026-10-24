import type {
  ProviderAdapter,
  ProviderLimits,
  DeployResult,
  UsageSnapshot,
} from '@omnimesh/core';
import limitsData from '../limits.json' with { type: 'json' };

export const templateAdapter: ProviderAdapter = {
  id: 'template',
  displayName: 'Template Provider',
  requiresCard: false,
  tier: 'free',
  roles: ['compute'],
  limits: limitsData as unknown as ProviderLimits,

  async validateCredentials(config: Record<string, string>): Promise<boolean> {
    const token = config.TEMPLATE_API_TOKEN || process.env.TEMPLATE_API_TOKEN;
    if (!token) return false;
    // In production, make a lightweight API call to the provider's /me or /auth endpoint
    return token.length > 10;
  },

  async deploy(appPath: string, config: Record<string, string>): Promise<DeployResult> {
    const valid = await this.validateCredentials(config);
    if (!valid) {
      throw new Error(`Invalid credentials for ${this.displayName}`);
    }

    // In production, invoke the provider's CLI or REST API to trigger a deployment
    const deploymentId = `dep_${Math.random().toString(36).substring(2, 9)}`;
    const url = `https://${deploymentId}.template-cloud.app`;

    return {
      providerId: this.id,
      success: true,
      url,
      deploymentId,
      role: 'compute',
      logsUrl: `${url}/_logs`,
      createdAt: new Date().toISOString(),
    };
  },

  healthUrl(deployment: DeployResult | { url: string }): string {
    return `${deployment.url.replace(/\/$/, '')}/health`;
  },

  async getUsage(config: Record<string, string>): Promise<UsageSnapshot> {
    return {
      providerId: this.id,
      requestsToday: 1200,
      requestsThisMonth: 34000,
      quotaPercentUsed: 12,
      nearQuotaWarning: false,
      timestamp: new Date().toISOString(),
    };
  },

  async destroy(deployment: DeployResult, config: Record<string, string>): Promise<void> {
    // Teardown deployment via provider API
  },
};

export default templateAdapter;
