import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import {
  parseOmniMeshConfigYaml,
  stringifyOmniMeshConfigYaml,
} from '@omnimesh/core';
import { getProvider } from '@omnimesh/providers';

export interface AddProviderOptions {
  cwd?: string;
  url?: string;
}

export async function runAddProvider(providerName: string, options: AddProviderOptions = {}) {
  const cwd = options.cwd || process.cwd();
  console.log(pc.bold(pc.cyan(`\n➕ Adding Provider '${providerName}' to OmniMesh...\n`)));

  const provider = getProvider(providerName.toLowerCase());
  if (!provider) {
    console.log(pc.red(`✖ Unknown provider '${providerName}'. Available: koyeb, render, vercel, netlify, oracle, neon, supabase, upstash`));
    return false;
  }

  const configPath = path.join(cwd, 'omnimesh.config.yaml');
  if (!fs.existsSync(configPath)) {
    console.log(pc.red('✖ No omnimesh.config.yaml found. Run `npx omnimesh init` first.'));
    return false;
  }

  const rawYaml = fs.readFileSync(configPath, 'utf-8');
  const config = parseOmniMeshConfigYaml(rawYaml);

  // Placeholder until the developer passes --url; `.invalid` never resolves, so no stranger can own it
  const defaultUrl = options.url || `https://${provider.id}-service.replace-me.invalid`;

  // Add provider to /api pool
  const currentPool = (config.pools['/api'] || []) as any[];
  const exists = currentPool.some((n) => (typeof n === 'string' ? n : n.url).includes(provider.id));

  if (exists) {
    console.log(pc.yellow(`⚠ Provider '${provider.displayName}' is already active in /api pool.`));
    return true;
  }

  if (provider.id === 'oracle') {
    // Oracle becomes primary in with-card mode
    config.pools['/api'] = [defaultUrl, ...currentPool];
    config.profile = 'with-card';
    config.database.mode = 'self-hosted';
    config.database.primary = 'oracle';
    config.database.replica = 'neon';
    console.log(pc.green('✔ Upgraded profile to with-card and positioned Oracle as primary node.'));
  } else {
    // Append to candidates
    config.pools['/api'].push(defaultUrl);
  }

  fs.writeFileSync(configPath, stringifyOmniMeshConfigYaml(config), 'utf-8');
  console.log(pc.green(`✔ Added ${pc.bold(provider.displayName)} (${defaultUrl}) to omnimesh.config.yaml`));
  console.log(pc.dim(`Limits: ${provider.limits.sourceUrl}`));
  return true;
}

export async function runRemoveProvider(providerName: string, options: { cwd?: string } = {}) {
  const cwd = options.cwd || process.cwd();
  console.log(pc.bold(pc.cyan(`\n➖ Removing Provider '${providerName}' from OmniMesh...\n`)));

  const configPath = path.join(cwd, 'omnimesh.config.yaml');
  if (!fs.existsSync(configPath)) {
    console.log(pc.red('✖ No omnimesh.config.yaml found.'));
    return false;
  }

  const rawYaml = fs.readFileSync(configPath, 'utf-8');
  const config = parseOmniMeshConfigYaml(rawYaml);

  for (const [poolPath, nodes] of Object.entries(config.pools)) {
    config.pools[poolPath] = (nodes as any[]).filter((n) => {
      const url = typeof n === 'string' ? n : n.url;
      return !url.toLowerCase().includes(providerName.toLowerCase());
    });
  }

  fs.writeFileSync(configPath, stringifyOmniMeshConfigYaml(config), 'utf-8');
  console.log(pc.green(`✔ Removed ${providerName} from all active pools in omnimesh.config.yaml`));
  return true;
}
