import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { parseOmniMeshConfigYaml, isPlaceholderUrl, nodeHealthPath } from '@omnimesh/core';
import { readEnvFile, placeholderNodes } from '../env.js';
import { loadState, readDotEnv, runUp, servicesFromState } from '../up/orchestrate.js';
import { savedOracle } from '../up/server.js';
import { realDeps } from '../up/http.js';

export interface DeployOptions {
  cwd?: string;
  /** Show what would happen without calling any cloud */
  dryRun?: boolean;
}

/**
 * `omnimesh deploy`:
 * - in a folder deployed by `omnimesh up`, redeploys the latest code to every cloud (same code path as the wizard);
 * - in a manual setup (servers you host yourself), says so and only checks that every server answers.
 */
export async function runDeploy(options: DeployOptions = {}) {
  const cwd = options.cwd || process.cwd();
  const state = loadState(cwd);
  if (state) return redeploy(cwd, state, Boolean(options.dryRun));
  return checkManualSetup(cwd, Boolean(options.dryRun));
}

async function redeploy(cwd: string, state: NonNullable<ReturnType<typeof loadState>>, dryRun: boolean) {
  console.log(pc.bold(pc.cyan(`\n🚀 Redeploying ${state.repo.url} (${state.repo.branch})\n`)));
  const env = readDotEnv(cwd);
  const tokens = { koyeb: env.KOYEB_API_TOKEN, render: env.RENDER_API_KEY, cloudflare: env.CLOUDFLARE_API_TOKEN || '' };
  const oracle = state.nodes.some((n) => n.provider === 'oracle') ? savedOracle(cwd) ?? undefined : undefined;
  const missing = [...new Set(state.nodes.filter((n) => (n.provider === 'oracle' ? !oracle : !tokens[n.provider as 'koyeb' | 'render'])).map((n) => n.provider))];
  if (!tokens.cloudflare) missing.push('cloudflare');
  if (missing.length) {
    console.log(pc.red(`✖ The API tokens for ${missing.join(', ')} are not saved in .env, so OmniMesh cannot redeploy there.`));
    console.log('  Run omnimesh up and tick "Remember these tokens", or add them to .env.');
    return false;
  }
  if (dryRun) {
    for (const n of state.nodes) console.log(`  would redeploy ${pc.bold(n.provider)} (${n.url})`);
    console.log(`  would update the router at ${pc.bold(state.router.url)}`);
    console.log(pc.dim('\nDry run: no cloud was contacted.'));
    return true;
  }
  try {
    const result = await runUp(
      realDeps((m) => console.log(`  ${m}`)),
      {
        services: servicesFromState(cwd, state),
        tokens,
        oracle,
        keepAwake: state.keepAwake,
        lock: state.lock !== false,
        spread: state.spread !== false,
        renderCopies: state.renderCopies ?? 1,
        watcher: state.watcher,
      },
      { cwd }
    );
    for (const w of result.warnings) console.log(pc.yellow(`  ⚠ ${w}`));
    console.log(pc.bold(pc.green(`\n✔ Live on ${result.nodes.length} cloud(s): ${result.appUrl}\n`)));
    return result.failed.length === 0;
  } catch (e) {
    console.log(pc.red(`\n✖ ${(e as Error).message}`));
    return false;
  }
}

async function checkManualSetup(cwd: string, dryRun: boolean) {
  const configPath = path.join(cwd, 'omnimesh.config.yaml');
  if (!fs.existsSync(configPath)) {
    console.log(pc.red('✖ Nothing to deploy here yet. Run omnimesh up in your project folder to host your backend.'));
    return false;
  }
  const config = parseOmniMeshConfigYaml(fs.readFileSync(configPath, 'utf-8'));
  console.log(pc.bold(pc.cyan('\n🔍 Checking the servers in omnimesh.config.yaml\n')));
  console.log(pc.dim('These servers were not deployed by OmniMesh, so this only checks that each one answers.'));
  console.log(pc.dim('To have OmniMesh host your backend, run omnimesh up.\n'));

  // Never contact placeholder hosts: the check sends the gateway secret
  const placeholders = placeholderNodes(config.pools, isPlaceholderUrl);
  if (placeholders.length > 0) {
    console.log(pc[dryRun ? 'yellow' : 'red'](`${dryRun ? '⚠' : '✖'} These server addresses are still placeholders. Replace them with your real app URLs:`));
    for (const p of placeholders) console.log(pc.dim(`   • ${p}`));
    if (!dryRun) return false;
  }
  if (dryRun) {
    console.log(pc.dim('Dry run: no server was contacted.'));
    return true;
  }

  const secret = readEnvFile(cwd).GATEWAY_SECRET || '';
  let allRoutesServing = true;
  for (const [route, nodes] of Object.entries(config.pools)) {
    let online = 0;
    for (const rawNode of nodes) {
      const url = (typeof rawNode === 'string' ? rawNode : rawNode.url).replace(/\/$/, '');
      const { protocol, hostname } = new URL(url);
      if (protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
        // Same rule as the router: the gateway secret never travels unencrypted
        console.log(pc.red(`   ✖ ${url} must use https:// (skipped: the gateway secret is never sent over plain http)`));
        continue;
      }
      try {
        const res = await fetch(`${url}${nodeHealthPath(rawNode)}`, { headers: { 'X-Gateway-Secret': secret }, signal: AbortSignal.timeout(5000) });
        // Any answer below 500 proves the server is running (a 404 included)
        if (res.status < 500) online++;
        else console.log(pc.yellow(`   ⚠ ${url} answered ${res.status}`));
      } catch {
        console.log(pc.yellow(`   ⚠ ${url} did not answer`));
      }
    }
    const line = ` ${route}: ${online} of ${nodes.length} servers online`;
    console.log(online > 0 ? pc.green(`✔${line}`) : pc.red(`✖${line}`));
    if (online === 0) allRoutesServing = false;
  }
  if (!allRoutesServing) {
    console.log(pc.bold(pc.red('\n✖ At least one route has no server answering. Check that app’s logs on its cloud.')));
    return false;
  }
  console.log(pc.bold(pc.green('\n✔ Every route has a server answering.\n')));
  return true;
}
