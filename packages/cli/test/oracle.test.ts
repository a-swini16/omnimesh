import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ociSignedHeaders, parseOciCredentials } from '../src/up/oci.js';
import { deployOracle, oracleCloudInit, oracleHostname, oracleManifest, oraclePort, type OracleService } from '../src/up/oracle.js';
import { ensureTunnel } from '../src/up/tunnel.js';
import type { RepoInfo } from '../src/up/detect.js';
import { mockCloud } from './mock-cloud.js';

const FIXTURES = path.join(__dirname, 'fixtures');
const KEY = fs.readFileSync(path.join(FIXTURES, 'oci-test-key.pem'), 'utf-8');
const CONFIG = `[DEFAULT]
user=ocid1.user.oc1..aaaauser
fingerprint=aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99
tenancy=ocid1.tenancy.oc1..aaaatest
region=eu-frankfurt-1
key_file=<path to your private keyfile> # TODO`;
const creds = parseOciCredentials(CONFIG, `${KEY}\nOCI_API_KEY\n`);
const repo: RepoInfo = { slug: 'github.com/me/shop-api', url: 'https://github.com/me/shop-api', branch: 'main', defaultBranch: 'main', runtime: 'node', buildCommand: 'npm install && npm run build', startCommand: 'npm start' };

describe('Oracle request signing', () => {
  it('produces exactly the signatures Oracle\'s own SDK produces', () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'oci-sdk-signatures.json'), 'utf-8'));
    for (const r of fixture.requests) {
      const mine = ociSignedHeaders({ ...creds, region: 'us-ashburn-1' }, r.method, new URL(r.url), r.body, 'Thu, 05 Jan 2014 21:31:40 GMT');
      const part = (a: string, k: string) => a.match(new RegExp(`${k}="([^"]+)"`))![1];
      expect(part(mine.authorization, 'headers'), r.url).toBe(part(r.authorization, 'headers'));
      expect(part(mine.authorization, 'keyId')).toBe(part(r.authorization, 'keyId'));
      expect(part(mine.authorization, 'signature'), r.url).toBe(part(r.authorization, 'signature'));
    }
  });

  it('reads the Configuration File Preview and explains what is wrong', () => {
    expect(creds).toMatchObject({ tenancy: 'ocid1.tenancy.oc1..aaaatest', region: 'eu-frankfurt-1' });
    expect(creds.privateKey).not.toContain('OCI_API_KEY');
    expect(() => parseOciCredentials(CONFIG.replace(/tenancy=.*/, ''), KEY)).toThrow(/tenancy=/);
    expect(() => parseOciCredentials(CONFIG, 'not a key')).toThrow(/private key file/);
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    expect(() => parseOciCredentials(CONFIG, privateKey)).toThrow(/RSA/);
  });
});

