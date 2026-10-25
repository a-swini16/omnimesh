import { callApi, waitFor, type Deps } from './http.js';
import type { RepoInfo } from './detect.js';

export const KOYEB_API = 'https://app.koyeb.com';
const PORT = 8000;

export interface BackendDeployInput {
  token: string;
  repo: RepoInfo;
  name: string;
  env: Record<string, string>;
  /** Existing service id from a previous run: redeploy instead of creating */
  existing?: { serviceId: string; url: string };
}

export interface BackendDeployResult {
  provider: string;
  url: string;
  serviceId: string;
}

/** Deploys a public GitHub repo as a free Koyeb web service, or redeploys an existing one. */
export async function deployKoyeb(deps: Deps, input: BackendDeployInput, apiBase = KOYEB_API): Promise<BackendDeployResult> {
  const auth = { Authorization: `Bearer ${input.token}` };
  let serviceId: string;
  let url: string;

  if (input.existing) {
    deps.log('Koyeb: redeploying the latest commit');
    await callApi(deps, 'Koyeb', `${apiBase}/v1/services/${input.existing.serviceId}/redeploy`, { method: 'POST', headers: auth, json: {} });
    serviceId = input.existing.serviceId;
    url = input.existing.url;
  } else {
    deps.log('Koyeb: creating the app');
    const { app } = await callApi(deps, 'Koyeb', `${apiBase}/v1/apps`, { method: 'POST', headers: auth, json: { name: input.name } });
    const { repo } = input;
    const git: Record<string, unknown> = { repository: repo.slug, branch: repo.branch };
    if (repo.runtime === 'docker') git.docker = {};
    else git.buildpack = { build_command: repo.buildCommand, run_command: repo.startCommand };

    deps.log('Koyeb: creating the free web service from your repo');
    const { service } = await callApi(deps, 'Koyeb', `${apiBase}/v1/services`, {
      method: 'POST',
      headers: auth,
      json: {
        app_id: app.id,
        definition: {
          name: input.name,
          type: 'WEB',
          git,
          ports: [{ port: PORT, protocol: 'http' }],
          routes: [{ port: PORT, path: '/' }],
          env: Object.entries({ ...input.env, PORT: String(PORT) }).map(([key, value]) => ({ key, value })),
          instance_types: [{ type: 'free' }],
          regions: ['was'],
          scalings: [{ min: 1, max: 1 }],
        },
      },
    });
    serviceId = service.id;
    const domain = (app.domains || []).find((d: any) => d.type === 'AUTOASSIGNED') || (app.domains || [])[0];
    if (!domain?.name) throw new Error('Koyeb: the app has no public domain yet');
    url = `https://${domain.name}`;
  }

  deps.log('Koyeb: building and starting (this can take a few minutes)');
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
  deps.log(`Koyeb: live at ${url}`);
  return { provider: 'koyeb', url, serviceId };
}
