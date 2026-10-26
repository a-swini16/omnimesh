import { CloudApiError, waitFor, type Deps } from './http.js';
import { ociClient, ociList, type OciCredentials } from './oci.js';
import type { RepoInfo } from './detect.js';
import { runSettings, type BackendDeployResult } from './koyeb.js';

const PORT = 8000;
const SHAPE = 'VM.Standard.A1.Flex';
/** Always Free covers the first 1,500 OCPU hours and 9,000 GB hours of Arm a month: 2 OCPUs and 12 GB running all month */
export const FREE_A1_OCPUS = 2;
const GB_PER_OCPU = 6;
const IMAGE_PREFIXES = ['Canonical-Ubuntu-24.04-aarch64', 'Canonical-Ubuntu-22.04-aarch64'];
const BRANCH = /^[\w./-]+$/;

export interface OracleDeployInput {
  creds: OciCredentials;
  repo: RepoInfo;
  name: string;
  env: Record<string, string>;
  /** Public name the tunnel serves, e.g. oracle.example.com */
  hostname: string;
  tunnelToken: string;
  existing?: { serviceId: string; url: string; region?: string };
  lock?: boolean;
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Container recipe for repos without a Dockerfile, matching what Koyeb and Render run. */
function dockerfileFor(repo: RepoInfo, startCommand?: string): string | null {
  if (repo.runtime === 'docker') return null;
  const base = repo.runtime === 'node' ? 'node:22-bookworm-slim' : 'python:3.12-slim';
  return [
    `FROM ${base}`,
    'WORKDIR /app',
    'COPY . .',
    ...(repo.buildCommand ? [`RUN ${repo.buildCommand}`] : []),
    // Exec form with sh -c so $PORT is expanded at run time and the command is never re-parsed by us
    `CMD ["sh", "-c", ${JSON.stringify(startCommand ?? repo.startCommand ?? 'npm start')}]`,
    '',
  ].join('\n');
}

/**
 * First-boot script for the VM. It installs Docker, runs your app on port 8000, and runs cloudflared so
 * the app is reachable only through the tunnel (no inbound ports are open). A timer pulls your branch
 * every 5 minutes and rebuilds only when a new commit arrived, so pushing to GitHub updates this server.
 */
export function oracleCloudInit(input: { repo: RepoInfo; env: Record<string, string>; tunnelToken: string; lock?: boolean }): string {
  const { repo } = input;
  if (!BRANCH.test(repo.branch)) throw new Error(`Oracle: "${repo.branch}" is not a branch name OmniMesh can use.`);
  // The tunnel's public name reaches the app too, so it is locked like every other server
  const run = runSettings(input);
  const env = Object.entries({ ...input.env, ...run.env, PORT: String(PORT) })
    .map(([k, v]) => {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(k) || /[\r\n]/.test(v)) throw new Error(`Oracle: environment variable ${k} cannot be passed to the server.`);
      return `${k}=${v}`;
    })
    .join('\n');
  const dockerfile = dockerfileFor(repo, run.startCommand);
  const build = dockerfile ? 'docker build -f /opt/omnimesh/Dockerfile.omnimesh -t omnimesh-app src' : 'docker build -t omnimesh-app src';

