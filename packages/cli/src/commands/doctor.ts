import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { parseOmniMeshConfigYaml, isPlaceholderUrl } from '@omnimesh/core';
import { getProvider, getAllProviders } from '@omnimesh/providers';

export interface DoctorOptions {
  cwd?: string;
}

export async function runDoctor(options: DoctorOptions = {}) {
  const cwd = options.cwd || process.cwd();
  console.log(pc.bold(pc.cyan('\n🩺 OmniMesh Doctor — Health & Security Diagnostics\n')));

  let hasErrors = false;

  // 1. Config Check
  const configPath = path.join(cwd, 'omnimesh.config.yaml');
  if (!fs.existsSync(configPath)) {
    console.log(pc.red('✖ Missing omnimesh.config.yaml. Run `npx omnimesh init` first.'));
    return false;
  }

  let config: any;
  try {
    const rawYaml = fs.readFileSync(configPath, 'utf-8');
    config = parseOmniMeshConfigYaml(rawYaml);
    console.log(pc.green('✔ omnimesh.config.yaml is valid and well-formed'));
  } catch (err: any) {
    console.log(pc.red(`✖ Config schema validation failed: ${err.message}`));
    return false;
  }

  // 2. Secret Strength Check (Fail-Closed)
  const envPath = path.join(cwd, '.env');
  let envSecret = '';
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    const match = envContent.match(/GATEWAY_SECRET=["']?([^"'\r\n]+)/);
    if (match) envSecret = match[1];
  }

  if (config.gatewaySecret) {
    console.log(pc.red('✖ gatewaySecret is stored in omnimesh.config.yaml. Move it to .env (GATEWAY_SECRET) and rotate it if this file was ever committed.'));
    hasErrors = true;
  }

  const gatewaySecret = envSecret || process.env.GATEWAY_SECRET || config.gatewaySecret;
  if (!gatewaySecret || gatewaySecret.length < 32) {
    console.log(
      pc.red(
        `✖ GATEWAY_SECRET is insecure or missing (length: ${gatewaySecret ? gatewaySecret.length : 0}). Must be at least 32 chars.`
      )
    );
    hasErrors = true;
  } else {
    console.log(pc.green(`✔ GATEWAY_SECRET is cryptographically sound (${gatewaySecret.length} chars, fail-closed enabled)`));
  }

  // 3. Gitignore Protection
  const gitignorePath = path.join(cwd, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const gitignore = fs.readFileSync(gitignorePath, 'utf-8');
    if (gitignore.includes('.env')) {
      console.log(pc.green('✔ .env is properly protected in .gitignore'));
    } else {
      console.log(pc.yellow('⚠ Warning: .env is not listed in .gitignore. Secrets may be accidentally committed!'));
    }
  }

  // 4. Inspect Pools and Upstream Nodes
  console.log(pc.bold('\n🔍 Upstream Pool Verification:'));
  for (const [poolPath, nodes] of Object.entries(config.pools)) {
    console.log(pc.cyan(`  Pool ${pc.bold(poolPath)}: ${(nodes as any[]).length} configured nodes`));
    for (const rawNode of nodes as any[]) {
      const url = typeof rawNode === 'string' ? rawNode : rawNode.url;
      try {
        const parsed = new URL(url);
        if (isPlaceholderUrl(url)) {
          console.log(pc.red(`    ✖ ${url} is a placeholder. Replace it with your deployed app URL.`));
          hasErrors = true;
          continue;
        }
        console.log(pc.dim(`    • ${parsed.hostname} (${parsed.protocol})`));
        if (typeof rawNode !== 'string' && rawNode.providerId && !getProvider(rawNode.providerId)) {
          console.log(pc.red(`    ✖ Unknown providerId '${rawNode.providerId}' (typo?). Known: ${getAllProviders().map((p) => p.id).join(', ')}`));
          hasErrors = true;
        }
      } catch {
        console.log(pc.red(`    ✖ Invalid URL format: ${url}`));
        hasErrors = true;
      }
    }
  }

  // 5. Keep-Alive Configuration Check
  if (config.keepAlive?.enabled) {
    console.log(pc.green(`\n✔ Keep-Alive Engine is active (every ${config.keepAlive.intervalMinutes}m)`));
  } else {
    console.log(pc.yellow('\nℹ Keep-Alive Engine is inactive (containers on Render will sleep after 15m idle)'));
  }

  if (hasErrors) {
    console.log(pc.bold(pc.red('\n✖ Doctor identified issues that need your attention before deploying.')));
    return false;
  }

  console.log(pc.bold(pc.green('\n🎉 All doctor diagnostics passed! Mesh is ready for deployment.\n')));
  return true;
}
