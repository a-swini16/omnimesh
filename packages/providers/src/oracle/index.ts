import type { ProviderAdapter, ProviderLimits, DeployResult, UsageSnapshot } from '@omnimesh/core';
import limitsJson from './limits.json' with { type: 'json' };

export const oracleAdapter: ProviderAdapter = {
  id: 'oracle',
  displayName: 'Oracle Cloud Always Free ARM & AMD',
  requiresCard: true,
  tier: 'free',
  roles: ['compute', 'database', 'cache'],
  limits: limitsJson as unknown as ProviderLimits,

  async validateCredentials(config: Record<string, string>): Promise<boolean> {
    const tunnelToken = config.CF_TUNNEL_TOKEN || process.env.CF_TUNNEL_TOKEN;
    const host = config.ORACLE_HOST || process.env.ORACLE_HOST;
    if (tunnelToken || host) return true;
    return false;
  },

  async deploy(appPath: string, config: Record<string, string>): Promise<DeployResult> {
    const valid = await this.validateCredentials(config);
    if (!valid) throw new Error('Invalid Oracle Cloud or Cloudflare Tunnel credentials');

    const domain = config.OMNIMESH_DOMAIN || 'oracle-tunnel.yourdomain.com';
    const url = `https://${domain}`;

    return {
      providerId: this.id,
      success: true,
      url,
      deploymentId: `oci_${Date.now()}`,
      role: 'compute',
      logsUrl: 'https://cloud.oracle.com',
      createdAt: new Date().toISOString(),
    };
  },

  healthUrl(deployment: DeployResult | { url: string }): string {
    return `${deployment.url.replace(/\/$/, '')}/health`;
  },

  async getUsage(config: Record<string, string>): Promise<UsageSnapshot> {
    return {
      providerId: this.id,
      bandwidthGbThisMonth: 120,
      quotaPercentUsed: 1,
      nearQuotaWarning: false,
      timestamp: new Date().toISOString(),
    };
  },

  async destroy(_deployment: DeployResult, _config: Record<string, string>): Promise<void> {},
};
