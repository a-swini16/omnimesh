import { DeployNotAutomatedError, type ProviderAdapter, type ProviderLimits, type DeployResult } from '@omnimesh/core';
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

  async deploy(): Promise<DeployResult> {
    throw new DeployNotAutomatedError(this.displayName, 'Create it in the provider dashboard and put its URL/credentials in .env; there is nothing to deploy.');
  },

  healthUrl(deployment: DeployResult | { url: string }): string {
    return deployment.url;
  },

  async destroy(_deployment: DeployResult, _config: Record<string, string>): Promise<void> {},
};
