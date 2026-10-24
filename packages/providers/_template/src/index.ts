import { DeployNotAutomatedError, type ProviderAdapter, type ProviderLimits, type DeployResult } from '@omnimesh/core';
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

  async deploy(): Promise<DeployResult> {
    throw new DeployNotAutomatedError(this.displayName, 'Connect this repo in the provider dashboard (Git auto-deploy on push); `omnimesh deploy` then verifies /health on every node.');
  },

  healthUrl(deployment: DeployResult | { url: string }): string {
    return `${deployment.url.replace(/\/$/, '')}/health`;
  },

  async destroy(deployment: DeployResult, config: Record<string, string>): Promise<void> {
    // Teardown deployment via provider API
  },
};

export default templateAdapter;
