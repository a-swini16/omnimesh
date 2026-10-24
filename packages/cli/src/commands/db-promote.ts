import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import pc from 'picocolors';
import {
  parseOmniMeshConfigYaml,
  stringifyOmniMeshConfigYaml,
} from '@omnimesh/core';

export interface DbPromoteOptions {
  cwd?: string;
  force?: boolean;
}

export async function runDbPromote(options: DbPromoteOptions = {}) {
  const cwd = options.cwd || process.cwd();
  console.log(pc.bold(pc.red('\n⚠️  OmniMesh Database Failover & Replica Promotion Tool')));
  console.log(pc.dim('Mode B: Promoting secondary Postgres replica (Neon) to primary writer...\n'));

  const configPath = path.join(cwd, 'omnimesh.config.yaml');
  if (!fs.existsSync(configPath)) {
    console.log(pc.red('✖ No omnimesh.config.yaml found.'));
    return false;
  }

  const rawYaml = fs.readFileSync(configPath, 'utf-8');
  const config = parseOmniMeshConfigYaml(rawYaml);

  if (config.database.mode !== 'self-hosted' && config.database.primary !== 'oracle') {
    console.log(pc.yellow(`ℹ Current database mode is '${config.database.mode}' with primary '${config.database.primary}'. Promotion is only applicable for Mode B.`));
    return false;
  }

  console.log(pc.bold('Safety & Data Replication Check:'));
  console.log('  • Primary (Failed):       Oracle VM Postgres 16');
  console.log('  • Hot Standby Replica:    Neon Serverless Postgres');
  console.log('  • Replication Mechanism:  Postgres Logical Replication (WAL streaming)');
  console.log(
    pc.yellow(
      '\n  Caution: Promotion will switch all compute nodes to accept writes on Neon.\n' +
      '  Any in-flight WAL transactions that did not reach Neon prior to the Oracle VM crash\n' +
      '  will be permanently diverged if the Oracle VM comes back online.'
    )
  );

  if (!options.force) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(pc.bold('\nAre you sure you want to promote Neon to Primary Writer? (yes/NO): '));
    rl.close();

    if (answer.trim().toLowerCase() !== 'yes') {
      console.log(pc.cyan('Promotion aborted by operator. Replica remains in read-only mode.'));
      return false;
    }
  }

  // Switch config
  config.database.mode = 'managed';
  config.database.primary = 'neon';
  config.database.replica = undefined;

  fs.writeFileSync(configPath, stringifyOmniMeshConfigYaml(config), 'utf-8');

  console.log(pc.bold(pc.green('\n✔ Replica successfully promoted to Primary!')));
  console.log('Updated omnimesh.config.yaml: database.mode = managed (neon)');
  console.log(pc.cyan('Run `omnimesh deploy` to propagate the updated database configuration to all edge and compute nodes.\n'));
  return true;
}
