import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { parseOmniMeshConfigYaml } from '@omnimesh/core';
import { runUp, readDotEnv } from '../src/up/orchestrate.js';
import { startWizard } from '../src/up/server.js';
import { bundleRouter } from '../src/up/bundle.js';
import { mockCloud } from './mock-cloud.js';

const APIS = { koyeb: 'https://koyeb.test', render: 'https://render.test', cloudflare: 'https://cloudflare.test' };
const TOKENS = { koyeb: 'k'.repeat(40), render: 'r'.repeat(40), cloudflare: 'c'.repeat(40) };
const fakeBundle = async () => 'export default { fetch() { return new Response("ok") } }';

describe('omnimesh up: give us your backend, we host it', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnimesh-up-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('deploys one GitHub repo to Koyeb and Render, puts the router in front, and saves everything', async () => {
    const { deps, calls } = mockCloud();
    const result = await runUp(deps, { repoUrl: 'https://github.com/me/shop-api', tokens: TOKENS }, { cwd: dir, apis: APIS, bundle: fakeBundle });

    expect(result.appUrl).toBe('https://om-shop-api.me.workers.dev');
    expect(result.nodes.map((n) => n.url).sort()).toEqual(['https://om-shop-api-me.koyeb.app', 'https://om-shop-api.onrender.com']);

    const koyeb = calls.find((c) => c.url === 'https://koyeb.test/v1/services')!.body.definition;
    expect(koyeb.instance_types).toEqual([{ type: 'free' }]);
    expect(koyeb.git).toMatchObject({ repository: 'github.com/me/shop-api', branch: 'main', buildpack: { build_command: 'npm install && npm run build', run_command: 'npm start' } });
    const render = calls.find((c) => c.url === 'https://render.test/v1/services')!.body;
    expect(render).toMatchObject({ type: 'web_service', repo: 'https://github.com/me/shop-api', serviceDetails: { plan: 'free', runtime: 'node' } });

    const env = readDotEnv(dir);
    expect(env.GATEWAY_SECRET).toHaveLength(64);
    // every node got the same gateway secret, and the router got it too
    expect(koyeb.env).toContainEqual({ key: 'GATEWAY_SECRET', value: env.GATEWAY_SECRET });
    expect(render.envVars).toContainEqual({ key: 'GATEWAY_SECRET', value: env.GATEWAY_SECRET });
    const upload = calls.find((c) => c.method === 'PUT')!.body;
    const secrets = Object.fromEntries(upload.metadata.bindings.filter((b: any) => b.type === 'secret_text').map((b: any) => [b.name, b.text]));
    expect(secrets.GATEWAY_SECRET).toBe(env.GATEWAY_SECRET);
    expect(secrets.OMNIMESH_STATUS_TOKEN).toBe(result.statusToken);
    expect(secrets.OMNIMESH_CONFIG_YAML).toContain('om-shop-api.onrender.com');
    expect(upload.metadata.bindings).toContainEqual({ type: 'kv_namespace', name: 'OMNIMESH_KV', namespace_id: 'kv1' });
    // Automatic health checks are scheduled on the Worker
    const schedule = calls.find((c) => c.url.endsWith('/workers/scripts/om-shop-api/schedules'))!;
    expect(schedule).toMatchObject({ method: 'PUT', body: [{ cron: '*/5 * * * *' }] });
    expect(result.warnings.join(' ')).not.toMatch(/Automatic health checks are off/);

    const config = parseOmniMeshConfigYaml(fs.readFileSync(path.join(dir, 'omnimesh.config.yaml'), 'utf-8'));
    expect(config.domain).toBe('om-shop-api.me.workers.dev');
    expect((config.pools['/'] as any[]).map((n) => n.providerId).sort()).toEqual(['koyeb', 'render']);
    expect(fs.statSync(path.join(dir, '.env')).mode & 0o077).toBe(0);
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8')).toMatch(/^\.env$[\s\S]*^\.omnimesh\/$/m);
  });

  it('running it again redeploys the same services with the same secrets (no duplicates)', async () => {
    const first = mockCloud();
    const r1 = await runUp(first.deps, { repoUrl: 'me/shop-api', tokens: TOKENS }, { cwd: dir, apis: APIS, bundle: fakeBundle });
    const second = mockCloud();
    const r2 = await runUp(second.deps, { repoUrl: 'me/shop-api', tokens: TOKENS }, { cwd: dir, apis: APIS, bundle: fakeBundle });

    expect(second.calls.some((c) => c.url.endsWith('/v1/services/ksvc1/redeploy'))).toBe(true);
    expect(second.calls.some((c) => c.method === 'POST' && c.url.endsWith('/v1/services/rsvc1/deploys'))).toBe(true);
    expect(second.calls.some((c) => c.method === 'POST' && (c.url === 'https://koyeb.test/v1/apps' || c.url === 'https://render.test/v1/services'))).toBe(false);
    expect(r2.statusToken).toBe(r1.statusToken);
  });

  it('keeps going when one cloud fails, and says so', async () => {
    const { deps } = mockCloud({ renderBroken: true });
    const result = await runUp(deps, { repoUrl: 'me/shop-api', tokens: TOKENS }, { cwd: dir, apis: APIS, bundle: fakeBundle });
    expect(result.nodes.map((n) => n.provider)).toEqual(['koyeb']);
    expect(result.failed[0].error).toMatch(/Render: unauthorized.*token/);
    expect(result.warnings.join(' ')).toMatch(/Only one cloud/);
  });

  it('says so when Cloudflare will not schedule the health checks, and still deploys', async () => {
    const { deps } = mockCloud({ cronLimit: true });
    const result = await runUp(deps, { repoUrl: 'me/shop-api', tokens: TOKENS }, { cwd: dir, apis: APIS, bundle: fakeBundle });
    expect(result.appUrl).toBe('https://om-shop-api.me.workers.dev');
    expect(result.warnings.join(' ')).toMatch(/Automatic health checks are off.*limit of 5 cron triggers/);
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.omnimesh', 'deployment.json'), 'utf-8')).router.scheduleError).toBeUndefined();
  });

  it('explains what is missing in plain words', async () => {
    const { deps } = mockCloud();
    await expect(runUp(deps, { repoUrl: 'me/shop-api', tokens: { koyeb: TOKENS.koyeb, cloudflare: '' } }, { cwd: dir, apis: APIS, bundle: fakeBundle })).rejects.toThrow(/Connect Cloudflare/);
    await expect(runUp(deps, { repoUrl: 'me/shop-api', tokens: { cloudflare: TOKENS.cloudflare } }, { cwd: dir, apis: APIS, bundle: fakeBundle })).rejects.toThrow(/at least one cloud/);
    await expect(runUp(mockCloud({ privateRepo: true }).deps, { repoUrl: 'me/shop-api', tokens: TOKENS }, { cwd: dir, apis: APIS, bundle: fakeBundle })).rejects.toThrow(/private/);
    await expect(runUp(mockCloud({ noSubdomain: true }).deps, { repoUrl: 'me/shop-api', tokens: TOKENS }, { cwd: dir, apis: APIS, bundle: fakeBundle })).rejects.toThrow(/workers\.dev subdomain/);
  });

  it('the bundled router is a working Worker (status API and dashboard answer)', async () => {
    const code = await bundleRouter();
    const file = path.join(dir, 'worker.mjs');
    fs.writeFileSync(file, code);
    const worker = (await import(file)).default;
    const env = { GATEWAY_SECRET: 'g'.repeat(40), OMNIMESH_STATUS_TOKEN: 't'.repeat(40), OMNIMESH_CONFIG_YAML: 'defaultPool: /\npools:\n  /:\n    - https://example.com\n' };
    const status = await worker.fetch(new Request('https://x.workers.dev/_omnimesh/status', { headers: { Authorization: `Bearer ${'t'.repeat(40)}` } }), env, {});
    expect(status.status).toBe(200);
    expect((await worker.fetch(new Request('https://x.workers.dev/_omnimesh/dashboard'), env, {})).status).toBe(200);

    // The scheduled run checks the real server and shares one snapshot through KV
    const server = http.createServer((req, res) => {
      res.statusCode = req.headers['x-gateway-secret'] === 'g'.repeat(40) ? 200 : 403;
      res.end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const origin = `http://127.0.0.1:${(server.address() as any).port}`;
    const kv = new Map<string, string>();
    const OMNIMESH_KV = { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v), delete: async (k: string) => void kv.delete(k) };
    try {
      await worker.scheduled({}, { ...env, OMNIMESH_KV, OMNIMESH_CONFIG_YAML: `defaultPool: /\npools:\n  /:\n    - ${origin}\n` }, {});
    } finally {
      server.close();
    }
    const snapshot = JSON.parse(kv.get('omnimesh:checks')!);
    expect(snapshot.trigger).toBe('schedule');
    expect(snapshot.nodes[origin]).toMatchObject({ state: 'online', status: 200, lock: 'locked' });
  }, 30000);
});

