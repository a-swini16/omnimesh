import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runInit, runStatus, runDeploy, runDoctor, runAddProvider } from '../src/index.js';
import { createRouterApp } from '@omnimesh/router';
import { parseOmniMeshConfigYaml } from '@omnimesh/core';

// Hosts a fresh install may legitimately talk to: none. Everything generated must be a placeholder.
function sentSecretTo(fetchSpy: { mock: { calls: unknown[][] } }): string[] {
  return fetchSpy.mock.calls
    .filter(([, init]) => {
      const h = new Headers((init as RequestInit | undefined)?.headers);
      return Boolean(h.get('x-gateway-secret'));
    })
    .map(([url]) => String(url));
}

describe('[C-2] the gateway secret never goes to placeholder hosts', () => {
  let dir: string;
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const freshInit = async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnimesh-c2-'));
    await runInit({ cwd: dir, quick: true, card: false });
    return parseOmniMeshConfigYaml(fs.readFileSync(path.join(dir, 'omnimesh.config.yaml'), 'utf-8'));
  };

  it('status and deploy right after init contact no host with the secret', async () => {
    await freshInit();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await runStatus({ cwd: dir });
    const deployed = await runDeploy({ cwd: dir });
    expect(sentSecretTo(fetchSpy)).toEqual([]);
    expect(deployed).toBe(false); // refuses until real URLs are filled in
  });

  it('init writes only unresolvable placeholders (pools, keep-alive targets, domain)', async () => {
    const config = await freshInit();
    const urls = [
      ...Object.values(config.pools).flat().map((n) => (typeof n === 'string' ? n : n.url)),
      ...config.keepAlive.targets,
      `https://${config.domain}`,
    ];
    for (const url of urls) expect(new URL(url).hostname, url).toMatch(/\.invalid$/);

    await runAddProvider('render', { cwd: dir });
    const pool = parseOmniMeshConfigYaml(fs.readFileSync(path.join(dir, 'omnimesh.config.yaml'), 'utf-8')).pools['/api'];
    const added = pool.map((n) => (typeof n === 'string' ? n : n.url)).at(-1)!;
    expect(new URL(added).hostname).toMatch(/\.invalid$/);
  });

  it('the keep-alive workflow never sends the gateway secret', async () => {
    await freshInit();
    await runInit({ cwd: dir, quick: true, card: false, force: true, keepAlive: true });
    const wf = fs.readFileSync(path.join(dir, '.github/workflows/keep-alive.yml'), 'utf-8');
    expect(wf).not.toMatch(/GATEWAY_SECRET/);
  });

  it('doctor flags placeholders, and the router refuses to start with them', async () => {
    const config = await freshInit();
    expect(await runDoctor({ cwd: dir })).toBe(false);
    expect(() => createRouterApp({ config, gatewaySecret: 's'.repeat(40) })).toThrow(/placeholder/i);
  });
});
