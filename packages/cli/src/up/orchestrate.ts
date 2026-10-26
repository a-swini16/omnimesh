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
import { deployOracle, oracleHostname, oraclePort } from './oracle.js';
import { ensureTunnel } from './tunnel.js';
import { installWatcher, watcherScript, watcherWorkflow, watcherSecretNames, GITHUB_API, SCRIPT_PATH, WORKFLOW_PATH } from './watcher.js';
import { checkAppSettings, loadAppSettings, saveAppSettings } from './settings.js';
import type { OciCredentials } from './oci.js';
import { bundleRouter } from './bundle.js';

/** One part of your app: the main app on "/", or a service such as /auth, each from its own repo or folder. */
export interface ServiceInput {
  route: string;
  repoUrl: string;
  branch?: string;
  /** Folder inside the repo (monorepos) */
  folder?: string;
  startCommand?: string;
  /** The app's own settings (environment variables), e.g. OPENAI_API_KEY */
  settings?: Record<string, string>;
}

export interface UpInput {
  /** The main app (when `services` is not given) */
  repoUrl?: string;
  branch?: string;
  startCommand?: string;
  /** The main app first ("/"), then any other services */
  services?: ServiceInput[];
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
  /** Spread the work across all servers (default) instead of one main server with backups */
  spread?: boolean;
  /** How many servers each service gets on Render (1 to 3) */
  renderCopies?: number;
}

export interface ServiceState {
  /** "main" for "/", else the route's name, e.g. "auth" */
  id: string;
  route: string;
  repo: RepoInfo;
  nodes: BackendDeployResult[];
  /** Names of the app settings set last time, so removed ones can be deleted */
  settingsKeys: string[];
}

export interface DeploymentState {
  appName: string;
  /** The main app's repo */
  repo: RepoInfo;
  /** Every server of every service */
  nodes: BackendDeployResult[];
  services?: ServiceState[];
  router: { url: string; accountId: string; kvNamespaceId: string };
  oracle?: { hostname: string; tunnelId: string };
  keepAwake?: boolean;
  watcher?: boolean;
  lock?: boolean;
  spread?: boolean;
  renderCopies?: number;
  updatedAt: string;
}

