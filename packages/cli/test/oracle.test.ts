import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ociSignedHeaders, parseOciCredentials } from '../src/up/oci.js';
import { deployOracle, oracleCloudInit } from '../src/up/oracle.js';
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

describe('Oracle first-boot script', () => {
  it('runs the app behind the tunnel, with no inbound ports, and updates itself from GitHub', () => {
    const script = oracleCloudInit({ repo, env: { GATEWAY_SECRET: 'g'.repeat(64), OMNIMESH_PROVIDER: 'oracle' }, tunnelToken: "tok'en" });
    expect(script.startsWith('#!/bin/bash')).toBe(true);
    expect(script).toContain(`GATEWAY_SECRET=${'g'.repeat(64)}`);
    expect(script).toContain('PORT=8000');
    expect(script).toContain("printf '%s' 'tok'\\''en' > tunnel.token"); // a quote in the token cannot break out
    expect(script).toContain("git clone --depth 1 --branch 'main' 'https://github.com/me/shop-api' src");
    expect(script).toContain('FROM node:22-bookworm-slim');
    expect(script).toContain('RUN npm install && npm run build');
    expect(script).toContain('CMD ["sh", "-c", "npm start"]');
    expect(script).toContain('cloudflare/cloudflared:latest tunnel --no-autoupdate run --token');
    expect(script).toContain('OnUnitActiveSec=5min');
    expect(script).not.toMatch(/-p \d+:|--publish|iptables|ufw allow/); // nothing is opened to the internet
    // A failed first build must not stop the tunnel or the timer that retries it
    expect(script.indexOf('enable --now omnimesh-deploy.timer')).toBeLessThan(script.lastIndexOf('/opt/omnimesh/deploy.sh ||'));
    expect(script.indexOf('cloudflared:latest')).toBeLessThan(script.lastIndexOf('/opt/omnimesh/deploy.sh ||'));
    expect(script).toContain("':(exclude).github'"); // a watcher-only commit does not rebuild
  });

  it('refuses values that could change the script', () => {
    expect(() => oracleCloudInit({ repo: { ...repo, branch: 'main;rm -rf /' }, env: {}, tunnelToken: 't' })).toThrow(/branch/);
    expect(() => oracleCloudInit({ repo, env: { GATEWAY_SECRET: 'a\nB=c' }, tunnelToken: 't' })).toThrow(/GATEWAY_SECRET/);
    expect(oracleCloudInit({ repo: { ...repo, runtime: 'docker' }, env: {}, tunnelToken: 't' })).toContain('docker build -t omnimesh-app src');
  });
});

