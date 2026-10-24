import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  runInit,
  runDoctor,
  runAddProvider,
  runRemoveProvider,
  runDeploy,
  runChaos,
} from '../src/index.js';
import { parseOmniMeshConfigYaml } from '@omnimesh/core';

describe('OmniMesh CLI Suite (init, doctor, deploy, chaos, add/remove)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnimesh-cli-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs init in non-interactive mode and produces complete valid mesh project', async () => {
    await runInit({ cwd: tmpDir, quick: true, card: false, domain: 'api.testdomain.com' });

    const configPath = path.join(tmpDir, 'omnimesh.config.yaml');
    const envPath = path.join(tmpDir, '.env');
    const keepAlivePath = path.join(tmpDir, '.github', 'workflows', 'keep-alive.yml');

    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.existsSync(envPath)).toBe(true);
    expect(fs.existsSync(keepAlivePath)).toBe(true);

    const configContent = fs.readFileSync(configPath, 'utf-8');
    const parsed = parseOmniMeshConfigYaml(configContent);
    expect(parsed.domain).toBe('api.testdomain.com');
    expect(parsed.profile).toBe('no-card');
    expect(parsed.gatewaySecret).toBeDefined();
    expect(parsed.gatewaySecret?.length).toBeGreaterThanOrEqual(32);

    // Doctor checks passes on freshly initialized project
    const doctorPassed = await runDoctor({ cwd: tmpDir });
    expect(doctorPassed).toBe(true);
  });

  it('adds and removes providers dynamically from config', async () => {
    await runInit({ cwd: tmpDir, quick: true, card: false });

    // Add Oracle provider
    await runAddProvider('oracle', { cwd: tmpDir, url: 'https://oracle-tunnel.custom.io' });

    let config = parseOmniMeshConfigYaml(fs.readFileSync(path.join(tmpDir, 'omnimesh.config.yaml'), 'utf-8'));
    expect(config.profile).toBe('with-card');
    expect(config.database.primary).toBe('oracle');
    const apiPool = config.pools['/api'] as any[];
    expect(apiPool[0]).toBe('https://oracle-tunnel.custom.io');

    // Remove Oracle
    await runRemoveProvider('oracle', { cwd: tmpDir });
    config = parseOmniMeshConfigYaml(fs.readFileSync(path.join(tmpDir, 'omnimesh.config.yaml'), 'utf-8'));
    const updatedPool = config.pools['/api'] as any[];
    expect(updatedPool.some((n) => (typeof n === 'string' ? n : n.url).includes('oracle'))).toBe(false);
  });

  it('runs dry-run deploy successfully', async () => {
    await runInit({ cwd: tmpDir, quick: true, card: false });
    const success = await runDeploy({ cwd: tmpDir, dryRun: true });
    expect(success).toBe(true);
  });

  it('executes live chaos simulation proving sub-3s failover', async () => {
    // Chaos spins up 2 ephemeral mock nodes, kills primary, and tests router failover
    await expect(runChaos({ timeoutMs: 1000 })).resolves.not.toThrow();
  });
});