export interface UpResult {
  appUrl: string;
  dashboardUrl: string;
  statusToken: string;
  nodes: BackendDeployResult[];
  services: Array<{ route: string; nodes: BackendDeployResult[] }>;
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

/** What to deploy again: the saved services with their saved settings ("Redeploy latest code", omnimesh deploy). */
export function servicesFromState(cwd: string, state: DeploymentState): ServiceInput[] {
  const settings = loadAppSettings(cwd);
  return stateServices(state).map((s) => ({
    route: s.route,
    repoUrl: s.repo.url,
    branch: s.repo.branch,
    folder: s.repo.folder,
    startCommand: s.repo.runtime === 'python' ? s.repo.startCommand : undefined,
    settings: settings[s.route] ?? {},
  }));
}

/** Services of a saved deployment (deployments from before services existed have one, on "/"). */
export function stateServices(state: DeploymentState): ServiceState[] {
  return state.services ?? [{ id: 'main', route: '/', repo: state.repo, nodes: state.nodes, settingsKeys: [] }];
}

const ROUTE = /^\/([a-z0-9][a-z0-9-]*)(\/[a-z0-9][a-z0-9-]*)*$/;
export const MAX_SERVICES = 6;
export const MAX_RENDER_COPIES = 3;
/** "/" is "main"; "/auth" is "auth"; "/api/v2" is "api-v2" */
export const serviceId = (route: string) => (route === '/' ? 'main' : route.slice(1).replace(/\//g, '-'));

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

/** Work share per server when spreading: the Oracle server has many times the CPU of a free Koyeb or Render one */
const WEIGHT: Record<string, number> = { oracle: 4 };

/**
 * Router config: every service is a route with its own servers. Spread: requests are shared by weight.
 * Otherwise the order decides: Oracle (always on, the most capacity) first, then Koyeb, then Render;
 * servers still building go last. Free servers that sleep are kept awake only where the free hours allow it.
 */
export function meshConfig(
  domain: string,
  services: Array<{ route: string; nodes: BackendDeployResult[] }>,
  options: { keepAwake?: boolean; spread?: boolean } = {}
): OmniMeshConfig {
  const rank = (n: BackendDeployResult) => (n.pending ? 3 : n.provider === 'oracle' ? 0 : n.provider === 'koyeb' ? 1 : 2);
  // Render gives a workspace 750 free hours a month: enough to keep one server awake all month, not two
  let renderAwake = false;
  const keepAwakeFor = (n: BackendDeployResult) => {
    if (!options.keepAwake || n.provider !== 'render') return undefined;
    if (renderAwake) return false;
    renderAwake = true;
    return true;
  };
  const pools: Record<string, unknown[]> = {};
  for (const svc of services) {
    pools[svc.route] = [...svc.nodes]
      .sort((a, b) => rank(a) - rank(b))
      .map((n) => {
        const keepAwake = keepAwakeFor(n);
        return {
          url: n.url,
          providerId: n.provider,
          ...quotaFor(n.provider),
          ...(options.spread ? { weight: WEIGHT[n.provider] ?? 1 } : {}),
          // A service's own route is what reaches it (the main app answers anything)
          ...(svc.route === '/' ? {} : { healthPath: svc.route }),
          ...(keepAwake === undefined ? {} : { keepAwake }),
        };
      });
  }
  const all = services.flatMap((s) => s.nodes);
  return validateOmniMeshConfig({
    profile: all.some((n) => getProvider(n.provider)?.requiresCard) ? 'with-card' : 'no-card',
    domain,
    defaultPool: '/',
    router: { strategy: options.spread ? 'weighted' : 'priority' },
    pools,
    keepAlive: { enabled: Boolean(options.keepAwake) },
  });
}

/**
 * The whole "give us your backend" flow: detect every service's code, deploy each on every connected cloud,
 * put the router in front on Cloudflare with one route per service, verify it end to end, and save what is
 * needed to redeploy.
 */
export async function runUp(deps: Deps, input: UpInput, opts: UpOptions): Promise<UpResult> {
  if (!input.tokens.cloudflare) throw new Error('Connect Cloudflare: it runs the router that gives your app one URL.');
  const clouds = (['koyeb', 'render', 'oracle'] as const).filter((p) => (p === 'oracle' ? input.oracle : input.tokens[p]));
  if (!clouds.length) throw new Error('Connect at least one cloud to host your backend (two or more for failover).');

  const savedSettings = loadAppSettings(opts.cwd);
  const wanted: ServiceInput[] = input.services?.length
    ? input.services
    : [{ route: '/', repoUrl: input.repoUrl ?? '', branch: input.branch, startCommand: input.startCommand, settings: savedSettings['/'] }];
  if (wanted[0].route !== '/') throw new Error('The first service is your main app and serves "/".');
  if (wanted.length > MAX_SERVICES) throw new Error(`At most ${MAX_SERVICES} services.`);
  const routes = new Set<string>();
  for (const w of wanted) {
    if (w.route !== '/' && (!ROUTE.test(w.route) || w.route.startsWith('/_omnimesh'))) {
      throw new Error(`"${w.route}" is not a route OmniMesh can use. Use lowercase words like /auth or /api/v2.`);
    }
    if (routes.has(w.route)) throw new Error(`Two services use ${w.route}. Each needs its own route.`);
    routes.add(w.route);
  }
  const copies = Math.min(MAX_RENDER_COPIES, Math.max(1, Math.floor(input.renderCopies ?? 1)));

  deps.log('Reading your GitHub repositories');
  const services: Array<{ id: string; route: string; repo: RepoInfo; settings: Record<string, string> }> = [];
  for (const w of wanted) {
    const repo = await detectRepo(deps, w.repoUrl, { branch: w.branch, startCommand: w.startCommand, folder: w.folder });
    const kind = repo.runtime === 'docker' ? 'Docker' : repo.runtime === 'node' ? 'Node.js' : 'Python';
    deps.log(`${w.route}: a ${kind} app (${repo.slug.replace(/^github\.com\//, '')}${repo.folder ? `/${repo.folder}` : ''}, branch ${repo.branch})`);
    services.push({ id: serviceId(w.route), route: w.route, repo, settings: checkAppSettings(w.settings ?? {}, `Settings for ${w.route}`) });
  }
  const main = services[0];

  const previous = loadState(opts.cwd);
  const sameApp = previous && previous.repo.slug === main.repo.slug;
  const before = new Map((sameApp ? stateServices(previous!) : []).map((x) => [x.route, x]));
  // An installed watcher keeps working without a token; one is needed only to add or update it
  const watcherInstalled = Boolean(sameApp && previous!.watcher);
  if (input.watcher && !input.tokens.github && !watcherInstalled) throw new Error('Paste a GitHub token to add the watcher, or turn the watcher off.');
  const env = readDotEnv(opts.cwd);
  const gatewaySecret = env.GATEWAY_SECRET && env.GATEWAY_SECRET.length >= 32 ? env.GATEWAY_SECRET : crypto.randomBytes(32).toString('hex');
  const statusToken = env.OMNIMESH_STATUS_TOKEN && env.OMNIMESH_STATUS_TOKEN.length >= 32 ? env.OMNIMESH_STATUS_TOKEN : crypto.randomBytes(24).toString('hex');
  const appName = sameApp ? previous!.appName : appNameFor(main.repo);
  const lock = input.lock !== false;

  const cfApi = opts.apis?.cloudflare ?? CLOUDFLARE_API;
  const accountId = await cloudflareAccountId(deps, input.tokens.cloudflare, input.cloudflareAccountId, cfApi);
  let tunnelId: string | undefined;

  // One job per server: Koyeb (main app only: one free instance per account), Render (every service,
  // `copies` each), and one Oracle server that runs every service
  type Job = { cloud: string; route?: string; run: () => Promise<Array<BackendDeployResult & { route: string }>> };
  const jobs: Job[] = [];
  const serverEnv = (svc: (typeof services)[number], provider: string) => ({ ...svc.settings, GATEWAY_SECRET: gatewaySecret, OMNIMESH_PROVIDER: provider });
  const removed = (svc: (typeof services)[number]) => (before.get(svc.route)?.settingsKeys ?? []).filter((k) => !(k in svc.settings));
  for (const svc of services) {
    const old = before.get(svc.route)?.nodes ?? [];
    const name = svc.id === 'main' ? appName : `${appName}-${svc.id}`.slice(0, 40);
    const tag = (copy = 1) => [svc.id === 'main' ? '' : svc.route, copy > 1 ? `copy ${copy}` : ''].filter(Boolean).join(', ') || undefined;
    if (input.tokens.koyeb && svc.id === 'main') {
      const job = { token: input.tokens.koyeb, repo: svc.repo, name, env: serverEnv(svc, 'koyeb'), existing: old.find((n) => n.provider === 'koyeb'), lock, tag: tag() };
      jobs.push({ cloud: 'koyeb', route: svc.route, run: async () => [{ ...(await deployKoyeb(deps, job, opts.apis?.koyeb ?? KOYEB_API)), route: svc.route }] });
    }
    if (input.tokens.render) {
      const oldRender = old.filter((n) => n.provider === 'render');
      for (let c = 1; c <= copies; c++) {
        const job = {
          token: input.tokens.render,
          repo: svc.repo,
          name: c === 1 ? name : `${name}-${c}`,
          env: serverEnv(svc, 'render'),
          existing: oldRender[c - 1],
          lock,
          removeEnv: removed(svc),
          tag: tag(c),
        };
        jobs.push({ cloud: 'render', route: svc.route, run: async () => [{ ...(await deployRender(deps, job, opts.apis?.render ?? RENDER_API)), route: svc.route }] });
      }
    }
  }
  if (input.oracle) {
    const { hostname, creds } = input.oracle;
    const oracleServices = services.map((svc, i) => ({
      id: svc.id,
      route: svc.route,
      repo: svc.repo,
      env: serverEnv(svc, 'oracle'),
      hostname: oracleHostname(hostname, svc.id),
      port: oraclePort(i),
    }));
    const existing = services.map((svc) => before.get(svc.route)?.nodes.find((n) => n.provider === 'oracle')).find(Boolean);
    jobs.push({
      cloud: 'oracle',
      run: async () => {
        const tunnel = await ensureTunnel(
          deps,
          { token: input.tokens.cloudflare, accountId, name: `omnimesh-${appName}`, routes: oracleServices.map((o) => ({ hostname: o.hostname, service: `http://localhost:${o.port}` })) },
          cfApi
        );
        tunnelId = tunnel.tunnelId;
        return deployOracle(deps, { creds, name: appName, services: oracleServices, tunnelToken: tunnel.tunnelToken, existing, lock }, opts.apis?.oracle);
      },
    });
  }

  const results = await Promise.allSettled(jobs.map((j) => j.run()));
  const placed = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const failed = results.flatMap((r, i) =>
    r.status === 'rejected' ? [{ provider: jobs[i].cloud, error: `${jobs[i].route && jobs[i].route !== '/' ? `${jobs[i].route}: ` : ''}${(r.reason as Error).message}` }] : []
  );
  for (const f of failed) deps.log(`✖ ${f.error}`);
  const byRoute = services.map((svc) => ({ route: svc.route, nodes: placed.filter((n) => n.route === svc.route).map(({ route: _r, ...n }) => n as BackendDeployResult) }));
  const nodes = byRoute.flatMap((x) => x.nodes);
  if (!byRoute[0].nodes.length) throw new Error('No cloud could host your main app. Fix the errors above and run it again.');
  const served = byRoute.filter((x) => x.nodes.length);

  deps.log('Building the router');
  const script = await (opts.bundle ?? bundleRouter)();
  const scriptName = appName;
  const meshOptions = { keepAwake: input.keepAwake, spread: input.spread !== false };
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
        OMNIMESH_CONFIG_YAML: stringifyOmniMeshConfigYaml(meshConfig(`${scriptName}.workers.dev`, served, meshOptions)),
      },
      vars: {
        OMNIMESH_APP: JSON.stringify({
          repo: main.repo.slug,
          repoUrl: `https://github.com/${main.repo.slug}`,
          branch: main.repo.branch,
          runtime: main.repo.runtime,
          deployedAt: new Date().toISOString(),
          watcher: Boolean(input.watcher),
          services: services.map((svc) => ({
            route: svc.route,
            repo: svc.repo.slug,
            repoUrl: svc.repo.url,
            branch: svc.repo.branch,
            folder: svc.repo.folder ?? '',
          })),
        }),
      },
    },
    cfApi
  );
  const config = meshConfig(new URL(router.url).host, served, meshOptions);

