import type { ProviderAdapter } from '@omnimesh/core';

import { cloudflareAdapter } from './cloudflare/index.js';
import { koyebAdapter } from './koyeb/index.js';
import { renderAdapter } from './render/index.js';
import { vercelAdapter } from './vercel/index.js';
import { netlifyAdapter } from './netlify/index.js';
import { denoDeployAdapter } from './deno-deploy/index.js';
import { neonAdapter } from './neon/index.js';
import { supabaseAdapter } from './supabase/index.js';
import { upstashAdapter } from './upstash/index.js';
import { oracleAdapter } from './oracle/index.js';
import { cloudflareR2Adapter } from './cloudflare-r2/index.js';
import { railwayAdapter } from './railway/index.js';
import { flyioAdapter } from './flyio/index.js';

export {
  cloudflareAdapter,
  koyebAdapter,
  renderAdapter,
  vercelAdapter,
  netlifyAdapter,
  denoDeployAdapter,
  neonAdapter,
  supabaseAdapter,
  upstashAdapter,
  oracleAdapter,
  cloudflareR2Adapter,
  railwayAdapter,
  flyioAdapter,
};

export const PROVIDERS_REGISTRY: Record<string, ProviderAdapter> = {
  cloudflare: cloudflareAdapter,
  koyeb: koyebAdapter,
  render: renderAdapter,
  vercel: vercelAdapter,
  netlify: netlifyAdapter,
  'deno-deploy': denoDeployAdapter,
  neon: neonAdapter,
  supabase: supabaseAdapter,
  upstash: upstashAdapter,
  oracle: oracleAdapter,
  'cloudflare-r2': cloudflareR2Adapter,
  railway: railwayAdapter,
  flyio: flyioAdapter,
};

export function getAllProviders(): ProviderAdapter[] {
  return Object.values(PROVIDERS_REGISTRY);
}

export function getNoCardProviders(): ProviderAdapter[] {
  return getAllProviders().filter((p) => !p.requiresCard && p.tier === 'free');
}

export function getCardProviders(): ProviderAdapter[] {
  return getAllProviders().filter((p) => p.requiresCard || p.tier !== 'free');
}

export function getProvider(id: string): ProviderAdapter | undefined {
  return PROVIDERS_REGISTRY[id];
}
