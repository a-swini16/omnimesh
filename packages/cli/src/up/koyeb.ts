import { callApi, waitFor, type Deps } from './http.js';
import type { RepoInfo } from './detect.js';
import { canGate, gateEnv, gateStartCommand } from './gate.js';

export const KOYEB_API = 'https://app.koyeb.com';
const PORT = 8000;

export interface BackendDeployInput {
  token: string;
  repo: RepoInfo;
  name: string;
  env: Record<string, string>;
  /** Existing service id from a previous run: redeploy instead of creating */
  existing?: { serviceId: string; url: string };
  /** Put the OmniMesh gate in front of the app so only the router can reach it (Node.js apps) */
  lock?: boolean;
  /** Settings removed since the last deploy, to delete from an existing service */
  removeEnv?: string[];
  /** Which service and copy this is, for the log ("auth", "copy 2") */
  tag?: string;
}

/** "Koyeb" or "Render · auth" in the deploy log */
export const who = (cloud: string, tag?: string) => (tag ? `${cloud} · ${tag}` : cloud);

export interface BackendDeployResult {
  provider: string;
  url: string;
  serviceId: string;
  /** Oracle: the home region the server runs in */
  region?: string;
  /** Deployed but not answering yet (still building) */
  pending?: boolean;
  /** The OmniMesh gate guards this server: only the router gets in */
  locked?: boolean;
}

/** Start command and extra environment for a deploy, with or without the gate. */
export function runSettings(input: { repo: RepoInfo; lock?: boolean }): { startCommand?: string; env: Record<string, string>; locked: boolean } {
  const locked = Boolean(input.lock && canGate(input.repo));
  return {
    startCommand: locked ? gateStartCommand(input.repo.startCommand ?? 'npm start') : input.repo.startCommand,
    env: locked ? gateEnv() : {},
    locked,
  };
}

/** Deploys a public GitHub repo as a free Koyeb web service, or redeploys an existing one. */
export async function deployKoyeb(deps: Deps, input: BackendDeployInput, apiBase = KOYEB_API): Promise<BackendDeployResult> {
  const auth = { Authorization: `Bearer ${input.token}` };
  let serviceId: string;
  let url: string;
  const { repo } = input;
  const run = runSettings(input);
  const git: Record<string, unknown> = { repository: repo.slug, branch: repo.branch, ...(repo.folder ? { workdir: repo.folder } : {}) };
  if (repo.runtime === 'docker') git.docker = {};
  else git.buildpack = { build_command: repo.buildCommand, run_command: run.startCommand };
  const definition = {
    name: input.name,
    type: 'WEB',
    git,
    ports: [{ port: PORT, protocol: 'http' }],
    routes: [{ port: PORT, path: '/' }],
    env: Object.entries({ ...input.env, ...run.env, PORT: String(PORT) }).map(([key, value]) => ({ key, value })),
    instance_types: [{ type: 'free' }],
    regions: ['was'],
    scalings: [{ min: 1, max: 1 }],
  };

  if (input.existing) {
    // Sending the full definition applies setting changes (like the lock) and deploys the latest commit
    deps.log(`${who('Koyeb', input.tag)}: updating the service and deploying the latest commit`);
    await callApi(deps, 'Koyeb', `${apiBase}/v1/services/${input.existing.serviceId}`, { method: 'PUT', headers: auth, json: { definition } });
    serviceId = input.existing.serviceId;
    url = input.existing.url;
  } else {
    deps.log(`${who('Koyeb', input.tag)}: creating the app`);
    const { app } = await callApi(deps, 'Koyeb', `${apiBase}/v1/apps`, { method: 'POST', headers: auth, json: { name: input.name } });
    deps.log(`${who('Koyeb', input.tag)}: creating the free web service from your repo`);
    const { service } = await callApi(deps, 'Koyeb', `${apiBase}/v1/services`, {
      method: 'POST',
      headers: auth,
      json: { app_id: app.id, definition },
    });
    serviceId = service.id;
    const domain = (app.domains || []).find((d: any) => d.type === 'AUTOASSIGNED') || (app.domains || [])[0];
    if (!domain?.name) throw new Error('Koyeb: the app has no public domain yet');
    url = `https://${domain.name}`;
  }

  deps.log(`${who('Koyeb', input.tag)}: building and starting (this can take a few minutes)`);
  const status = await waitFor(
    deps,
    async () => {
      const { service } = await callApi(deps, 'Koyeb', `${apiBase}/v1/services/${serviceId}`, { headers: auth });
      if (service.status === 'HEALTHY') return 'HEALTHY';
      if (service.status === 'UNHEALTHY' || service.status === 'DEGRADED') {
        throw new Error(`Koyeb: the service is ${service.status.toLowerCase()}. Open the Koyeb dashboard logs to see why the app did not start.`);
      }
      return null;
    },
    15 * 60_000
  );
  if (!status) throw new Error('Koyeb: still not healthy after 15 minutes');
  deps.log(`${who('Koyeb', input.tag)}: live at ${url}${run.locked ? ' (locked: only your router gets in)' : ''}`);
  return { provider: 'koyeb', url, serviceId, ...(run.locked ? { locked: true } : {}) };
}
