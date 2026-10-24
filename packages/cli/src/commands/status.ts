import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { parseOmniMeshConfigYaml } from '@omnimesh/core';
import { getProvider } from '@omnimesh/providers';

export interface StatusOptions {
  cwd?: string;
}

export async function runStatus(options: StatusOptions = {}) {
  const cwd = options.cwd || process.cwd();
  console.log(pc.bold(pc.cyan('\n📊 OmniMesh Cluster Status & Provider Quotas\n')));

  const configPath = path.join(cwd, 'omnimesh.config.yaml');
  if (!fs.existsSync(configPath)) {
    console.log(pc.red('✖ No omnimesh.config.yaml found. Run `npx omnimesh init` first.'));
    return;
  }

  const rawYaml = fs.readFileSync(configPath, 'utf-8');
  const config = parseOmniMeshConfigYaml(rawYaml);

  console.log(`Domain:  ${pc.bold(config.domain)} (Profile: ${pc.bold(config.profile)})`);
  console.log(`Router:  Timeout ${config.router.timeoutMs}ms | Max Attempts: ${config.router.maxAttempts} | Budget: ${config.router.totalBudgetMs}ms\n`);

  console.log(pc.bold('Active Pools & Upstream Nodes:'));

  for (const [poolPath, nodes] of Object.entries(config.pools)) {
    console.log(pc.cyan(`\n  Pool: ${pc.bold(poolPath)}`));

    for (const rawNode of nodes as any[]) {
      const url = typeof rawNode === 'string' ? rawNode : rawNode.url;
      const t0 = Date.now();
      let statusStr = pc.yellow('CHECKING...');
      let latency = 0;

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(`${url.replace(/\/$/, '')}/health`, {
          signal: controller.signal,
          headers: {
            'X-Gateway-Secret': config.gatewaySecret || process.env.GATEWAY_SECRET || '',
          },
        });
        clearTimeout(timeout);
        latency = Date.now() - t0;
        statusStr = res.ok ? pc.green('HEALTHY (200 OK)') : pc.red(`DEGRADED (${res.status})`);
      } catch (err: any) {
        latency = Date.now() - t0;
        statusStr = pc.red(`OFFLINE (${err.message})`);
      }

      console.log(`    • ${pc.bold(url)} -> ${statusStr} ${pc.dim(`[${latency}ms]`)}`);
    }
  }

  console.log(pc.bold('\nProvider Quotas & Health:'));
  const checkedProviders = ['cloudflare', 'koyeb', 'render', 'vercel', 'neon', 'upstash'];
  for (const providerId of checkedProviders) {
    const provider = getProvider(providerId);
    if (!provider) continue;

    const limits = provider.limits;
    const quotaDesc = limits.requestsPerDay
      ? `${limits.requestsPerDay.toLocaleString()} req/day`
      : limits.bandwidthGbPerMonth
        ? `${limits.bandwidthGbPerMonth} GB/mo`
        : 'Active Free Tier';

    const cardBadge = provider.requiresCard ? pc.yellow('[Card Required]') : pc.green('[No Card Needed]');
    console.log(
      `  • ${pc.bold(provider.displayName)}: ${pc.dim(quotaDesc)} ${cardBadge}`
    );
  }

  console.log(pc.dim('\nTip: Run `omnimesh chaos` to test failover responsiveness.\n'));
}