  deps.log('Checking your app through the router');
  const warnings: string[] = [];
  try {
    const status = await callApi(deps, 'Router', `${router.url}/_omnimesh/status`, { headers: { Authorization: `Bearer ${statusToken}` } });
    deps.log(`Router sees ${(status.pools ?? []).reduce((n: number, p: { nodes?: unknown[] }) => n + (p.nodes?.length ?? 0), 0)} servers on ${status.pools?.length ?? 0} route(s)`);
    const res = await deps.fetch(`${router.url}/`, { signal: AbortSignal.timeout(15_000) });
    if (res.status >= 500) warnings.push(`Your app answered ${res.status} on "/". It is deployed, but check its logs.`);
  } catch (e) {
    warnings.push(`The router is deployed but did not answer yet (${(e as Error).message}). New workers.dev URLs can take a minute.`);
  }
  if (router.scheduleError) {
    warnings.push(`Automatic health checks are off: Cloudflare refused the schedule (${router.scheduleError}). Free accounts allow 5 scheduled Workers; the dashboard's "Check now" still works.`);
  }
  for (const x of byRoute) {
    if (!x.nodes.length) warnings.push(`${x.route} has no server: every cloud failed for it (see above). Requests to ${x.route} get an error until you fix it and deploy again.`);
    else if (x.nodes.length === 1) warnings.push(`${x.route === '/' ? 'Your app' : x.route} runs on one server only, so there is nothing to fail over to. Connect another cloud${input.tokens.render ? ' or add a Render copy' : ''}.`);
  }
  if (input.tokens.koyeb && services.length > 1) {
    warnings.push(`Koyeb gives each account one free server, so only your main app runs there; ${services.slice(1).map((x) => x.route).join(', ')} run on your other clouds.`);
  }
  const open = nodes.filter((n) => !n.locked);
  if (open.length) {
    const unlockable = services.filter((x) => x.repo.runtime !== 'node').map((x) => x.route);
    warnings.push(
      !lock
        ? `Lock is off, so ${[...new Set(open.map((n) => n.provider))].join(' and ')} can be called directly, skipping your router. Turn on "Lock my servers" and deploy again.`
        : `OmniMesh can lock only Node.js apps by itself; ${unlockable.join(', ')} ${unlockable.length === 1 ? 'is a Python or Docker app' : 'are Python or Docker apps'}. Make ${unlockable.length === 1 ? 'it' : 'them'} reject requests whose X-Gateway-Secret header is not your GATEWAY_SECRET (already set on every cloud); the dashboard's Checklist shows how.`
    );
  }
  if (nodes.some((n) => n.provider === 'oracle')) {
    warnings.push('Oracle can stop Always Free servers that stay almost idle for 7 days (CPU, network and memory all under 20%). The watcher starts it again if that happens.');
  }
  const renderCount = nodes.filter((n) => n.provider === 'render').length;
  if (input.keepAwake && renderCount) {
    warnings.push(
      renderCount === 1
        ? 'Keep-awake keeps your Render server running all month: about 744 of the 750 free hours Render gives your workspace. If you run other free Render services, they share those hours.'
        : `Render gives your workspace 750 free hours a month, enough to keep one server awake. So only your main app's first Render server is kept awake; your other ${renderCount - 1} Render server(s) sleep when idle and wake on the next visit (about a minute).`
    );
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
          slug: main.repo.slug,
          branch: main.repo.defaultBranch,
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
    repo: main.repo,
    nodes,
    services: services.map((svc, i) => ({ id: svc.id, route: svc.route, repo: svc.repo, nodes: byRoute[i].nodes, settingsKeys: Object.keys(svc.settings) })),
    router: { url: router.url, accountId: router.accountId, kvNamespaceId: router.kvNamespaceId },
    ...(input.oracle && tunnelId ? { oracle: { hostname: input.oracle.hostname, tunnelId } } : {}),
    keepAwake: Boolean(input.keepAwake),
    watcher: Boolean(input.watcher) || watcherInstalled,
    lock,
    spread: meshOptions.spread,
    renderCopies: copies,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(opts.cwd, STATE_FILE), JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.writeFileSync(path.join(opts.cwd, 'omnimesh.config.yaml'), stringifyOmniMeshConfigYaml(config));
  writeDotEnv(opts.cwd, { GATEWAY_SECRET: gatewaySecret, OMNIMESH_STATUS_TOKEN: statusToken });
  saveAppSettings(opts.cwd, Object.fromEntries(services.map((svc) => [svc.route, svc.settings])));

  deps.log(`✔ Done. Your app: ${router.url}`);
  return { appUrl: router.url, dashboardUrl: `${router.url}/_omnimesh/dashboard`, statusToken, nodes, services: byRoute, failed, warnings };
}
