import { callApi, waitFor, type Deps } from './http.js';
import type { BackendDeployInput, BackendDeployResult } from './koyeb.js';

export const RENDER_API = 'https://api.render.com';
const FAILED = new Set(['build_failed', 'update_failed', 'pre_deploy_failed', 'canceled', 'deactivated']);

/** Deploys a public GitHub repo as a free Render web service, or redeploys an existing one. */
export async function deployRender(deps: Deps, input: BackendDeployInput, apiBase = RENDER_API): Promise<BackendDeployResult> {
  const auth = { Authorization: `Bearer ${input.token}` };
  let serviceId: string;
  let url: string;
  let deployId: string;

  if (input.existing) {
    deps.log('Render: redeploying the latest commit');
    const deploy = await callApi(deps, 'Render', `${apiBase}/v1/services/${input.existing.serviceId}/deploys`, { method: 'POST', headers: auth, json: {} });
    serviceId = input.existing.serviceId;
    url = input.existing.url;
    deployId = deploy.id;
  } else {
    const owners: Array<{ owner: { id: string } }> = await callApi(deps, 'Render', `${apiBase}/v1/owners?limit=20`, { headers: auth });
    const ownerId = owners[0]?.owner?.id;
    if (!ownerId) throw new Error('Render: no workspace found for this API key');

    const { repo } = input;
    const serviceDetails: Record<string, unknown> =
      repo.runtime === 'docker'
        ? { runtime: 'docker', plan: 'free', region: 'oregon', numInstances: 1 }
        : {
            runtime: repo.runtime,
            plan: 'free',
            region: 'oregon',
            numInstances: 1,
            envSpecificDetails: { buildCommand: repo.buildCommand, startCommand: repo.startCommand },
          };

    deps.log('Render: creating the free web service from your repo');
    const created = await callApi(deps, 'Render', `${apiBase}/v1/services`, {
      method: 'POST',
      headers: auth,
      json: {
        type: 'web_service',
        name: input.name,
        ownerId,
        repo: repo.url,
        branch: repo.branch,
        autoDeployTrigger: 'commit',
        envVars: Object.entries(input.env).map(([key, value]) => ({ key, value })),
        serviceDetails,
      },
    });
    serviceId = created.service.id;
    url = created.service.serviceDetails?.url;
    deployId = created.deployId;
    if (!url) throw new Error('Render: the service has no public URL');
  }

  deps.log('Render: building and starting (free builds can take several minutes)');
  const live = await waitFor(
    deps,
    async () => {
      const deploy = await callApi(deps, 'Render', `${apiBase}/v1/services/${serviceId}/deploys/${deployId}`, { headers: auth });
      if (deploy.status === 'live') return true;
      if (FAILED.has(deploy.status)) throw new Error(`Render: deploy ${deploy.status.replace(/_/g, ' ')}. Open the Render dashboard logs to see why.`);
      return null;
    },
    20 * 60_000
  );
  if (!live) throw new Error('Render: still not live after 20 minutes');
  deps.log(`Render: live at ${url}`);
  return { provider: 'render', url, serviceId };
}
