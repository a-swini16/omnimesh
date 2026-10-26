import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { stringifyOmniMeshConfigYaml, validateOmniMeshConfig, type OmniMeshConfig } from '@omnimesh/core';
import { getProvider } from '@omnimesh/providers';
import { callApi, type Deps } from './http.js';
import { detectRepo, type RepoInfo } from './detect.js';
import { deployKoyeb, KOYEB_API, type BackendDeployResult } from './koyeb.js';
import { deployRender, RENDER_API } from './render.js';
import { deployCloudflareRouter, cloudflareAccountId, CLOUDFLARE_API } from './cloudflare.js';
import { deployOracle } from './oracle.js';
import { ensureTunnel } from './tunnel.js';
import { installWatcher, watcherScript, watcherWorkflow, watcherSecretNames, GITHUB_API, SCRIPT_PATH, WORKFLOW_PATH } from './watcher.js';
import type { OciCredentials } from './oci.js';
import { bundleRouter } from './bundle.js';

export interface UpInput {
  repoUrl: string;
  branch?: string;
  startCommand?: string;
  tokens: { koyeb?: string; render?: string; cloudflare: string; github?: string };
  cloudflareAccountId?: string;
  /** Only for people with a card: Oracle Always Free, reached through a Cloudflare Tunnel at `hostname` */
  oracle?: { creds: OciCredentials; hostname: string };
  /** The router checks sleeping free servers every 5 minutes too, which keeps them awake */
  keepAwake?: boolean;
  /** Add the GitHub watcher to the repo (needs tokens.github) */
  watcher?: boolean;
  /** Lock every server so only the router gets in (the OmniMesh gate; Node.js apps). Default on. */
  lock?: boolean;
}

export interface DeploymentState {
  appName: string;
  repo: RepoInfo;
  nodes: BackendDeployResult[];
  router: { url: string; accountId: string; kvNamespaceId: string };
  oracle?: { hostname: string; tunnelId: string };
  keepAwake?: boolean;
  watcher?: boolean;
  lock?: boolean;
  updatedAt: string;
}

export interface UpResult {
  appUrl: string;
  dashboardUrl: string;
  statusToken: string;
  nodes: BackendDeployResult[];
  failed: Array<{ provider: string; error: string }>;
  warnings: string[];
}

export interface UpOptions {
  cwd: string;
  /** Override provider API base URLs (tests use local mocks) */
  apis?: { koyeb?: string; render?: string; cloudflare?: string; oracle?: string; github?: string };
  /** Override the router bundle (tests) */
  bundle?: () => Promise<string>;
}

const STATE_FILE = path.join('.omnimesh', 'deployment.json');

export function loadState(cwd: string): DeploymentState | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, STATE_FILE), 'utf-8'));
  } catch {
    return null;
  }
}

/** Read KEY="value" lines from .env (empty object when missing). */
export function readDotEnv(cwd: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of fs.readFileSync(path.join(cwd, '.env'), 'utf-8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
      if (m) out[m[1]] = m[2];
    }
  } catch {
    // no .env yet
  }
  return out;
}

/** Merge keys into .env, keeping everything else, readable only by this user. */
export function writeDotEnv(cwd: string, values: Record<string, string | undefined>): void {
  const file = path.join(cwd, '.env');
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').split('\n') : ['# OmniMesh secrets. Never commit this file.'];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const line = `${key}="${value.replace(/"/g, '')}"`;
    const i = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (i >= 0) lines[i] = line;
    else lines.push(line);
  }
  fs.writeFileSync(file, lines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  // Secrets and deployment ids must never be committed
  const gitignore = path.join(cwd, '.gitignore');
  const ignored = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf-8').split('\n').map((l) => l.trim()) : [];
  const missing = ['.env', '.omnimesh/'].filter((entry) => !ignored.includes(entry) && !ignored.includes(entry.replace(/\/$/, '')));
  if (missing.length) fs.appendFileSync(gitignore, (ignored.length && ignored[ignored.length - 1] !== '' ? '\n' : '') + missing.join('\n') + '\n');
}

function appNameFor(repo: RepoInfo): string {
  const base = repo.slug.split('/').pop()!.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `om-${base}`.slice(0, 23).replace(/-$/, '');
}

function quotaFor(providerId: string): { requestsPerDay?: number; requestsPerMonth?: number } {
  const l = getProvider(providerId)?.limits;
  return {
    ...(l?.requestsPerDay ? { requestsPerDay: l.requestsPerDay } : {}),
    ...(l?.requestsPerMonth ? { requestsPerMonth: l.requestsPerMonth } : {}),
  };
}

/**
 * Router config for one backend deployed on several clouds: every path goes to the whole pool. Oracle
 * (always on, the most capacity) answers first once it is up; the free servers that sleep come after.
 */
