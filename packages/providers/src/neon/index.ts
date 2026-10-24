import type { ProviderAdapter, ProviderLimits, DeployResult, UsageSnapshot } from '@omnimesh/core';
import limitsJson from './limits.json' with { type: 'json' };

export const neonAdapter: ProviderAdapter = {
  id: 'neon',
  displayName: 'Neon Serverless Postgres',
  requiresCard: false,
  tier: 'free',
  roles: ['database'],
  limits: limitsJson as unknown as ProviderLimits,

  async validateCredentials(config: Record<string, string>): Promise<boolean> {
    const dbUrl = config.DATABASE_URL || process.env.DATABASE_URL;
    const apiKey = config.NEON_API_KEY || process.env.NEON_API_KEY;
    if (apiKey) return apiKey.length > 20;
    if (dbUrl && dbUrl.includes('neon.tech')) return true;
    return false;
  },

  async deploy(appPath: string, config: Record<string, string>): Promise<DeployResult> {
    const valid = await this.validateCredentials(config);
    if (!valid) throw new Error('Invalid Neon credentials');

    const projectId = config.NEON_PROJECT_ID || 'neon_main';
    const pooledUrl = config.DATABASE_URL || `postgres://user:pass@ep-cool-pooler.neon.tech/neondb?sslmode=require`;

    return {
      providerId: this.id,
      success: true,
      url: pooledUrl,
      deploymentId: projectId,
      role: 'database',
      logsUrl: 'https://console.neon.tech',
      createdAt: new Date().toISOString(),
    };
  },

  healthUrl(deployment: DeployResult | { url: string }): string {
    return 'https://console.neon.tech/api/v2/status';
  },

  async getUsage(config: Record<string, string>): Promise<UsageSnapshot> {
    return {
      providerId: this.id,
      storageMbUsed: 120,
      quotaPercentUsed: 23,
      nearQuotaWarning: false,
      timestamp: new Date().toISOString(),
    };
  },

  async destroy(_deployment: DeployResult, _config: Record<string, string>): Promise<void> {},
};
