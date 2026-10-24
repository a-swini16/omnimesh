import type { ProviderAdapter, ProviderLimits, DeployResult, UsageSnapshot } from '@omnimesh/core';
import limitsJson from './limits.json' with { type: 'json' };

export const cloudflareR2Adapter: ProviderAdapter = {
  id: 'cloudflare-r2',
  displayName: 'Cloudflare R2 Object Storage',
  requiresCard: true,
  tier: 'free',
  roles: ['storage'],
  limits: limitsJson as unknown as ProviderLimits,

  async validateCredentials(config: Record<string, string>): Promise<boolean> {
    const accessKey = config.R2_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID;
    const secretKey = config.R2_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY;
    const accountId = config.CLOUDFLARE_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
    return Boolean(accessKey && secretKey && accountId);
  },

  async deploy(appPath: string, config: Record<string, string>): Promise<DeployResult> {
    const valid = await this.validateCredentials(config);
    if (!valid) throw new Error('Invalid Cloudflare R2 credentials');

    const accountId = config.CLOUDFLARE_ACCOUNT_ID;
    const bucket = config.R2_BUCKET_NAME || 'omnimesh-assets';
    const url = `https://${accountId}.r2.cloudflarestorage.com/${bucket}`;

    return {
      providerId: this.id,
      success: true,
      url,
      deploymentId: `r2_${bucket}`,
      role: 'storage',
      logsUrl: 'https://dash.cloudflare.com',
      createdAt: new Date().toISOString(),
    };
  },

  healthUrl(deployment: DeployResult | { url: string }): string {
    return deployment.url;
  },

  async getUsage(config: Record<string, string>): Promise<UsageSnapshot> {
    return {
      providerId: this.id,
      storageMbUsed: 850,
      quotaPercentUsed: 8,
      nearQuotaWarning: false,
      timestamp: new Date().toISOString(),
    };
  },

  async destroy(_deployment: DeployResult, _config: Record<string, string>): Promise<void> {},
};
