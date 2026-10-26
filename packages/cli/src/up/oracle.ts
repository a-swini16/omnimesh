import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CloudApiError, waitFor, type Deps } from './http.js';
import { ociClient, ociList, type OciCredentials } from './oci.js';
import type { RepoInfo } from './detect.js';
import { runSettings, type BackendDeployResult } from './koyeb.js';

const SHAPE = 'VM.Standard.A1.Flex';
/** Always Free covers the first 1,500 OCPU hours and 9,000 GB hours of Arm a month: 2 OCPUs and 12 GB running all month */
export const FREE_A1_OCPUS = 2;
const GB_PER_OCPU = 6;
const IMAGE_PREFIXES = ['Canonical-Ubuntu-24.04-aarch64', 'Canonical-Ubuntu-22.04-aarch64'];
const BRANCH = /^[\w./-]+$/;
/** Each service gets its own port: the main app 8000, the next 8010, and so on (the gate uses port + 1 for the app) */
export const oraclePort = (index: number) => 8000 + index * 10;
/** Oracle allows 32,000 bytes of instance metadata in total, the first-boot script included */
const METADATA_LIMIT = 32_000;
const AGENT_SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'oracle', 'agent.py');

export interface OracleService {
  /** Stable id: "main" for "/", else the route's name, e.g. "auth" */
  id: string;
  route: string;
  repo: RepoInfo;
  env: Record<string, string>;
  /** Its own name on your Cloudflare domain, served by the tunnel */
  hostname: string;
  port: number;
}

export interface OracleDeployInput {
  creds: OciCredentials;
  /** Server name in the Oracle console */
  name: string;
  services: OracleService[];
  tunnelToken: string;
  existing?: { serviceId: string; url: string; region?: string };
  lock?: boolean;
}

/** oracle.example.com for the main app; oracle-auth.example.com for /auth (one level, so Cloudflare's free certificate covers it). */
export function oracleHostname(base: string, id: string): string {
  if (id === 'main') return base;
  const [first, ...rest] = base.split('.');
  return [`${first}-${id}`, ...rest].join('.');
}

/**
 * What the server should run, read by the agent from the instance metadata. Changing it (a new service,
 * a new setting) needs no new server: the agent applies it within 5 minutes.
 */
export function oracleManifest(input: { services: OracleService[]; tunnelToken: string; lock?: boolean }): string {
  let gate = '';
  const services = input.services.map((svc) => {
    if (!BRANCH.test(svc.repo.branch)) throw new Error(`Oracle: "${svc.repo.branch}" is not a branch name OmniMesh can use.`);
    for (const [k, v] of Object.entries(svc.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || /[\r\n]/.test(v)) throw new Error(`Oracle: setting ${k} cannot be passed to the server.`);
    }
    // The tunnel's public name reaches the app too, so it is locked like every other server
    const run = runSettings({ repo: svc.repo, lock: input.lock });
    if (run.locked) gate = run.env.OMNIMESH_GATE;
    return {
      id: svc.id,
      route: svc.route,
      port: svc.port,
      repoUrl: svc.repo.url,
      branch: svc.repo.branch,
      folder: svc.repo.folder ?? '',
      runtime: svc.repo.runtime,
      buildCommand: svc.repo.buildCommand ?? '',
      startCommand: run.startCommand ?? svc.repo.startCommand ?? 'npm start',
      gated: run.locked,
      env: svc.env,
    };
  });
  return JSON.stringify({ version: 1, tunnelToken: input.tunnelToken, gate, services });
}

/**
 * First-boot script. It holds no secrets and nothing app-specific: it installs Docker and the OmniMesh
 * agent, which reads the manifest from the instance metadata every 5 minutes and runs what it says.
 * No inbound ports are opened; the Cloudflare tunnel connects out.
 */