describe('Oracle first-boot script and manifest', () => {
  const services: OracleService[] = [
    { id: 'main', route: '/', repo, env: { GATEWAY_SECRET: 'g'.repeat(64), OPENAI_API_KEY: 'sk-test' }, hostname: 'oracle.example.com', port: 8000 },
    { id: 'auth', route: '/auth', repo: { ...repo, folder: 'services/auth', runtime: 'python' as const, startCommand: 'uvicorn main:app --port $PORT' }, env: { GATEWAY_SECRET: 'g'.repeat(64) }, hostname: 'oracle-auth.example.com', port: 8010 },
  ];

  it('the first-boot script is generic: no secrets, no app details, nothing opened to the internet', () => {
    const script = oracleCloudInit();
    expect(script.startsWith('#!/bin/bash')).toBe(true);
    expect(script).not.toMatch(/GATEWAY_SECRET|tunnel\.token|github\.com\/me/);
    expect(script).toContain("| base64 -d > /opt/omnimesh/agent.py");
    expect(script).toContain('OnUnitActiveSec=5min');
    expect(script).not.toMatch(/-p \d+:|--publish|iptables|ufw allow/);
    // A failed first run must not stop the timer that retries it
    expect(script.indexOf('enable --now omnimesh-agent.timer')).toBeLessThan(script.lastIndexOf('agent.py ||'));
  });

  it('the manifest lists every service with its port, folder, lock and settings', () => {
    const m = JSON.parse(oracleManifest({ services, tunnelToken: 'tok', lock: true }));
    expect(m.tunnelToken).toBe('tok');
    expect(m.gate.length).toBeGreaterThan(1000); // the gate, once
    expect(m.services[0]).toMatchObject({ id: 'main', route: '/', port: 8000, runtime: 'node', gated: true, folder: '' });
    expect(m.services[0].startCommand).toMatch(/^node -e "eval\(Buffer\.from\(process\.env\.OMNIMESH_GATE/);
    expect(m.services[0].env).toEqual({ GATEWAY_SECRET: 'g'.repeat(64), OPENAI_API_KEY: 'sk-test' });
    // Python cannot be locked by the gate
    expect(m.services[1]).toMatchObject({ id: 'auth', port: 8010, folder: 'services/auth', runtime: 'python', gated: false, startCommand: 'uvicorn main:app --port $PORT' });
    expect(() => oracleManifest({ services: [{ ...services[0], env: { BAD: 'a\nb' } }], tunnelToken: 't' })).toThrow(/BAD/);
    expect(() => oracleManifest({ services: [{ ...services[0], repo: { ...repo, branch: 'main;rm -rf /' } }], tunnelToken: 't' })).toThrow(/branch/);
    expect(oracleHostname('oracle.example.com', 'main')).toBe('oracle.example.com');
    expect(oracleHostname('oracle.example.com', 'auth')).toBe('oracle-auth.example.com');
    expect(oraclePort(2)).toBe(8020);
  });
});

describe('Oracle deploy (against a fake Oracle API)', () => {
  const svc = (id: string, route: string, port: number) => ({ id, route, repo, env: { GATEWAY_SECRET: 'g'.repeat(64) }, hostname: id === 'main' ? 'oracle.example.com' : `oracle-${id}.example.com`, port });
  const job = { creds, name: 'om-shop-api', services: [svc('main', '/', 8000)], tunnelToken: 'tok', lock: true };

  it('builds the network, picks the right image, uses the home region and every request is signed', async () => {
    const { deps, calls } = mockCloud();
    const result = await deployOracle(deps, job, 'https://oracle.test');
    expect(result).toEqual([{ provider: 'oracle', url: 'https://oracle.example.com', serviceId: 'inst1', region: 'us-ashburn-1', route: '/', locked: true }]);

    const oci = calls.filter((c) => c.url.startsWith('https://oracle.test'));
    expect(oci.every((c) => c.headers.get('authorization')?.startsWith('Signature version="1"'))).toBe(true);
    const launch = oci.find((c) => c.method === 'POST' && c.url.endsWith('/iaas/20160918/instances'))!.body;
    expect(launch).toMatchObject({
      shape: 'VM.Standard.A1.Flex',
      shapeConfig: { ocpus: 2, memoryInGBs: 12 },
      sourceDetails: { sourceType: 'image', imageId: 'img1' },
      createVnicDetails: { subnetId: 'sub1', assignPublicIp: true },
    });
    expect(Buffer.from(launch.metadata.user_data, 'base64').toString()).toContain('omnimesh-agent.timer');
    expect(JSON.parse(launch.metadata.omnimesh).services[0].route).toBe('/');
    // Inbound closed, outbound open
    const sec = oci.find((c) => c.method === 'PUT' && c.url.includes('/securityLists/'))!.body;
    expect(sec).toEqual({ ingressSecurityRules: [], egressSecurityRules: [{ destination: '0.0.0.0/0', destinationType: 'CIDR_BLOCK', protocol: 'all', isStateless: false }] });
  });

  it('runs several services on the one server, each with its own address', async () => {
    const { deps } = mockCloud();
    const result = await deployOracle(deps, { ...job, services: [svc('main', '/', 8000), svc('auth', '/auth', 8010)] }, 'https://oracle.test');
    expect(result.map((r) => [r.route, r.url, r.serviceId])).toEqual([
      ['/', 'https://oracle.example.com', 'inst1'],
      ['/auth', 'https://oracle-auth.example.com', 'inst1'],
    ]);
  });

  it('tries the next availability domain when Oracle is out of free capacity, and explains when all are full', async () => {
    const some = mockCloud({ oracleCapacity: ['Uocm:US-ASHBURN-AD-3'] });
    expect((await deployOracle(some.deps, job, 'https://oracle.test'))[0].serviceId).toBe('inst1');
    expect(some.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/instances')).length).toBe(3);
    await expect(deployOracle(mockCloud({ oracleCapacity: [] }).deps, job, 'https://oracle.test')).rejects.toThrow(/no free Arm capacity in us-ashburn-1/);
  });

  it('stays inside the free 2 OCPUs: uses what is left, refuses when nothing is', async () => {
    const half = mockCloud({ oracleUsedOcpus: 1 });
    await deployOracle(half.deps, job, 'https://oracle.test');
    expect(half.calls.find((c) => c.method === 'POST' && c.url.endsWith('/instances'))!.body.shapeConfig).toEqual({ ocpus: 1, memoryInGBs: 6 });
    await expect(deployOracle(mockCloud({ oracleUsedOcpus: 2 }).deps, job, 'https://oracle.test')).rejects.toThrow(/already used by my-other-vm/);
  });

  it('on a redeploy updates the same server in place (user_data untouched) and starts it if stopped', async () => {
    const { deps, calls } = mockCloud({ oracleInstanceState: 'STOPPED' });
    const r = await deployOracle(deps, { ...job, services: [svc('main', '/', 8000), svc('auth', '/auth', 8010)], existing: { serviceId: 'inst1', url: 'https://oracle.example.com' } }, 'https://oracle.test');
    expect(r.map((x) => x.serviceId)).toEqual(['inst1', 'inst1']);
    const put = calls.find((c) => c.method === 'PUT' && c.url.endsWith('/instances/inst1'))!.body;
    expect(put.metadata.user_data).toBe('dXNlcg==');
    expect(JSON.parse(put.metadata.omnimesh).services.map((x: any) => x.route)).toEqual(['/', '/auth']);
    expect(calls.some((c) => c.url.endsWith('/instances/inst1?action=START'))).toBe(true);
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/instances'))).toBe(false);
  });

  it('replaces a server made by an older OmniMesh (no manifest) with a new one', async () => {
    const { deps, calls } = mockCloud({ oracleMetadata: { user_data: 'b2xk' } });
    await deployOracle(deps, { ...job, existing: { serviceId: 'inst1', url: 'https://oracle.example.com' } }, 'https://oracle.test');
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('/instances/inst1?preserveBootVolume=false'))).toBe(true);
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/iaas/20160918/instances'))).toBe(true);
  });
});