export function meshConfig(domain: string, nodes: BackendDeployResult[], options: { keepAwake?: boolean } = {}): OmniMeshConfig {
  const rank = (n: BackendDeployResult) => (n.provider === 'oracle' && !n.pending ? 0 : n.pending ? 2 : 1);
  const ordered = [...nodes].sort((a, b) => rank(a) - rank(b));
  return validateOmniMeshConfig({
    profile: nodes.some((n) => getProvider(n.provider)?.requiresCard) ? 'with-card' : 'no-card',
    domain,
    defaultPool: '/',
    pools: { '/': ordered.map((n) => ({ url: n.url, providerId: n.provider, ...quotaFor(n.provider) })) },
    keepAlive: { enabled: Boolean(options.keepAwake) },
  });
}

/**
 * The whole "give us your backend" flow: detect the repo, deploy it on every connected cloud,
 * put the router in front on Cloudflare, verify it end to end, and save what is needed to redeploy.
 */
export async function runUp(deps: Deps, input: UpInput, opts: UpOptions): Promise<UpResult> {
  if (!input.tokens.cloudflare) throw new Error('Connect Cloudflare: it runs the router that gives your app one URL.');
  const backends = (['koyeb', 'render', 'oracle'] as const).filter((p) => (p === 'oracle' ? input.oracle : input.tokens[p]));
  if (!backends.length) throw new Error('Connect at least one cloud to host your backend (two or more for failover).');


  deps.log('Reading your GitHub repository');
  const repo = await detectRepo(deps, input.repoUrl, { branch: input.branch, startCommand: input.startCommand });
  deps.log(`Detected a ${repo.runtime === 'docker' ? 'Docker' : repo.runtime === 'node' ? 'Node.js' : 'Python'} app on branch ${repo.branch}`);

  const previous = loadState(opts.cwd);
  const sameApp = previous && previous.repo.slug === repo.slug;
  // An installed watcher keeps working without a token; one is needed only to add or update it
  const watcherInstalled = Boolean(sameApp && previous!.watcher);
  if (input.watcher && !input.tokens.github && !watcherInstalled) throw new Error('Paste a GitHub token to add the watcher, or turn the watcher off.');
  const env = readDotEnv(opts.cwd);
  const gatewaySecret = env.GATEWAY_SECRET && env.GATEWAY_SECRET.length >= 32 ? env.GATEWAY_SECRET : crypto.randomBytes(32).toString('hex');
  const statusToken = env.OMNIMESH_STATUS_TOKEN && env.OMNIMESH_STATUS_TOKEN.length >= 32 ? env.OMNIMESH_STATUS_TOKEN : crypto.randomBytes(24).toString('hex');
  const appName = sameApp ? previous!.appName : appNameFor(repo);

  const cfApi = opts.apis?.cloudflare ?? CLOUDFLARE_API;
  const accountId = await cloudflareAccountId(deps, input.tokens.cloudflare, input.cloudflareAccountId, cfApi);
  let tunnelId: string | undefined;

  const results = await Promise.allSettled(
    backends.map(async (provider) => {
      const existing = sameApp ? previous!.nodes.find((n) => n.provider === provider) : undefined;
      const env = { GATEWAY_SECRET: gatewaySecret, OMNIMESH_PROVIDER: provider };
      const lock = input.lock !== false;
      if (provider === 'oracle') {
        const { hostname, creds } = input.oracle!;
        const tunnel = await ensureTunnel(deps, { token: input.tokens.cloudflare, accountId, name: `omnimesh-${appName}`, hostname, service: 'http://localhost:8000' }, cfApi);
        tunnelId = tunnel.tunnelId;
        return deployOracle(deps, { creds, repo, name: appName, env, hostname, tunnelToken: tunnel.tunnelToken, existing, lock }, opts.apis?.oracle);
      }
      const job = { token: input.tokens[provider]!, repo, name: appName, env, existing, lock };
      return provider === 'koyeb' ? deployKoyeb(deps, job, opts.apis?.koyeb ?? KOYEB_API) : deployRender(deps, job, opts.apis?.render ?? RENDER_API);
    })
  );
  const nodes = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [{ provider: backends[i], error: (r.reason as Error).message }] : []));
  for (const f of failed) deps.log(`✖ ${f.error}`);
  if (!nodes.length) throw new Error('No cloud could host the backend. Fix the errors above and run it again.');

  deps.log('Building the router');
  const script = await (opts.bundle ?? bundleRouter)();
  const scriptName = appName;
  const router = await deployCloudflareRouter(
    deps,
    {
      token: input.tokens.cloudflare,
      accountId,
      scriptName,
      script,
      secrets: {
        GATEWAY_SECRET: gatewaySecret,
        OMNIMESH_STATUS_TOKEN: statusToken,
        OMNIMESH_CONFIG_YAML: stringifyOmniMeshConfigYaml(meshConfig(`${scriptName}.workers.dev`, nodes, { keepAwake: input.keepAwake })),
      },
      vars: {
        OMNIMESH_APP: JSON.stringify({
          repo: repo.slug,
          repoUrl: `https://github.com/${repo.slug}`,
          branch: repo.branch,
          runtime: repo.runtime,
          deployedAt: new Date().toISOString(),
          watcher: Boolean(input.watcher),
        }),
      },
    },
    cfApi
  );
  const config = meshConfig(new URL(router.url).host, nodes, { keepAwake: input.keepAwake });

  deps.log('Checking your app through the router');
  const warnings: string[] = [];
  try {
    const status = await callApi(deps, 'Router', `${router.url}/_omnimesh/status`, { headers: { Authorization: `Bearer ${statusToken}` } });
    deps.log(`Router sees ${status.pools?.[0]?.nodes?.length ?? 0} servers`);
    const res = await deps.fetch(`${router.url}/`, { signal: AbortSignal.timeout(15_000) });
    if (res.status >= 500) warnings.push(`Your app answered ${res.status} on "/". It is deployed, but check its logs.`);
  } catch (e) {
    warnings.push(`The router is deployed but did not answer yet (${(e as Error).message}). New workers.dev URLs can take a minute.`);
  }
  if (router.scheduleError) {
    warnings.push(`Automatic health checks are off: Cloudflare refused the schedule (${router.scheduleError}). Free accounts allow 5 scheduled Workers; the dashboard's "Check now" still works.`);
  }
  if (nodes.length === 1) warnings.push('Only one cloud is hosting your backend, so there is nothing to fail over to yet. Connect a second one.');
  const open = nodes.filter((n) => !n.locked);
  if (open.length) {
    warnings.push(
      input.lock === false
        ? `Lock is off, so ${open.map((n) => n.provider).join(' and ')} can be called directly, skipping your router. Turn on "Lock my servers" and deploy again.`
        : `Your app is a ${repo.runtime === 'docker' ? 'Docker' : 'Python'} app, so OmniMesh cannot lock it for you. Make it reject requests whose X-Gateway-Secret header is not your GATEWAY_SECRET (already set on every cloud); the dashboard's Checklist shows the code.`
    );
  }
  if (nodes.some((n) => n.provider === 'oracle')) {
    warnings.push('Oracle can stop Always Free servers that stay almost idle for 7 days (CPU, network and memory all under 20%). The watcher starts it again if that happens.');
  }
  if (input.keepAwake && nodes.some((n) => n.provider === 'render')) {
    warnings.push('Keep-awake keeps your Render server running all month: about 744 of the 750 free hours Render gives your workspace. If you run other free Render services, they share those hours.');
  }

  if (input.watcher && input.tokens.github) {
    const labels = Object.fromEntries(nodes.map((n) => [n.url, n.provider]));
    const secretValues: Record<string, string | undefined> = {
      OMNIMESH_STATUS_TOKEN: statusToken,
      KOYEB_API_TOKEN: input.tokens.koyeb,
      RENDER_API_KEY: input.tokens.render,
      OCI_TENANCY: input.oracle?.creds.tenancy,
      OCI_USER: input.oracle?.creds.user,
      OCI_FINGERPRINT: input.oracle?.creds.fingerprint,
      OCI_PRIVATE_KEY: input.oracle?.creds.privateKey,
    };
    try {
      await installWatcher(
        deps,
        {
          token: input.tokens.github,
          slug: repo.slug,
          branch: repo.defaultBranch,
          files: { [WORKFLOW_PATH]: watcherWorkflow(router.url, nodes, labels), [SCRIPT_PATH]: watcherScript() },
          secrets: Object.fromEntries(watcherSecretNames(nodes).flatMap((k) => (secretValues[k] ? [[k, secretValues[k]!]] : []))),
        },
        opts.apis?.github ?? GITHUB_API
      );
    } catch (e) {
      warnings.push(`The GitHub watcher was not added: ${(e as Error).message}. Your app is deployed; run omnimesh up again to retry.`);
    }
  }

  fs.mkdirSync(path.join(opts.cwd, '.omnimesh'), { recursive: true });
  const state: DeploymentState = {
    appName,
    repo,
    nodes,
    router: { url: router.url, accountId: router.accountId, kvNamespaceId: router.kvNamespaceId },
    ...(input.oracle && tunnelId ? { oracle: { hostname: input.oracle.hostname, tunnelId } } : {}),
    keepAwake: Boolean(input.keepAwake),
    watcher: Boolean(input.watcher),
    lock: input.lock !== false,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(opts.cwd, STATE_FILE), JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.writeFileSync(path.join(opts.cwd, 'omnimesh.config.yaml'), stringifyOmniMeshConfigYaml(config));
  writeDotEnv(opts.cwd, { GATEWAY_SECRET: gatewaySecret, OMNIMESH_STATUS_TOKEN: statusToken });

  deps.log(`✔ Done. Your app: ${router.url}`);
  return { appUrl: router.url, dashboardUrl: `${router.url}/_omnimesh/dashboard`, statusToken, nodes, failed, warnings };
}