export function oracleCloudInit(): string {
  const agent = fs.readFileSync(AGENT_SOURCE).toString('base64');
  return `#!/bin/bash
# Written by omnimesh up. Runs once, on the first boot.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y docker.io git python3
systemctl enable --now docker
mkdir -p /opt/omnimesh
chmod 700 /opt/omnimesh
echo '${agent}' | base64 -d > /opt/omnimesh/agent.py
chmod 700 /opt/omnimesh/agent.py

cat > /etc/systemd/system/omnimesh-agent.service <<'OMNIMESH_UNIT'
[Unit]
Description=OmniMesh: run what this server's manifest says (tunnel and your services)
After=docker.service network-online.target
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /opt/omnimesh/agent.py
OMNIMESH_UNIT
cat > /etc/systemd/system/omnimesh-agent.timer <<'OMNIMESH_TIMER'
[Unit]
Description=OmniMesh: apply new commits and settings every 5 minutes
[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
OMNIMESH_TIMER
systemctl daemon-reload
systemctl enable --now omnimesh-agent.timer
# If the first build fails (a network blip, a bug in the app), the timer retries every 5 minutes
/usr/bin/python3 /opt/omnimesh/agent.py || echo "OmniMesh: first run failed; retrying every 5 minutes"
`;
}

/**
 * Hosts every service on one Oracle Always Free Arm VM in your home region, inside its own network with
 * no inbound ports, each reachable only through the Cloudflare Tunnel at its own name.
 * Returns one server per service.
 */
