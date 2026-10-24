import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import pc from 'picocolors';
import {
  generateDefaultConfig,
  stringifyOmniMeshConfigYaml,
  type OmniMeshConfig,
} from '@omnimesh/core';
import { getAllProviders, getProvider } from '@omnimesh/providers';

export interface InitOptions {
  card?: boolean;
  domain?: string;
  quick?: boolean;
  cwd?: string;
}

// Hostname suffix -> provider id, used to attach each provider's free-tier quota to its nodes
const HOST_PROVIDERS: [string, string][] = [
  ['.koyeb.app', 'koyeb'],
  ['.onrender.com', 'render'],
  ['.vercel.app', 'vercel'],
  ['.netlify.app', 'netlify'],
  ['.deno.dev', 'deno-deploy'],
  ['oracle', 'oracle'],
];

/**
 * Turn plain pool URLs into nodes tagged with providerId and request quota, so the router
 * moves traffic to the next free tier before a provider's limit is reached.
 */
export function attachProviderQuotas(config: OmniMeshConfig): OmniMeshConfig {
  for (const [poolPath, nodes] of Object.entries(config.pools)) {
    config.pools[poolPath] = nodes.map((node) => {
      if (typeof node !== 'string') return node;
      const host = new URL(node).hostname;
      const providerId = HOST_PROVIDERS.find(([suffix]) => host.endsWith(suffix) || host.includes(suffix))?.[1];
      const limits = providerId ? getProvider(providerId)?.limits : undefined;
      if (!providerId) return node;
      return {
        url: node,
        providerId,
        weight: 1,
        isBackup: false,
        ...(limits?.requestsPerDay ? { requestsPerDay: limits.requestsPerDay } : {}),
        ...(limits?.requestsPerMonth ? { requestsPerMonth: limits.requestsPerMonth } : {}),
      };
    });
  }
  return config;
}

