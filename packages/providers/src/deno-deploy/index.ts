import { DeployNotAutomatedError, type ProviderAdapter, type ProviderLimits, type DeployResult } from '@omnimesh/core';
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

  async deploy(): Promise<DeployResult> {
    throw new DeployNotAutomatedError(this.displayName, 'Connect this repo in the provider dashboard (Git auto-deploy on push); `omnimesh deploy` then verifies /health on every node.');
  },

  healthUrl(deployment: DeployResult | { url: string }): string {
    return `${deployment.url.replace(/\/$/, '')}/health`;
  },

  async destroy(_deployment: DeployResult, _config: Record<string, string>): Promise<void> {},
};