  return `#!/bin/bash
# Written by omnimesh up. Runs once, on the first boot.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y docker.io git
systemctl enable --now docker
mkdir -p /opt/omnimesh
cd /opt/omnimesh

cat > app.env <<'OMNIMESH_ENV'
${env}
OMNIMESH_ENV
printf '%s' ${shellQuote(input.tunnelToken)} > tunnel.token
chmod 600 app.env tunnel.token
${dockerfile ? `cat > Dockerfile.omnimesh <<'OMNIMESH_DOCKERFILE'\n${dockerfile}OMNIMESH_DOCKERFILE\n` : ''}
cat > deploy.sh <<'OMNIMESH_DEPLOY'
#!/bin/bash
# Pull the branch; rebuild and restart the app only when a new commit arrived (or it is not running)
set -euo pipefail
cd /opt/omnimesh
if [ ! -d src/.git ]; then
  git clone --depth 1 --branch ${shellQuote(repo.branch)} ${shellQuote(repo.url)} src
else
  old=$(git -C src rev-parse HEAD)
  git -C src fetch --depth 1 origin ${shellQuote(repo.branch)}
  new=$(git -C src rev-parse FETCH_HEAD)
  running=$(docker ps -q -f name=^app$)
  if [ "$old" = "$new" ] && [ -n "$running" ]; then exit 0; fi
  # A commit that only changes .github (for example the OmniMesh watcher) needs no rebuild
  if [ -n "$running" ] && git -C src diff --quiet "$old" "$new" -- . ':(exclude).github'; then git -C src reset --hard FETCH_HEAD; exit 0; fi
  git -C src reset --hard FETCH_HEAD
fi
${build}
docker rm -f app >/dev/null 2>&1 || true
docker run -d --name app --restart unless-stopped --network host --env-file /opt/omnimesh/app.env omnimesh-app
OMNIMESH_DEPLOY
chmod 700 deploy.sh

cat > /etc/systemd/system/omnimesh-deploy.service <<'OMNIMESH_UNIT'
[Unit]
Description=OmniMesh: pull and run the latest commit
After=docker.service network-online.target
[Service]
Type=oneshot
ExecStart=/opt/omnimesh/deploy.sh
OMNIMESH_UNIT
cat > /etc/systemd/system/omnimesh-deploy.timer <<'OMNIMESH_TIMER'
[Unit]
Description=OmniMesh: check GitHub for new commits every 5 minutes
[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
OMNIMESH_TIMER
systemctl daemon-reload

# Tunnel and timer first: if the first build fails (a network blip, a bug in the app), the timer
# retries every 5 minutes and picks up the fix as soon as it is pushed
docker rm -f tunnel >/dev/null 2>&1 || true
docker run -d --name tunnel --restart unless-stopped --network host cloudflare/cloudflared:latest tunnel --no-autoupdate run --token "$(cat /opt/omnimesh/tunnel.token)"
systemctl enable --now omnimesh-deploy.timer
/opt/omnimesh/deploy.sh || echo "OmniMesh: first build failed; retrying every 5 minutes"
`;
}

/**
 * Hosts the repo on an Oracle Always Free Arm VM in your home region, inside its own network with no
 * inbound ports, reachable only through a Cloudflare Tunnel at `hostname`.
 */
export async function deployOracle(deps: Deps, input: OracleDeployInput, apiBase?: string): Promise<BackendDeployResult> {
  const { creds } = input;
  const oci = ociClient(deps, creds, apiBase);
  const tenancy = creds.tenancy;
  const url = `https://${input.hostname}`;

  // Always Free compute exists only in the home region
  const subs = await oci<Array<{ regionName: string; isHomeRegion: boolean }>>('identity', 'GET', `/tenancies/${tenancy}/regionSubscriptions`);
  const region = subs.data.find((s) => s.isHomeRegion)?.regionName ?? creds.region;
  if (region !== creds.region) deps.log(`Oracle: using your home region ${region} (Always Free only applies there)`);
  const at = { region };

  if (input.existing) {
    const { data: inst } = await oci<{ lifecycleState: string }>('iaas', 'GET', `/instances/${input.existing.serviceId}`, at).catch((e) => {
      if (e instanceof CloudApiError && e.status === 404) return { data: { lifecycleState: 'TERMINATED' } };
      throw e;
    });
    if (inst.lifecycleState === 'STOPPED') {
      deps.log('Oracle: the server was stopped; starting it');
      await oci('iaas', 'POST', `/instances/${input.existing.serviceId}`, { ...at, query: { action: 'START' } });
    }
    if (inst.lifecycleState !== 'TERMINATED' && inst.lifecycleState !== 'TERMINATING') {
      deps.log('Oracle: the server pulls your latest commit from GitHub by itself within 5 minutes');
      return { provider: 'oracle', url: input.existing.url, serviceId: input.existing.serviceId, region };
    }
    deps.log('Oracle: the previous server is gone; creating a new one');
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
  const userData = Buffer.from(oracleCloudInit({ repo: input.repo, env: input.env, tunnelToken: input.tunnelToken, lock: input.lock })).toString('base64');
  const locked = runSettings(input).locked;

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
          metadata: { user_data: userData },
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
  return { provider: 'oracle', url, serviceId: instanceId, region, ...(ready ? {} : { pending: true }), ...(locked ? { locked: true } : {}) };
}
