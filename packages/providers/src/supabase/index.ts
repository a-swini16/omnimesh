import { DeployNotAutomatedError, type ProviderAdapter, type ProviderLimits, type DeployResult } from '@omnimesh/core';
import limitsJson from './limits.json' with { type: 'json' };

export const supabaseAdapter: ProviderAdapter = {
  id: 'supabase',
  displayName: 'Supabase Postgres & Object Storage',
  requiresCard: false,
  tier: 'free',
  roles: ['database', 'storage'],
  limits: limitsJson as unknown as ProviderLimits,

  async validateCredentials(config: Record<string, string>): Promise<boolean> {
    const url = config.SUPABASE_URL || process.env.SUPABASE_URL;
    const key = config.SUPABASE_ANON_KEY || config.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!url || !key) return false;
    return url.includes('.supabase.co') && key.length > 20;
  },

  async deploy(): Promise<DeployResult> {
    throw new DeployNotAutomatedError(this.displayName, 'Create it in the provider dashboard and put its URL/credentials in .env; there is nothing to deploy.');
  },

  healthUrl(deployment: DeployResult | { url: string }): string {
    return `${deployment.url.replace(/\/$/, '')}/rest/v1/`;
  },

  async destroy(_deployment: DeployResult, _config: Record<string, string>): Promise<void> {},
};
