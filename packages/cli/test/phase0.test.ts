import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validateOmniMeshConfig, nodeHealthPath } from '@omnimesh/core';
import { DASHBOARD_HTML, DASHBOARD_JS } from '../../router/src/dashboard-assets.generated.js';
import { runOpen, runToken } from '../src/commands/open.js';
import { runDeploy } from '../src/commands/deploy.js';
import { writeDotEnv, readDotEnv } from '../src/up/orchestrate.js';
import sodium from 'libsodium-wrappers';
import { mockCloud } from './mock-cloud.js';
import type { Deps } from '../src/up/http.js';

function writeState(dir: string) {
  fs.mkdirSync(path.join(dir, '.omnimesh'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.omnimesh', 'deployment.json'),
    JSON.stringify({
      appName: 'om-shop-api',
      repo: { slug: 'github.com/me/shop-api', url: 'https://github.com/me/shop-api', branch: 'main', runtime: 'node' },
      nodes: [{ provider: 'koyeb', url: 'https://om-shop-api-me.koyeb.app', serviceId: 'k1' }],
      router: { url: 'https://om-shop-api.me.workers.dev', accountId: 'acc1', kvNamespaceId: 'kv1' },
      updatedAt: new Date().toISOString(),
    })
  );
}

describe('Phase 0: production only, plain words, easy sign-in', () => {
  let dir: string;
  let logs: string[];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnimesh-p0-'));
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => void logs.push(a.join(' ')));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the shipped dashboard has no demo mode, no dev-token and no fake controls', () => {
    for (const text of [DASHBOARD_HTML, DASHBOARD_JS]) {
      expect(text).not.toMatch(/dev-token|devControlPanel|_omnimesh\/dev|Kill Koyeb|Revive All/i);
    }
    expect(DASHBOARD_HTML).toContain('Sign in to your OmniMesh dashboard');
    expect(DASHBOARD_HTML).toContain('omnimesh open');
    // #token= sign-in is read from the fragment and removed from the address bar
    expect(DASHBOARD_JS).toMatch(/get\('token'\)[\s\S]{0,200}history\.replaceState/);
  });

  it('omnimesh open needs a deployment, then opens the dashboard with the key in the fragment only', async () => {
    expect(await runOpen({ cwd: dir, open: false })).toBe(false);
    expect(logs.join('\n')).toMatch(/Run omnimesh up/);
    writeState(dir);
    writeDotEnv(dir, { OMNIMESH_STATUS_TOKEN: 't'.repeat(48) });
    logs = [];
    expect(await runOpen({ cwd: dir, open: false })).toBe(true);
    expect(logs.join('\n')).toContain('https://om-shop-api.me.workers.dev/_omnimesh/dashboard');
    expect(logs.join('\n')).not.toContain('t'.repeat(48)); // never printed when not asked for
  });

  it('omnimesh token prints the key; --rotate updates it on the live router first', async () => {
    writeState(dir);
    writeDotEnv(dir, { OMNIMESH_STATUS_TOKEN: 'old'.repeat(16), CLOUDFLARE_API_TOKEN: 'c'.repeat(40) });
    expect(await runToken({ cwd: dir })).toBe(true);
    expect(logs).toContain('old'.repeat(16));

    const calls: Array<{ url: string; init: RequestInit }> = [];
    const deps: Deps = {
      fetch: async (url, init = {}) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ success: true, result: {} }), { status: 200 });
      },
      sleep: async () => {},
      log: () => {},
    };
    expect(await runToken({ cwd: dir, rotate: true, deps, apiBase: 'https://cloudflare.test' })).toBe(true);
    expect(calls[0].url).toBe('https://cloudflare.test/accounts/acc1/workers/scripts/om-shop-api/secrets');
    expect(calls[0].init.method).toBe('PUT');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({ name: 'OMNIMESH_STATUS_TOKEN', type: 'secret_text' });
    expect(readDotEnv(dir).OMNIMESH_STATUS_TOKEN).toBe(body.text);
    expect(body.text).not.toBe('old'.repeat(16));
  });

  it('a failed rotation keeps the old key (the router and .env never disagree)', async () => {
    writeState(dir);
    writeDotEnv(dir, { OMNIMESH_STATUS_TOKEN: 'old'.repeat(16), CLOUDFLARE_API_TOKEN: 'c'.repeat(40) });
    const deps: Deps = { fetch: async () => new Response('{"errors":[{"message":"bad token"}]}', { status: 403 }), sleep: async () => {}, log: () => {} };
    await expect(runToken({ cwd: dir, rotate: true, deps, apiBase: 'https://cloudflare.test' })).rejects.toThrow(/bad token/);
    expect(readDotEnv(dir).OMNIMESH_STATUS_TOKEN).toBe('old'.repeat(16));
  });

  it('omnimesh deploy never reports a fake success', async () => {
    expect(await runDeploy({ cwd: dir })).toBe(false);
    expect(logs.join('\n')).toMatch(/Nothing to deploy here yet/);

    writeState(dir);
    logs = [];
    expect(await runDeploy({ cwd: dir })).toBe(false); // tokens not saved: refuses instead of pretending
    expect(logs.join('\n')).toMatch(/not saved in \.env/);

    writeDotEnv(dir, { KOYEB_API_TOKEN: 'k'.repeat(40), CLOUDFLARE_API_TOKEN: 'c'.repeat(40) });
    logs = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await runDeploy({ cwd: dir, dryRun: true })).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logs.join('\n')).toMatch(/would redeploy koyeb[\s\S]*no cloud was contacted/i);
    expect(logs.join('\n')).not.toMatch(/simulated|success/i);
  });

  it('each server can have its own health path; the default is /health', () => {
    const c = validateOmniMeshConfig({ pools: { '/': [{ url: 'https://a.example.com', healthPath: '/healthz' }, 'https://b.example.com'] } });
    expect(nodeHealthPath(c.pools['/'][0])).toBe('/healthz');
    expect(nodeHealthPath(c.pools['/'][1])).toBe('/health');
    expect(() => validateOmniMeshConfig({ pools: { '/': [{ url: 'https://a.example.com', healthPath: 'healthz' }] } })).toThrow(/healthPath/);
  });

  it('rotating the sign-in key also updates the GitHub watcher\'s copy', async () => {
    writeState(dir);
    const statePath = path.join(dir, '.omnimesh', 'deployment.json');
    fs.writeFileSync(statePath, JSON.stringify({ ...JSON.parse(fs.readFileSync(statePath, 'utf-8')), watcher: true }));
    writeDotEnv(dir, { CLOUDFLARE_API_TOKEN: 'c'.repeat(40), OMNIMESH_STATUS_TOKEN: 'old', OMNIMESH_GITHUB_TOKEN: 'ghp_test' });
    await sodium.ready;
    const kp = sodium.crypto_box_keypair();
    const cloud = mockCloud({ githubPublicKey: sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL) });
    const deps = { ...cloud.deps, fetch: async (u: string, i?: RequestInit) => (u.includes('/workers/scripts/om-shop-api/secrets') ? new Response('{"success":true,"result":{}}') : cloud.deps.fetch(u, i)) } as Deps;
    expect(await runToken({ cwd: dir, rotate: true, deps, apiBase: 'https://cloudflare.test', githubApi: 'https://github.test' })).toBe(true);
    const put = cloud.calls.find((c) => c.url === 'https://github.test/repos/me/shop-api/actions/secrets/OMNIMESH_STATUS_TOKEN')!;
    const plain = sodium.to_string(sodium.crypto_box_seal_open(sodium.from_base64(put.body.encrypted_value, sodium.base64_variants.ORIGINAL), kp.publicKey, kp.privateKey));
    expect(plain).toBe(readDotEnv(dir).OMNIMESH_STATUS_TOKEN);
    expect(cloud.calls.some((c) => c.url.includes('/contents/'))).toBe(false); // only the secret changes
    expect(logs.join('\n')).toMatch(/GitHub watcher has the new key/);
  });
});
