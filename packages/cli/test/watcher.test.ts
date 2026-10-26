import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parse } from 'yaml';
import sodium from 'libsodium-wrappers';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { gatewayAuth } from '@omnimesh/node';
import { validateOmniMeshConfig } from '@omnimesh/core';
import { createRouterApp } from '@omnimesh/router';
import { installWatcher, watcherWorkflow, watcherSecretNames, watcherScript, WORKFLOW_PATH, SCRIPT_PATH } from '../src/up/watcher.js';
// The exact file that is committed to the user's repo
import { run } from '../src/up/watcher/watch.mjs';
import { mockCloud } from './mock-cloud.js';

const nodes = [
  { provider: 'oracle', url: 'https://oracle.example.com', serviceId: 'ocid1.instance.oc1..abc', region: 'us-ashburn-1' },
  { provider: 'koyeb', url: 'https://om-shop-api-me.koyeb.app', serviceId: 'ksvc1' },
  { provider: 'render', url: 'https://om-shop-api.onrender.com', serviceId: 'rsvc1' },
];
const labels = Object.fromEntries(nodes.map((n) => [n.url, n.provider]));

describe('GitHub watcher files', () => {
  it('runs every 10 minutes on GitHub, reads keys only from secrets, and lists every server', () => {
    const wf = parse(watcherWorkflow('https://om-shop-api.me.workers.dev', nodes, labels));
    expect(wf.on.schedule).toEqual([{ cron: '*/10 * * * *' }]);
    expect(wf.on).toHaveProperty('workflow_dispatch');
    expect(wf.permissions).toEqual({ contents: 'read' });
    const step = wf.jobs.watch.steps.at(-1);
    expect(step.run).toBe(`node ${SCRIPT_PATH}`);
    expect(step.env.OMNIMESH_ROUTER_URL).toBe('https://om-shop-api.me.workers.dev');
    expect(JSON.parse(step.env.OMNIMESH_SERVERS)).toEqual(nodes.map((n) => ({ label: n.provider, ...n })));
    for (const name of watcherSecretNames(nodes)) expect(step.env[name]).toBe(`\${{ secrets.${name} }}`);
    expect(watcherSecretNames(nodes)).toEqual(['OMNIMESH_STATUS_TOKEN', 'OCI_TENANCY', 'OCI_USER', 'OCI_FINGERPRINT', 'OCI_PRIVATE_KEY', 'KOYEB_API_TOKEN', 'RENDER_API_KEY']);
  });

  it('commits both files and stores secrets that only GitHub can decrypt', async () => {
    await sodium.ready;
    const kp = sodium.crypto_box_keypair();
    const { deps, calls } = mockCloud({ githubPublicKey: sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL) });
    await installWatcher(
      deps,
      { token: 'ghp_test', slug: 'github.com/me/shop-api', branch: 'main', files: { [WORKFLOW_PATH]: 'wf', [SCRIPT_PATH]: watcherScript() }, secrets: { OMNIMESH_STATUS_TOKEN: 'st', KOYEB_API_TOKEN: 'kt' } },
      'https://github.test'
    );
    const secretPuts = calls.filter((c) => c.method === 'PUT' && c.url.includes('/actions/secrets/'));
    expect(secretPuts.map((c) => c.url.split('/').pop())).toEqual(['OMNIMESH_STATUS_TOKEN', 'KOYEB_API_TOKEN']);
    for (const c of secretPuts) {
      expect(c.body.key_id).toBe('k1');
      expect(c.body.encrypted_value).not.toMatch(/^(st|kt)$/);
      const plain = sodium.to_string(sodium.crypto_box_seal_open(sodium.from_base64(c.body.encrypted_value, sodium.base64_variants.ORIGINAL), kp.publicKey, kp.privateKey));
      expect(plain).toBe(c.url.endsWith('OMNIMESH_STATUS_TOKEN') ? 'st' : 'kt');
    }
    const filePuts = calls.filter((c) => c.method === 'PUT' && c.url.includes('/contents/'));
    expect(filePuts.map((c) => c.url.split('/contents/')[1])).toEqual([WORKFLOW_PATH, SCRIPT_PATH]);
    expect(filePuts[0].body).toMatchObject({ branch: 'main', content: Buffer.from('wf').toString('base64') });
    // Secrets go in before the workflow, so its first run has them
    expect(calls.findIndex((c) => c.url.includes('/actions/secrets/KOYEB'))).toBeLessThan(calls.findIndex((c) => c.url.includes('/contents/')));
    expect(calls.filter((c) => c.url.startsWith('https://github.test')).every((c) => c.headers.get('authorization') === 'Bearer ghp_test')).toBe(true);
  });
});

