import { OMNIMESH_VERSION } from '@omnimesh/core';
import { Command } from 'commander';
import { runInit } from './commands/init.js';
import { runDoctor } from './commands/doctor.js';
import { runChaos } from './commands/chaos.js';
import { runStatus } from './commands/status.js';
import { runDeploy } from './commands/deploy.js';
import { runAddProvider, runRemoveProvider } from './commands/add-provider.js';
import { runDbPromote } from './commands/db-promote.js';

export * from './commands/init.js';
export * from './commands/doctor.js';
export * from './commands/chaos.js';
export * from './commands/status.js';
export * from './commands/deploy.js';
export * from './commands/add-provider.js';
export * from './commands/db-promote.js';

export function createProgram() {
  const program = new Command();

  program
    .name('omnimesh')
    .description('OmniMesh — Open-source free-tier server federation with automatic sub-3s failover')
    .version(OMNIMESH_VERSION);

  program
    .command('init')
    .description('Interactive setup wizard to initialize OmniMesh in your repository')
    .option('--no-card', 'Initialize in strictly no-credit-card mode (Cloudflare, Koyeb, Render, Vercel, Netlify, Neon, Upstash)')
    .option('--with-card', 'Initialize including card-verified tiers (Oracle Always Free, Cloudflare R2)')
    .option('--domain <domain>', 'Set custom frontend domain (default: a placeholder you must replace)')
    .option('-q, --quick', 'Non-interactive fast setup using sensible defaults')
    .option('--force', 'Overwrite an existing omnimesh.config.yaml')
    .option('--keep-alive', 'Also generate a keep-alive workflow (check provider terms first)')
    .action(async (opts) => {
      let card: boolean | undefined = undefined;
      if (opts.noCard) card = false;
      if (opts.withCard) card = true;
      if ((await runInit({ card, domain: opts.domain, quick: opts.quick, force: opts.force, keepAlive: opts.keepAlive })) === false) process.exitCode = 1;
    });

  program
    .command('doctor')
    .description('Validate config, API tokens, gateway secret strength, and network reachability')
    .action(async () => {
      if ((await runDoctor()) === false) process.exitCode = 1;
    });

  program
    .command('chaos')
    .description('Kill a node live to demonstrate sub-3-second cross-cloud failover')
    .option('-t, --timeout <ms>', 'Per-node timeout in milliseconds (default: 2500)', '2500')
    .action(async (opts) => {
      if ((await runChaos({ timeoutMs: parseInt(opts.timeout, 10) })) === false) process.exitCode = 1;
    });

  program
    .command('status')
    .description('View live node health, latency, pool distribution, and quota usage meters')
    .action(async () => {
      await runStatus();
    });

  program
    .command('deploy')
    .description('Deploy backend code to all configured providers in parallel and router last')
    .option('--dry-run', 'Simulate deployment without triggering real API calls')
    .action(async (opts) => {
      if ((await runDeploy({ dryRun: opts.dryRun })) === false) process.exitCode = 1;
    });

  program
    .command('add-provider <name>')
    .description('Add a provider to the current active mesh (e.g. oracle, render, vercel, koyeb)')
    .option('--url <url>', 'Custom service URL')
    .action(async (name, opts) => {
      if ((await runAddProvider(name, { url: opts.url })) === false) process.exitCode = 1;
    });

  program
    .command('remove-provider <name>')
    .description('Remove a provider from all active pools')
    .action(async (name) => {
      if ((await runRemoveProvider(name)) === false) process.exitCode = 1;
    });

  program
    .command('db')
    .description('Database management operations')
    .command('promote')
    .description('Promote secondary Postgres replica (Neon) to primary writer (Mode B failover)')
    .option('-f, --force', 'Force promotion without interactive confirmation')
    .action(async (opts) => {
      if ((await runDbPromote({ force: opts.force })) === false) process.exitCode = 1;
    });

  return program;
}

// Auto-run if executed as script
if (process.argv[1]?.endsWith('omnimesh.js') || process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  createProgram().parse(process.argv);
}