describe('omnimesh up wizard server is locked to this computer', () => {
  let dir: string;
  let wizard: Awaited<ReturnType<typeof startWizard>>;
  let key: string;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnimesh-wiz-'));
    wizard = await startWizard({ cwd: dir, port: 0, apis: APIS, bundle: fakeBundle, deps: (log) => ({ ...mockCloud().deps, log }) });
    key = new URL(wizard.url).hash.replace('#key=', '');
  });
  afterEach(async () => {
    await wizard.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = () => `http://127.0.0.1:${wizard.port}`;

  it('serves the page, but every API call needs the one-time key, our Host, and no foreign Origin', async () => {
    expect((await fetch(`${base()}/`)).status).toBe(200);
    expect((await fetch(`${base()}/api/state`)).status).toBe(401);
    expect((await fetch(`${base()}/api/state`, { headers: { 'X-OmniMesh-Key': key, Origin: 'https://evil.example' } })).status).toBe(403);
    // fetch() won't send a custom Host header, so use a raw request (what a DNS-rebinding page would send)
    const rebindStatus = await new Promise<number>((resolve) => {
      http.get({ host: '127.0.0.1', port: wizard.port, path: '/api/state', headers: { Host: 'evil.example', 'X-OmniMesh-Key': key } }, (res) => {
        res.resume();
        resolve(res.statusCode || 0);
      });
    });
    expect(rebindStatus).toBe(421);
    expect((await fetch(`${base()}/api/state`, { headers: { 'X-OmniMesh-Key': key } })).status).toBe(200);
    const csp = (await fetch(`${base()}/`)).headers.get('content-security-policy') || '';
    expect(csp).toContain("script-src 'self'");
  });

  it('deploys from the page and remembers tokens only when asked', async () => {
    const h = { 'X-OmniMesh-Key': key, 'Content-Type': 'application/json' };
    const start = await fetch(`${base()}/api/deploy`, { method: 'POST', headers: h, body: JSON.stringify({ repoUrl: 'https://github.com/me/shop-api', tokens: TOKENS, remember: true }) });
    expect(start.status).toBe(202);
    let job: any;
    for (let i = 0; i < 50; i++) {
      job = await (await fetch(`${base()}/api/progress`, { headers: h })).json();
      if (!job.running) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(job.error).toBeNull();
    expect(job.result.appUrl).toBe('https://om-shop-api.me.workers.dev');
    expect(job.log.map((l: any) => l.text).join('\n')).toMatch(/Detected a Node\.js app/);
    const env = readDotEnv(dir);
    expect(env.KOYEB_API_TOKEN).toBe(TOKENS.koyeb);
    const state = await (await fetch(`${base()}/api/state`, { headers: h })).json();
    expect(state.savedTokens).toEqual({ koyeb: true, render: true, cloudflare: true });
    expect(state.deployed.dashboardUrl).toBe('https://om-shop-api.me.workers.dev/_omnimesh/dashboard');
  });
});
