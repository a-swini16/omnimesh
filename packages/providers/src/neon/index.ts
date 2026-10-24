import { DeployNotAutomatedError, type ProviderAdapter, type ProviderLimits, type DeployResult } from '@omnimesh/core';
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

  async deploy(): Promise<DeployResult> {
    throw new DeployNotAutomatedError(this.displayName, 'Create it in the provider dashboard and put its URL/credentials in .env; there is nothing to deploy.');
  },

  healthUrl(deployment: DeployResult | { url: string }): string {
    return 'https://console.neon.tech/api/v2/status';
  },

  async destroy(_deployment: DeployResult, _config: Record<string, string>): Promise<void> {},
};