describe('Oracle deploy (against a fake Oracle API)', () => {
  const job = { creds, repo, name: 'om-shop-api', env: { GATEWAY_SECRET: 'g'.repeat(64) }, hostname: 'oracle.example.com', tunnelToken: 'tok' };

  it('builds the network, picks the right image, uses the home region and every request is signed', async () => {
    const { deps, calls } = mockCloud();
    const result = await deployOracle(deps, job, 'https://oracle.test');
    expect(result).toEqual({ provider: 'oracle', url: 'https://oracle.example.com', serviceId: 'inst1', region: 'us-ashburn-1' });

    const oci = calls.filter((c) => c.url.startsWith('https://oracle.test'));
    expect(oci.every((c) => c.headers.get('authorization')?.startsWith('Signature version="1"'))).toBe(true);
    const launch = oci.find((c) => c.method === 'POST' && c.url.endsWith('/iaas/20160918/instances'))!.body;
    expect(launch).toMatchObject({
      shape: 'VM.Standard.A1.Flex',
      shapeConfig: { ocpus: 2, memoryInGBs: 12 },
      sourceDetails: { sourceType: 'image', imageId: 'img1' },
      createVnicDetails: { subnetId: 'sub1', assignPublicIp: true },
    });
    expect(Buffer.from(launch.metadata.user_data, 'base64').toString()).toContain('cloudflared');
    // Inbound closed, outbound open
    const sec = oci.find((c) => c.method === 'PUT' && c.url.includes('/securityLists/'))!.body;
    expect(sec).toEqual({ ingressSecurityRules: [], egressSecurityRules: [{ destination: '0.0.0.0/0', destinationType: 'CIDR_BLOCK', protocol: 'all', isStateless: false }] });
  });

  it('tries the next availability domain when Oracle is out of free capacity, and explains when all are full', async () => {
    const some = mockCloud({ oracleCapacity: ['Uocm:US-ASHBURN-AD-3'] });
    expect((await deployOracle(some.deps, job, 'https://oracle.test')).serviceId).toBe('inst1');
    expect(some.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/instances')).length).toBe(3);

    await expect(deployOracle(mockCloud({ oracleCapacity: [] }).deps, job, 'https://oracle.test')).rejects.toThrow(/no free Arm capacity in us-ashburn-1/);
  });

  it('stays inside the free 2 OCPUs: uses what is left, refuses when nothing is', async () => {
    const half = mockCloud({ oracleUsedOcpus: 1 });
    await deployOracle(half.deps, job, 'https://oracle.test');
    expect(half.calls.find((c) => c.method === 'POST' && c.url.endsWith('/instances'))!.body.shapeConfig).toEqual({ ocpus: 1, memoryInGBs: 6 });
    await expect(deployOracle(mockCloud({ oracleUsedOcpus: 2 }).deps, job, 'https://oracle.test')).rejects.toThrow(/already used by my-other-vm/);
  });

  it('on a redeploy starts a stopped server instead of making a new one', async () => {
    const { deps, calls } = mockCloud({ oracleInstanceState: 'STOPPED' });
    const r = await deployOracle(deps, { ...job, existing: { serviceId: 'inst1', url: 'https://oracle.example.com' } }, 'https://oracle.test');
    expect(r.serviceId).toBe('inst1');
    expect(calls.some((c) => c.url.endsWith('/instances/inst1?action=START'))).toBe(true);
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/instances'))).toBe(false);
  });
});

describe('Cloudflare Tunnel for the Oracle server', () => {
  const input = { token: 'c'.repeat(40), accountId: 'acc1', name: 'omnimesh-om-shop-api', hostname: 'oracle.example.com', service: 'http://localhost:8000' };

  it('finds the zone, creates the tunnel, routes the name to it and returns the connection token', async () => {
    const { deps, calls } = mockCloud();
    expect(await ensureTunnel(deps, input, 'https://cloudflare.test')).toEqual({ tunnelId: 'tun1', tunnelToken: 'tunnel-token-xyz' });
    expect(calls.find((c) => c.url.endsWith('/cfd_tunnel') && c.method === 'POST')!.body).toEqual({ name: 'omnimesh-om-shop-api', config_src: 'cloudflare' });
    expect(calls.find((c) => c.url.endsWith('/configurations'))!.body.config.ingress).toEqual([
      { hostname: 'oracle.example.com', service: 'http://localhost:8000', originRequest: {} },
      { service: 'http_status:404' },
    ]);
    expect(calls.find((c) => c.url.endsWith('/dns_records') && c.method === 'POST')!.body).toEqual({ type: 'CNAME', name: 'oracle.example.com', content: 'tun1.cfargotunnel.com', proxied: true });
  });

  it('never takes over a name that is already in use, and needs a domain on Cloudflare', async () => {
    await expect(ensureTunnel(mockCloud({ dnsTaken: true }).deps, input, 'https://cloudflare.test')).rejects.toThrow(/already has a A record/);
    await expect(ensureTunnel(mockCloud().deps, { ...input, hostname: 'oracle.other.org' }, 'https://cloudflare.test')).rejects.toThrow(/not under a domain in your Cloudflare account/);
    await expect(ensureTunnel(mockCloud().deps, { ...input, hostname: 'bad name' }, 'https://cloudflare.test')).rejects.toThrow(/not a valid server name/);
  });
});