export async function runInit(options: InitOptions = {}) {
  const cwd = options.cwd || process.cwd();
  console.log(pc.bold(pc.cyan('\n🌐 Welcome to OmniMesh Setup Wizard')));
  console.log(pc.dim('“Your free tiers, merged into one resilient cloud.”\n'));

  let hasCard = Boolean(options.card);
  let domain = options.domain || 'api.yourdomain.com';

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    if (!options.quick && options.card === undefined) {
      const cardAnswer = await rl.question(
        pc.bold('Do you have a credit/debit card for cloud sign-ups? (y/N): ')
      );
      hasCard = cardAnswer.trim().toLowerCase() === 'y';
    }

    if (hasCard) {
      console.log(
        pc.green('✔ Profile: With-Card (Includes Oracle ARM VM, Cloudflare R2, Neon, Koyeb, Render, etc.)')
      );
    } else {
      console.log(
        pc.green('✔ Profile: No-Card (100% Free: Cloudflare + Koyeb + Render + Vercel + Netlify + Neon + Upstash + Supabase Storage)')
      );
    }

    if (!options.quick && !options.domain) {
      const domainAnswer = await rl.question(
        pc.bold(`Custom domain for your unified backend [${domain}]: `)
      );
      if (domainAnswer.trim()) {
        domain = domainAnswer.trim();
      }
    }
  } finally {
    rl.close();
  }

  // 1. Generate cryptographically strong GATEWAY_SECRET (fail-closed, 64 hex characters)
  const gatewaySecret = crypto.randomBytes(32).toString('hex');

  // 2. Build default configuration
  const profile = hasCard ? 'with-card' : 'no-card';
  const config: OmniMeshConfig = attachProviderQuotas(generateDefaultConfig(profile));
  config.domain = domain;
  // The secret lives only in .env: omnimesh.config.yaml is meant to be committed

  // 3. Write omnimesh.config.yaml
  const configPath = path.join(cwd, 'omnimesh.config.yaml');
  const yamlContent = stringifyOmniMeshConfigYaml(config);
  fs.writeFileSync(configPath, yamlContent, 'utf-8');
  console.log(pc.green(`✔ Created ${pc.bold('omnimesh.config.yaml')}`));

  // 4. Write .env & .env.example
  const envPath = path.join(cwd, '.env');
  const envExamplePath = path.join(cwd, '.env.example');

  const jwtSecret = crypto.randomBytes(32).toString('hex');
  const envContent = `# OmniMesh Secrets & Provider Credentials
# Generated on ${new Date().toISOString()}
OMNIMESH_DOMAIN="${domain}"
GATEWAY_SECRET="${gatewaySecret}"
JWT_SECRET="${jwtSecret}"

# Provider Tokens (fill in as you sign up)
CLOUDFLARE_API_TOKEN=""
CLOUDFLARE_ACCOUNT_ID=""
KOYEB_API_TOKEN=""
RENDER_API_KEY=""
VERCEL_TOKEN=""
NETLIFY_AUTH_TOKEN=""
DENO_DEPLOY_TOKEN=""
DATABASE_URL="postgres://user:pass@ep-cool-pooler.neon.tech/neondb?sslmode=require"
UPSTASH_REDIS_REST_URL=""
UPSTASH_REDIS_REST_TOKEN=""
SUPABASE_URL=""
SUPABASE_ANON_KEY=""
${hasCard ? 'CF_TUNNEL_TOKEN=""\nORACLE_HOST=""\nR2_ACCESS_KEY_ID=""\nR2_SECRET_ACCESS_KEY=""' : ''}
`;

  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, envContent, { encoding: 'utf-8', mode: 0o600 });
    console.log(pc.green(`✔ Created ${pc.bold('.env')} (origin secrets populated)`));
  }
  // .env.example is committed, so every generated secret must be replaced
  const envExample = envContent
    .replace(gatewaySecret, 'generate-with-openssl-rand-hex-32')
    .replace(jwtSecret, 'generate-with-openssl-rand-hex-32');
  fs.writeFileSync(envExamplePath, envExample, 'utf-8');
  console.log(pc.green(`✔ Created ${pc.bold('.env.example')}`));

  // 5. Ensure .gitignore protects secrets
  const gitignorePath = path.join(cwd, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const gitignore = fs.readFileSync(gitignorePath, 'utf-8');
    if (!gitignore.includes('.env')) {
      fs.appendFileSync(gitignorePath, '\n.env\n.env.local\n');
      console.log(pc.green(`✔ Added .env to ${pc.bold('.gitignore')}`));
    }
  }

  // 6. Keep-Alive Engine: Provision GitHub Actions workflow for keeping Render & Koyeb awake!
  const workflowDir = path.join(cwd, '.github', 'workflows');
  fs.mkdirSync(workflowDir, { recursive: true });
  const keepAliveWorkflowPath = path.join(workflowDir, 'keep-alive.yml');

  const keepAliveWorkflow = `name: OmniMesh Node Keep-Alive
# Pings Render and Koyeb standby containers every 14 minutes to prevent cold-sleep
on:
  schedule:
    - cron: '*/14 * * * *'
  workflow_dispatch:

jobs:
  ping:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Ping Standby Nodes
        run: |
          echo "Pinging OmniMesh warm standby nodes..."
          curl -s -f -m 10 -H "X-Gateway-Secret: \${{ secrets.GATEWAY_SECRET }}" "https://\${{ vars.OMNIMESH_DOMAIN || '${domain}' }}/health" || true
`;

  fs.writeFileSync(keepAliveWorkflowPath, keepAliveWorkflow, 'utf-8');
  console.log(
    pc.green(
      `✔ Created GitHub Actions keep-alive engine: ${pc.bold('.github/workflows/keep-alive.yml')}`
    )
  );

  console.log(pc.bold(pc.cyan('\n✨ OmniMesh initialized successfully!')));
  console.log(`Next steps:`);
  console.log(`  1. Review your pools in ${pc.bold('omnimesh.config.yaml')}`);
  console.log(`  2. Add tokens to ${pc.bold('.env')}`);
  console.log(`  3. Run ${pc.bold(pc.yellow('omnimesh doctor'))} to verify credentials and limits`);
  console.log(`  4. Run ${pc.bold(pc.yellow('omnimesh deploy'))} to push across all providers`);
  console.log(`  5. Run ${pc.bold(pc.yellow('omnimesh chaos'))} to watch sub-3s failover live!\n`);
}
