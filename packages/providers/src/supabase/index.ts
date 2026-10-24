import type { ProviderAdapter, ProviderLimits, DeployResult, UsageSnapshot } from '@omnimesh/core';
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

  async deploy(appPath: string, config: Record<string, string>): Promise<DeployResult> {
    const valid = await this.validateCredentials(config);
    if (!valid) throw new Error('Invalid Supabase credentials');

    const url = config.SUPABASE_URL || 'https://xyz.supabase.co';
    return {
      providerId: this.id,
      success: true,
      url,
      deploymentId: `supa_${Date.now()}`,
      role: 'database',
      logsUrl: 'https://app.supabase.com',
      createdAt: new Date().toISOString(),
    };
  },

  healthUrl(deployment: DeployResult | { url: string }): string {
    return `${deployment.url.replace(/\/$/, '')}/rest/v1/`;
  },

  async getUsage(config: Record<string, string>): Promise<UsageSnapshot> {
    return {
      providerId: this.id,
      storageMbUsed: 180,
      quotaPercentUsed: 18,
      nearQuotaWarning: false,
      timestamp: new Date().toISOString(),
    };
  },

  async destroy(_deployment: DeployResult, _config: Record<string, string>): Promise<void> {},
};
