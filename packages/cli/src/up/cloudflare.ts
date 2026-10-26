import { SCHEDULE_CRON } from '@omnimesh/router';
import { callApi, type Deps } from './http.js';

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

/** The account to deploy into: the given one, or the first the token can see. */
export async function cloudflareAccountId(deps: Deps, token: string, accountId?: string, apiBase = CLOUDFLARE_API): Promise<string> {
  if (accountId) return accountId;
  const accounts = await callApi(deps, 'Cloudflare', `${apiBase}/accounts?per_page=5`, { headers: { Authorization: `Bearer ${token}` } }).then((b) => b.result);
  const id = accounts?.[0]?.id;
  if (!id) throw new Error('Cloudflare: this token cannot see any account');
  return id;
}

export interface RouterDeployInput {
  token: string;
  /** Optional; the first account the token can see is used otherwise */
  accountId?: string;
  scriptName: string;
  script: string;
  secrets: Record<string, string>;
  /** Plain (non-secret) text values, e.g. which repo is deployed */
  vars?: Record<string, string>;
}

export interface RouterDeployResult {
  url: string;
  accountId: string;
  kvNamespaceId: string;
  /** Why automatic health checks could not be turned on; undefined when they are on */
  scheduleError?: string;
}

const KV_TITLE = 'omnimesh-health';

/** Uploads the router as a Worker with its secrets and KV binding, and enables its workers.dev URL. */
export async function deployCloudflareRouter(deps: Deps, input: RouterDeployInput, apiBase = CLOUDFLARE_API): Promise<RouterDeployResult> {
  const auth = { Authorization: `Bearer ${input.token}` };
  const cf = (path: string, init: RequestInit & { json?: unknown } = {}) =>
    callApi(deps, 'Cloudflare', `${apiBase}${path}`, { ...init, headers: { ...auth, ...(init.headers as Record<string, string>) } }).then((b) => b.result);

  const accountId = await cloudflareAccountId(deps, input.token, input.accountId, apiBase);

  deps.log('Cloudflare: preparing the shared health store (KV)');
  const namespaces: Array<{ id: string; title: string }> = await cf(`/accounts/${accountId}/storage/kv/namespaces?per_page=100`);
  const kvNamespaceId: string =
    namespaces.find((n) => n.title === KV_TITLE)?.id ??
    (await cf(`/accounts/${accountId}/storage/kv/namespaces`, { method: 'POST', json: { title: KV_TITLE } })).id;

  deps.log('Cloudflare: uploading the router');
  const metadata = {
    main_module: 'worker.js',
    compatibility_date: '2025-01-01',
    bindings: [
      ...Object.entries(input.secrets).map(([name, text]) => ({ type: 'secret_text', name, text })),
      ...Object.entries(input.vars ?? {}).map(([name, text]) => ({ type: 'plain_text', name, text })),
      { type: 'kv_namespace', name: 'OMNIMESH_KV', namespace_id: kvNamespaceId },
    ],
  };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('worker.js', new Blob([input.script], { type: 'application/javascript+module' }), 'worker.js');
  await cf(`/accounts/${accountId}/workers/scripts/${input.scriptName}`, { method: 'PUT', body: form });

  await cf(`/accounts/${accountId}/workers/scripts/${input.scriptName}/subdomain`, { method: 'POST', json: { enabled: true } });
  const sub = await cf(`/accounts/${accountId}/workers/subdomain`).catch(() => null);
  if (!sub?.subdomain) {
    throw new Error('Cloudflare: your account has no workers.dev subdomain yet. Open dash.cloudflare.com → Workers & Pages once to pick one, then run omnimesh up again.');
  }
  const url = `https://${input.scriptName}.${sub.subdomain}.workers.dev`;
  deps.log(`Cloudflare: router live at ${url}`);

  // Automatic health checks every 5 minutes (a Cron Trigger; free accounts get 5 in total)
  let scheduleError: string | undefined;
  try {
    await cf(`/accounts/${accountId}/workers/scripts/${input.scriptName}/schedules`, { method: 'PUT', json: [{ cron: SCHEDULE_CRON }] });
    deps.log('Cloudflare: automatic health checks every 5 minutes');
  } catch (e) {
    scheduleError = (e as Error).message;
  }
  return { url, accountId, kvNamespaceId, ...(scheduleError ? { scheduleError } : {}) };
}