describe('GitHub watcher run (the committed script)', () => {
  const SECRET = 's3cr3t_gateway_token_min_32_characters_long_for_security';
  const TOKEN = 'status-token-for-tests-0123456789abcdef';
  const servers: any[] = [];
  let koyebUrl = '';
  let renderUrl = '';
  let routerUrl = '';
  let koyebDown = false;
  const realFetch = globalThis.fetch;
  const cloudCalls: Array<{ method: string; url: string; body: string; headers: Headers }> = [];
  let koyebStatus = 'HEALTHY';

  const start = (fetchImpl: any) =>
    new Promise<string>((resolve) => servers.push(serve({ fetch: fetchImpl, port: 0, hostname: '127.0.0.1' }, (i) => resolve(`http://127.0.0.1:${i.port}`))));

  beforeAll(async () => {
    const app = (down: () => boolean) => {
      const a = new Hono();
      a.use('*', gatewayAuth({ secret: SECRET }));
      a.get('/health', (c) => (down() ? c.text('down', 503) : c.json({ ok: true })));
      return a.fetch;
    };
    koyebUrl = await start(app(() => koyebDown));
    renderUrl = await start(app(() => false));
    const config = validateOmniMeshConfig({ profile: 'no-card', domain: 'x.test', defaultPool: '/', pools: { '/': [{ url: koyebUrl, providerId: 'koyeb' }, { url: renderUrl, providerId: 'render' }] }, keepAlive: { enabled: true } });
    routerUrl = await start(createRouterApp({ config, gatewaySecret: SECRET, statusToken: TOKEN, manualCheckCooldownMs: 0 }).fetch);
  });
  afterAll(() => servers.forEach((s) => s.close()));
  afterEach(() => {
    vi.unstubAllGlobals();
    cloudCalls.length = 0;
  });

  /** Real network to the local router; the clouds' APIs are answered here. */
  function stubClouds(answer: (url: URL, method: string) => Response | null) {
    vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
      const url = new URL(input);
      if (url.hostname === '127.0.0.1') return realFetch(input, init);
      cloudCalls.push({ method: init.method ?? 'GET', url: input, body: String(init.body ?? ''), headers: new Headers(init.headers) });
      return answer(url, init.method ?? 'GET') ?? new Response('{"message":"unmocked"}', { status: 500 });
    });
  }
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

  function env(extra: Record<string, string> = {}) {
    Object.assign(process.env, {
      OMNIMESH_ROUTER_URL: routerUrl,
      OMNIMESH_SERVERS: JSON.stringify([
        { label: 'koyeb', provider: 'koyeb', url: koyebUrl, serviceId: 'ksvc1' },
        { label: 'render', provider: 'render', url: renderUrl, serviceId: 'rsvc1' },
      ]),
      OMNIMESH_STATUS_TOKEN: TOKEN,
      KOYEB_API_TOKEN: 'kt',
      RENDER_API_KEY: 'rt',
      OMNIMESH_RECHECK_SECONDS: '0',
      ...extra,
    });
  }

  it('does nothing when every server answers', async () => {
    env();
    stubClouds(() => null);
    const logs: string[] = [];
    expect(await run((m: string) => logs.push(m))).toEqual({ failed: 0, healed: [] });
    expect(cloudCalls).toEqual([]);
    expect(logs).toEqual(['koyeb: online', 'render: online']);
  }, 20_000);

  it('restarts a server that is still down a moment later, with the same build', async () => {
    env();
    koyebDown = true;
    stubClouds((url, method) => {
      if (url.pathname === '/v1/services/ksvc1' && method === 'GET') return json({ service: { status: koyebStatus } });
      if (url.pathname === '/v1/services/ksvc1/redeploy' && method === 'POST') return json({ deployment: {} });
      return null;
    });
    try {
      const r = await run(() => {});
      expect(r).toEqual({ failed: 0, healed: ['koyeb'] });
      const redeploy = cloudCalls.find((c) => c.url.endsWith('/redeploy'))!;
      expect(redeploy.url).toBe('https://app.koyeb.com/v1/services/ksvc1/redeploy');
      expect(JSON.parse(redeploy.body)).toEqual({ skip_build: true });
      expect(redeploy.headers.get('authorization')).toBe('Bearer kt');
      expect(cloudCalls.some((c) => c.url.includes('render.com'))).toBe(false); // render was fine
    } finally {
      koyebDown = false;
    }
  }, 20_000);

  it('reports a server it could not fix, so the GitHub run fails and emails the owner', async () => {
    env({ KOYEB_API_TOKEN: '' });
    koyebDown = true;
    stubClouds(() => null);
    const logs: string[] = [];
    try {
      expect(await run((m: string) => logs.push(m))).toEqual({ failed: 1, healed: [] });
      expect(logs.at(-1)).toMatch(/::error::koyeb: the KOYEB_API_TOKEN secret is missing/);
    } finally {
      koyebDown = false;
    }
  }, 20_000);

  it('starts a stopped Oracle server with a correctly signed request', async () => {
    const key = fs.readFileSync(path.join(__dirname, 'fixtures', 'oci-test-key.pem'), 'utf-8');
    env({
      OMNIMESH_SERVERS: JSON.stringify([{ label: 'oracle', provider: 'oracle', url: koyebUrl, serviceId: 'ocid1.instance.oc1..abc', region: 'us-ashburn-1' }]),
      OCI_TENANCY: 'ocid1.tenancy.oc1..t',
      OCI_USER: 'ocid1.user.oc1..u',
      OCI_FINGERPRINT: 'aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99',
      OCI_PRIVATE_KEY: key,
    });
    koyebDown = true;
    stubClouds((url, method) => {
      if (url.host !== 'iaas.us-ashburn-1.oraclecloud.com') return null;
      return method === 'GET' ? json({ lifecycleState: 'STOPPED' }) : json({ lifecycleState: 'STARTING' });
    });
    try {
      expect(await run(() => {})).toEqual({ failed: 0, healed: ['oracle'] });
      const startCall = cloudCalls.find((c) => c.method === 'POST')!;
      expect(startCall.url).toBe('https://iaas.us-ashburn-1.oraclecloud.com/20160918/instances/ocid1.instance.oc1..abc?action=START');
      // Verify the signature the way Oracle does: rebuild the signing string, check it with the public key
      const auth = startCall.headers.get('authorization')!;
      const names = auth.match(/headers="([^"]+)"/)![1].split(' ');
      expect(names).toEqual(['date', '(request-target)', 'host', 'content-length', 'content-type', 'x-content-sha256']);
      const value = (n: string) =>
        n === '(request-target)' ? 'post /20160918/instances/ocid1.instance.oc1..abc?action=START' : n === 'host' ? 'iaas.us-ashburn-1.oraclecloud.com' : n === 'content-length' ? '0' : startCall.headers.get(n)!;
      const signingString = names.map((n) => `${n}: ${value(n)}`).join('\n');
      const signature = Buffer.from(auth.match(/signature="([^"]+)"/)![1], 'base64');
      expect(crypto.verify('sha256', Buffer.from(signingString), crypto.createPublicKey(key), signature)).toBe(true);
    } finally {
      koyebDown = false;
    }
  }, 20_000);
});