describe('Cloudflare Tunnel for the Oracle server', () => {
  const input = { token: 'c'.repeat(40), accountId: 'acc1', name: 'omnimesh-om-shop-api', routes: [{ hostname: 'oracle.example.com', service: 'http://localhost:8000' }] };

  it('finds the zone, creates the tunnel, routes every name to it and returns the connection token', async () => {
    const { deps, calls } = mockCloud();
    const routes = [...input.routes, { hostname: 'oracle-auth.example.com', service: 'http://localhost:8010' }];
    expect(await ensureTunnel(deps, { ...input, routes }, 'https://cloudflare.test')).toEqual({ tunnelId: 'tun1', tunnelToken: 'tunnel-token-xyz' });
    expect(calls.find((c) => c.url.endsWith('/cfd_tunnel') && c.method === 'POST')!.body).toEqual({ name: 'omnimesh-om-shop-api', config_src: 'cloudflare' });
    expect(calls.find((c) => c.url.endsWith('/configurations'))!.body.config.ingress).toEqual([
      { hostname: 'oracle.example.com', service: 'http://localhost:8000', originRequest: {} },
      { hostname: 'oracle-auth.example.com', service: 'http://localhost:8010', originRequest: {} },
      { service: 'http_status:404' },
    ]);
    expect(calls.filter((c) => c.url.endsWith('/dns_records') && c.method === 'POST').map((c) => c.body.name)).toEqual(['oracle.example.com', 'oracle-auth.example.com']);
  });

  it('keeps names that already point at the tunnel, never takes over others, and needs a domain on Cloudflare', async () => {
    const again = mockCloud({ dnsOurs: true });
    await ensureTunnel(again.deps, input, 'https://cloudflare.test');
    expect(again.calls.some((c) => c.url.endsWith('/dns_records') && c.method === 'POST')).toBe(false);
    await expect(ensureTunnel(mockCloud({ dnsTaken: true }).deps, input, 'https://cloudflare.test')).rejects.toThrow(/already has a A record/);
    await expect(ensureTunnel(mockCloud().deps, { ...input, routes: [{ hostname: 'oracle.other.org', service: 'x' }] }, 'https://cloudflare.test')).rejects.toThrow(/not under a domain/);
    await expect(ensureTunnel(mockCloud().deps, { ...input, routes: [{ hostname: 'bad name', service: 'x' }] }, 'https://cloudflare.test')).rejects.toThrow(/not a valid server name/);
  });
});
