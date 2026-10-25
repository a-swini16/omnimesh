import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { parseOmniMeshConfigYaml, isPlaceholderUrl, nodeHealthPath } from '@omnimesh/core';
import { readEnvFile } from '../env.js';
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

  const gatewaySecret = readEnvFile(cwd).GATEWAY_SECRET || config.gatewaySecret || '';
  console.log(pc.bold('Active Pools & Upstream Nodes:'));

  for (const [poolPath, nodes] of Object.entries(config.pools)) {
    console.log(pc.cyan(`\n  Pool: ${pc.bold(poolPath)}`));

    for (const rawNode of nodes as any[]) {
      const url = typeof rawNode === 'string' ? rawNode : rawNode.url;
      if (isPlaceholderUrl(url)) {
        console.log(`    • ${pc.bold(url)} -> ${pc.yellow('PLACEHOLDER (replace with your deployed app URL)')}`);
        continue;
      }
      const t0 = Date.now();
      let statusStr = pc.yellow('CHECKING...');
      let latency = 0;

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(`${url.replace(/\/$/, '')}${nodeHealthPath(rawNode)}`, {
          signal: controller.signal,
          headers: {
            'X-Gateway-Secret': gatewaySecret,
          },
        });
        clearTimeout(timeout);
        latency = Date.now() - t0;
        // Any answer below 500 proves the server is running (a 404 included)
        statusStr = res.status < 500 ? pc.green(`ONLINE (${res.status})`) : pc.red(`ERROR (${res.status})`);
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
