import { DeployNotAutomatedError, type ProviderAdapter, type ProviderLimits, type DeployResult } from '@omnimesh/core';
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

  async deploy(): Promise<DeployResult> {
    throw new DeployNotAutomatedError(this.displayName, 'On the VM run `docker compose up -d` with packages/providers/src/oracle/docker-compose.yml.');
  },

  healthUrl(deployment: DeployResult | { url: string }): string {
    return `${deployment.url.replace(/\/$/, '')}/health`;
  },

  async destroy(_deployment: DeployResult, _config: Record<string, string>): Promise<void> {},
};