export async function deployOracle(deps: Deps, input: OracleDeployInput, apiBase?: string): Promise<Array<BackendDeployResult & { route: string }>> {
  const { creds } = input;
  const oci = ociClient(deps, creds, apiBase);
  const tenancy = creds.tenancy;
  const manifest = oracleManifest(input);
  const locked = JSON.parse(manifest).services.map((x: { gated: boolean }) => x.gated);
  const results = (instanceId: string, region: string, pending: boolean) =>
    input.services.map((svc, i) => ({
      provider: 'oracle',
      url: `https://${svc.hostname}`,
      serviceId: instanceId,
      region,
      route: svc.route,
      ...(pending ? { pending: true } : {}),
      ...(locked[i] ? { locked: true } : {}),
    }));

  // Always Free compute exists only in the home region
  const subs = await oci<Array<{ regionName: string; isHomeRegion: boolean }>>('identity', 'GET', `/tenancies/${tenancy}/regionSubscriptions`);
  const region = subs.data.find((s) => s.isHomeRegion)?.regionName ?? creds.region;
  if (region !== creds.region) deps.log(`Oracle: using your home region ${region} (Always Free only applies there)`);
  const at = { region };

  if (input.existing) {
    const id = input.existing.serviceId;
    const { data: inst } = await oci<{ lifecycleState: string; metadata?: Record<string, string> }>('iaas', 'GET', `/instances/${id}`, at).catch((e) => {
      if (e instanceof CloudApiError && e.status === 404) return { data: { lifecycleState: 'TERMINATED' } as { lifecycleState: string; metadata?: Record<string, string> } };
      throw e;
    });
    const alive = inst.lifecycleState !== 'TERMINATED' && inst.lifecycleState !== 'TERMINATING';
    if (alive && inst.metadata?.omnimesh !== undefined) {
      // Same server: hand it the new manifest (user_data must stay exactly as it is)
      checkMetadataSize(inst.metadata.user_data ?? '', manifest);
      await oci('iaas', 'PUT', `/instances/${id}`, { ...at, body: { metadata: { ...inst.metadata, omnimesh: manifest } } });
      if (inst.lifecycleState === 'STOPPED') {
        deps.log('Oracle: the server was stopped; starting it');
        await oci('iaas', 'POST', `/instances/${id}`, { ...at, query: { action: 'START' } });
      }
      deps.log('Oracle: updated; the server applies your latest commits and settings within 5 minutes');
      return results(id, region, false);
    }
    if (alive) {
      // Made by an older OmniMesh that ran one app without a manifest: replace it
      deps.log('Oracle: replacing the server with one that can run several services');
      await oci('iaas', 'DELETE', `/instances/${id}`, { ...at, query: { preserveBootVolume: 'false' } });
      await waitFor(deps, async () => {
        const { data } = await oci('iaas', 'GET', `/instances/${id}`, at);
        return data.lifecycleState === 'TERMINATED' ? true : null;
      }, 10 * 60_000);
    } else {
      deps.log('Oracle: the previous server is gone; creating a new one');
    }
  }

  // Stay inside the free allowance: count Arm OCPUs already in use in the root compartment
  const instances = await ociList<{ displayName: string; shape: string; lifecycleState: string; shapeConfig?: { ocpus?: number } }>(oci, 'iaas', '/instances', {
    ...at,
    query: { compartmentId: tenancy },
  });
  const a1 = instances.filter((i) => i.shape === SHAPE && !['TERMINATED', 'TERMINATING'].includes(i.lifecycleState));
  const used = a1.reduce((sum, i) => sum + (i.shapeConfig?.ocpus ?? 0), 0);
  const ocpus = Math.floor(FREE_A1_OCPUS - used);
  if (ocpus < 1) {
    throw new Error(`Oracle: your free Arm allowance (${FREE_A1_OCPUS} OCPUs) is already used by ${a1.map((i) => i.displayName).join(', ')}. Delete one in the Oracle console, or deploy without Oracle.`);
  }

  deps.log('Oracle: preparing a private network (no inbound ports)');
  const vcnName = 'omnimesh-vcn';
  const vcns = await ociList<{ id: string; lifecycleState: string; defaultRouteTableId: string; defaultSecurityListId: string }>(oci, 'iaas', '/vcns', {
    ...at,
    query: { compartmentId: tenancy, displayName: vcnName },
  });
  let vcn = vcns.find((v) => v.lifecycleState === 'AVAILABLE');
  if (!vcn) {
    const { data } = await oci('iaas', 'POST', '/vcns', { ...at, body: { compartmentId: tenancy, cidrBlocks: ['10.0.0.0/16'], displayName: vcnName, dnsLabel: 'omnimesh' } });
    vcn = (await waitFor(deps, async () => {
      const { data: v } = await oci('iaas', 'GET', `/vcns/${data.id}`, at);
      return v.lifecycleState === 'AVAILABLE' ? v : null;
    }, 5 * 60_000, 3000)) ?? undefined;
    if (!vcn) throw new Error('Oracle: the network did not become available within 5 minutes');
  }

  const igws = await ociList<{ id: string; lifecycleState: string }>(oci, 'iaas', '/internetGateways', { ...at, query: { compartmentId: tenancy, vcnId: vcn.id } });
  const igwId =
    igws.find((g) => g.lifecycleState === 'AVAILABLE')?.id ??
    (await oci('iaas', 'POST', '/internetGateways', { ...at, body: { compartmentId: tenancy, vcnId: vcn.id, isEnabled: true, displayName: 'omnimesh-igw' } })).data.id;
  // Outbound only: the server reaches GitHub, Docker Hub and Cloudflare; nothing can connect in
  await oci('iaas', 'PUT', `/routeTables/${vcn.defaultRouteTableId}`, {
    ...at,
    body: { routeRules: [{ destination: '0.0.0.0/0', destinationType: 'CIDR_BLOCK', networkEntityId: igwId }] },
  });
  await oci('iaas', 'PUT', `/securityLists/${vcn.defaultSecurityListId}`, {
    ...at,
    body: { ingressSecurityRules: [], egressSecurityRules: [{ destination: '0.0.0.0/0', destinationType: 'CIDR_BLOCK', protocol: 'all', isStateless: false }] },
  });

  const subnets = await ociList<{ id: string; lifecycleState: string }>(oci, 'iaas', '/subnets', { ...at, query: { compartmentId: tenancy, vcnId: vcn.id } });
  let subnetId = subnets.find((s) => s.lifecycleState === 'AVAILABLE')?.id;
  if (!subnetId) {
    const { data } = await oci('iaas', 'POST', '/subnets', {
      ...at,
      body: { compartmentId: tenancy, vcnId: vcn.id, cidrBlock: '10.0.0.0/24', displayName: 'omnimesh-subnet', dnsLabel: 'omnimesh' },
    });
    subnetId = data.id as string;
    await waitFor(deps, async () => ((await oci('iaas', 'GET', `/subnets/${subnetId}`, at)).data.lifecycleState === 'AVAILABLE' ? true : null), 5 * 60_000, 3000);
  }

  const images = await ociList<{ id: string; displayName: string }>(oci, 'iaas', '/images', {
    ...at,
    query: { compartmentId: tenancy, shape: SHAPE, lifecycleState: 'AVAILABLE', sortBy: 'TIMECREATED', sortOrder: 'DESC', limit: 100 },
  }, 5);
  const image = IMAGE_PREFIXES.map((p) => images.find((i) => i.displayName.startsWith(p))).find(Boolean);
  if (!image) throw new Error(`Oracle: no Ubuntu image for Arm servers was found in ${region}.`);

  const ads = await oci<Array<{ name: string }>>('identity', 'GET', '/availabilityDomains', { ...at, query: { compartmentId: tenancy } });
  const userData = Buffer.from(oracleCloudInit()).toString('base64');
  checkMetadataSize(userData, manifest);

  deps.log(`Oracle: creating a free Arm server (${ocpus} OCPU, ${ocpus * GB_PER_OCPU} GB)`);
  let instanceId: string | undefined;
  let capacityErrors = 0;
  for (const ad of ads.data) {
    try {
      const { data } = await oci('iaas', 'POST', '/instances', {
        ...at,
        body: {
          availabilityDomain: ad.name,
          compartmentId: tenancy,
          displayName: input.name,
          shape: SHAPE,
          shapeConfig: { ocpus, memoryInGBs: ocpus * GB_PER_OCPU },
          sourceDetails: { sourceType: 'image', imageId: image.id, bootVolumeSizeInGBs: 50 },
          createVnicDetails: { subnetId, assignPublicIp: true },
          metadata: { user_data: userData, omnimesh: manifest },
          freeformTags: { omnimesh: input.name },
        },
      });
      instanceId = data.id;
      break;
    } catch (e) {
      // Free Arm capacity runs out often; another availability domain may still have some
      if (e instanceof CloudApiError && /capacity/i.test(e.message)) {
        capacityErrors += 1;
        deps.log(`Oracle: no free Arm capacity in ${ad.name}`);
        continue;
      }
      throw e;
    }
  }
  if (!instanceId) {
    throw new Error(
      capacityErrors
        ? `Oracle: no free Arm capacity in ${region} right now ("Out of host capacity"). This is common on Always Free. Your other clouds are deployed; run omnimesh up again later to add Oracle.`
        : 'Oracle: the server could not be created.'
    );
  }

  const running = await waitFor(deps, async () => {
    const { data } = await oci('iaas', 'GET', `/instances/${instanceId}`, at);
    if (data.lifecycleState === 'TERMINATED') throw new Error('Oracle: the server was terminated while starting.');
    return data.lifecycleState === 'RUNNING' ? true : null;
  }, 10 * 60_000);
  if (!running) throw new Error('Oracle: the server did not start within 10 minutes.');

  // First boot installs Docker and builds your app; the tunnel answers once it is up
  deps.log('Oracle: server running; installing Docker and building your app (about 5 to 10 minutes)');
  const url = `https://${input.services[0].hostname}`;
  const ready = await waitFor(deps, async () => {
    try {
      const res = await deps.fetch(url, { signal: AbortSignal.timeout(15_000) });
      await res.body?.cancel().catch(() => {});
      // 502/530 mean the tunnel or the app is not up yet
      return res.status < 500 ? true : null;
    } catch {
      return null;
    }
  }, 15 * 60_000, 15_000);
  deps.log(ready ? `Oracle: live at ${url}` : 'Oracle: the server is still building. It joins your mesh by itself once it answers.');
  return results(instanceId, region, !ready);
}

function checkMetadataSize(userData: string, manifest: string): void {
  const size = Buffer.byteLength(userData) + Buffer.byteLength(manifest) + 64;
  if (size > METADATA_LIMIT) {
    throw new Error(`Oracle: your services and settings need ${size} bytes, but Oracle allows ${METADATA_LIMIT} per server. Remove some settings or a service from Oracle.`);
  }
}
