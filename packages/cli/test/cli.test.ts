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
} from '../src/index.js';
import { parseOmniMeshConfigYaml } from '@omnimesh/core';
import { spawnSync } from 'node:child_process';

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
    expect(fs.existsSync(keepAlivePath)).toBe(false); // keep-alive is opt-in (architecture §8)

    const configContent = fs.readFileSync(configPath, 'utf-8');
    const parsed = parseOmniMeshConfigYaml(configContent);
    expect(parsed.domain).toBe('api.testdomain.com');
    expect(parsed.profile).toBe('no-card');
    // Secrets must never land in the committed config or .env.example
    expect(parsed.gatewaySecret).toBeUndefined();
    const env = fs.readFileSync(envPath, 'utf-8');
    const secret = env.match(/GATEWAY_SECRET="([^"]+)"/)![1];
    const jwt = env.match(/JWT_SECRET="([^"]+)"/)![1];
    expect(secret.length).toBeGreaterThanOrEqual(32);
    const example = fs.readFileSync(path.join(tmpDir, '.env.example'), 'utf-8');
    expect(example).not.toContain(secret);
    expect(example).not.toContain(jwt);
    const status = env.match(/OMNIMESH_STATUS_TOKEN="([^"]+)"/)![1];
    expect(status.length).toBeGreaterThanOrEqual(32);
    expect(example).not.toContain(status);
    expect(fs.statSync(envPath).mode & 0o077).toBe(0);

    // No-card mesh: no card-only providers, and quota-limited nodes carry their free-tier limits
    const nodes = Object.values(parsed.pools).flat() as any[];
    expect(nodes.some((n) => (typeof n === 'string' ? n : n.url).includes('oracle'))).toBe(false);
    const netlify = nodes.find((n) => n.providerId === 'netlify');
    expect(netlify.requestsPerMonth).toBe(125000);

    // Fresh projects still hold placeholder URLs, so doctor must ask for real ones
    expect(await runDoctor({ cwd: tmpDir })).toBe(false);
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


  it('[H-3] the omnimesh binary runs straight from a clean checkout', () => {
    const bin = path.resolve(__dirname, '../bin/omnimesh.js');
    const out = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf-8', timeout: 30000 });
    expect(out.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND/);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('init');
  });

  it('[M-6] doctor rejects unknown provider ids', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'omnimesh.config.yaml'),
      'pools:\n  /api:\n    - url: https://api.example.com\n      providerId: herokuu\n'
    );
    fs.writeFileSync(path.join(tmpDir, '.env'), `GATEWAY_SECRET="${'s'.repeat(64)}"\n`);
    expect(await runDoctor({ cwd: tmpDir })).toBe(false);
  });

  it('[M-7] init never overwrites an existing config unless forced', async () => {
    expect(await runInit({ cwd: tmpDir, quick: true, card: false })).toBe(true);
    const configPath = path.join(tmpDir, 'omnimesh.config.yaml');
    fs.appendFileSync(configPath, '# my edits\n');

    expect(await runInit({ cwd: tmpDir, quick: true, card: false })).toBe(false);
    expect(fs.readFileSync(configPath, 'utf-8')).toContain('# my edits');

    expect(await runInit({ cwd: tmpDir, quick: true, card: false, force: true })).toBe(true);
    expect(fs.readFileSync(configPath, 'utf-8')).not.toContain('# my edits');
  });

  it('[M-7] keep-alive is off by default and opt-in with a terms-of-service warning', async () => {
    await runInit({ cwd: tmpDir, quick: true, card: false });
    const config = parseOmniMeshConfigYaml(fs.readFileSync(path.join(tmpDir, 'omnimesh.config.yaml'), 'utf-8'));
    expect(config.keepAlive.enabled).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.github/workflows/keep-alive.yml'))).toBe(false);

    await runInit({ cwd: tmpDir, quick: true, card: false, force: true, keepAlive: true });
    const wf = fs.readFileSync(path.join(tmpDir, '.github/workflows/keep-alive.yml'), 'utf-8');
    expect(wf).toMatch(/terms of service/i);
  });
});
