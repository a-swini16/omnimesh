import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { parseOmniMeshConfigYaml, isPlaceholderUrl } from '@omnimesh/core';
import { readEnvFile, placeholderNodes } from '../env.js';
import { getProvider } from '@omnimesh/providers';

export interface DeployOptions {
  cwd?: string;
  dryRun?: boolean;
}

// Adapters without API deploys say how to deploy instead; that is guidance, not a failure
function describeDeployError(name: string, err: any): string {
  return err?.name === 'DeployNotAutomatedError'
    ? pc.cyan(`   ℹ ${err.message}`)
    : pc.yellow(`   ⚠ Deploy failed on ${name}: ${err?.message ?? err}`);
}

export async function runDeploy(options: DeployOptions = {}) {
  const cwd = options.cwd || process.cwd();
  console.log(pc.bold(pc.cyan('\n🚀 OmniMesh Multi-Cloud Parallel Deployment Orchestrator\n')));

  const configPath = path.join(cwd, 'omnimesh.config.yaml');
  if (!fs.existsSync(configPath)) {
    console.log(pc.red('✖ No omnimesh.config.yaml found. Run `npx omnimesh init` first.'));
    return false;
  }

  const rawYaml = fs.readFileSync(configPath, 'utf-8');
  const config = parseOmniMeshConfigYaml(rawYaml);

  const envConfig = readEnvFile(cwd);

  // Never contact placeholder hosts: the health check sends the gateway secret
  const placeholders = placeholderNodes(config.pools, isPlaceholderUrl);
  if (placeholders.length > 0) {
    console.log(pc[options.dryRun ? 'yellow' : 'red'](`${options.dryRun ? '⚠' : '✖'} These pool URLs are still placeholders. Replace them with your deployed app URLs:`));
    for (const p of placeholders) console.log(pc.dim(`   • ${p}`));
    if (!options.dryRun) return false;
  }

  if (options.dryRun) {
    console.log(pc.yellow('🔍 Dry-run mode active. Validating deploy configuration without triggering live builds...'));
  }

  console.log(`Deploying mesh for domain: ${pc.bold(config.domain)} (Profile: ${config.profile})`);

  // 1. Identify distinct compute providers across all pools
  const providersToDeploy = new Set<string>();
  for (const nodes of Object.values(config.pools)) {
    for (const rawNode of nodes as any[]) {
      const url = typeof rawNode === 'string' ? rawNode : rawNode.url;
      if (url.includes('koyeb.app')) providersToDeploy.add('koyeb');
      if (url.includes('onrender.com')) providersToDeploy.add('render');
      if (url.includes('vercel.app')) providersToDeploy.add('vercel');
      if (url.includes('netlify.app')) providersToDeploy.add('netlify');
      if (url.includes('oracle-tunnel') || url.includes('oracle')) providersToDeploy.add('oracle');
    }
  }

  console.log(pc.cyan(`\n1. Deploying Compute Nodes in Parallel: [${Array.from(providersToDeploy).join(', ')}]`));

  const deploymentResults: any[] = [];
  await Promise.all(
    Array.from(providersToDeploy).map(async (providerId) => {
      const adapter = getProvider(providerId);
      if (!adapter) return;

      console.log(`   ⏳ Initiating deployment on ${pc.bold(adapter.displayName)}...`);
      if (options.dryRun) {
        console.log(`   ✔ [Dry-run] Simulated deploy success on ${adapter.displayName}`);
        return;
      }

      try {
        const result = await adapter.deploy(cwd, envConfig);
        deploymentResults.push(result);
        console.log(pc.green(`   ✔ Deployed ${pc.bold(adapter.displayName)} -> ${result.url}`));
      } catch (err: any) {
        console.log(describeDeployError(adapter.displayName, err));
      }
    })
  );

  // 2. Deploy Edge Router Last
  console.log(pc.cyan('\n2. Deploying OmniMesh Edge Router to Cloudflare Workers...'));
  const cfAdapter = getProvider('cloudflare');
  if (cfAdapter) {
    if (options.dryRun) {
      console.log(`   ✔ [Dry-run] Simulated Edge Router deploy`);
    } else {
      try {
        const routerResult = await cfAdapter.deploy(cwd, envConfig);
        console.log(pc.green(`   ✔ Edge Router is live at ${pc.bold(routerResult.url)}`));
      } catch (err: any) {
        console.log(describeDeployError('Edge Router', err));
      }
    }
  }

  // 3. Post-Deployment Automated Health Check Verification
  console.log(pc.cyan('\n3. Performing Post-Deployment Verification...'));
  if (options.dryRun) {
    console.log(pc.dim('   (skipped in dry-run)'));
  } else {
    // Real check: every pool needs at least one node answering /health with our gateway secret
    const secret = envConfig.GATEWAY_SECRET || '';
    let allPoolsServing = true;
    for (const [poolPath, nodes] of Object.entries(config.pools)) {
      let healthy = 0;
      for (const rawNode of nodes as any[]) {
        const url = (typeof rawNode === 'string' ? rawNode : rawNode.url).replace(/\/$/, '');
        const { protocol, hostname } = new URL(url);
        if (protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
          // Same rule as the router: the gateway secret never travels unencrypted
          console.log(pc.red(`   ✖ ${url} must use https:// (skipped, the gateway secret is never sent over plain http)`));
          continue;
        }
        try {
          const res = await fetch(`${url}/health`, {
            headers: { 'X-Gateway-Secret': secret },
            signal: AbortSignal.timeout(5000),
          });
          if (res.ok) healthy++;
        } catch {
          // counted as unhealthy
        }
      }
      const line = `   ${poolPath}: ${healthy}/${(nodes as any[]).length} nodes healthy`;
      console.log(healthy > 0 ? pc.green(`✔${line}`) : pc.red(`✖${line}`));
      if (healthy === 0) allPoolsServing = false;
    }
    if (!allPoolsServing) {
      console.log(pc.bold(pc.red('\n✖ Deployment verification failed: at least one pool has no healthy node.')));
      return false;
    }
  }

  console.log(pc.bold(pc.green(options.dryRun ? '\n✔ Dry run finished.' : '\n🎉 Every pool has at least one healthy node.')));
  console.log(`Unified Endpoint: ${pc.bold(pc.cyan(`https://${config.domain}`))}\n`);
  return true;
}
