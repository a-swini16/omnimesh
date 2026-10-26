import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sodium from 'libsodium-wrappers';
import { callApi, CloudApiError, type Deps } from './http.js';
import type { BackendDeployResult } from './koyeb.js';

export const GITHUB_API = 'https://api.github.com';
export const WORKFLOW_PATH = '.github/workflows/omnimesh-watch.yml';
export const SCRIPT_PATH = '.github/omnimesh/watch.mjs';
const SCRIPT_SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'watcher', 'watch.mjs');

/** Single-quoted YAML scalar: the only escape is a doubled quote. */
const yamlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Repository secrets each cloud needs for the watcher to restart its servers. */
export function watcherSecretNames(nodes: BackendDeployResult[]): string[] {
  const names = new Set(['OMNIMESH_STATUS_TOKEN']);
  for (const n of nodes) {
    if (n.provider === 'koyeb') names.add('KOYEB_API_TOKEN');
    if (n.provider === 'render') names.add('RENDER_API_KEY');
    if (n.provider === 'oracle') for (const k of ['OCI_TENANCY', 'OCI_USER', 'OCI_FINGERPRINT', 'OCI_PRIVATE_KEY']) names.add(k);
  }
  return [...names];
}

/** The workflow file: every 10 minutes (GitHub's minimum is 5 and runs can be delayed), plus a manual button. */
export function watcherWorkflow(routerUrl: string, nodes: BackendDeployResult[], labels: Record<string, string>): string {
  const servers = nodes.map((n) => ({ label: labels[n.url] ?? n.provider, provider: n.provider, url: n.url, serviceId: n.serviceId, ...(n.region ? { region: n.region } : {}) }));
  const secretEnv = watcherSecretNames(nodes).map((name) => `          ${name}: \${{ secrets.${name} }}`);
  return [
    '# Written by omnimesh up. Every 10 minutes it checks your servers through your router and restarts',
    '# any that stay down, using each cloud\'s API. Safe to edit or delete.',
    'name: OmniMesh watcher',
    'on:',
    '  schedule:',
    "    - cron: '*/10 * * * *'",
    '  workflow_dispatch:',
    'permissions:',
    '  contents: read',
    'concurrency:',
    '  group: omnimesh-watcher',
    '  cancel-in-progress: false',
    'jobs:',
    '  watch:',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 10',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '        with:',
    '          sparse-checkout: .github/omnimesh',
    '          sparse-checkout-cone-mode: false',
    '      - uses: actions/setup-node@v4',
    '        with:',
    '          node-version: 22',
    `      - run: node ${SCRIPT_PATH}`,
    '        env:',
    `          OMNIMESH_ROUTER_URL: ${yamlString(routerUrl)}`,
    `          OMNIMESH_SERVERS: ${yamlString(JSON.stringify(servers))}`,
    ...secretEnv,
    '',
  ].join('\n');
}

export function watcherScript(): string {
  return fs.readFileSync(SCRIPT_SOURCE, 'utf-8');
}

export interface WatcherInstall {
  token: string;
  /** github.com/owner/name */
  slug: string;
  /** Scheduled workflows only run on the default branch */
  branch: string;
  files: Record<string, string>;
  secrets: Record<string, string>;
}

/**
 * Commit the watcher to the repo and store its secrets, encrypted with the repo's public key (libsodium
 * sealed box, as GitHub requires). Needs a fine-grained token with Contents, Workflows and Secrets: write.
 */
export async function installWatcher(deps: Deps, input: WatcherInstall, apiBase = GITHUB_API): Promise<void> {
  const repo = input.slug.replace(/^github\.com\//, '');
  const headers = {
    Authorization: `Bearer ${input.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'omnimesh-cli',
  };
  const gh = (p: string, init: RequestInit & { json?: unknown } = {}) =>
    callApi(deps, 'GitHub', `${apiBase}/repos/${repo}${p}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });

  // Secrets first, so the first scheduled run already has them
  const { key, key_id } = await gh('/actions/secrets/public-key');
  await sodium.ready;
  const publicKey = sodium.from_base64(key, sodium.base64_variants.ORIGINAL);
  for (const [name, value] of Object.entries(input.secrets)) {
    const sealed = sodium.crypto_box_seal(sodium.from_string(value), publicKey);
    await gh(`/actions/secrets/${name}`, { method: 'PUT', json: { encrypted_value: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL), key_id } });
  }

  for (const [file, content] of Object.entries(input.files)) {
    const encoded = Buffer.from(content).toString('base64');
    let sha: string | undefined;
    try {
      const current = await gh(`/contents/${file}?ref=${encodeURIComponent(input.branch)}`);
      if (Buffer.from(current.content ?? '', 'base64').toString('utf-8') === content) continue;
      sha = current.sha;
    } catch (e) {
      if (!(e instanceof CloudApiError && e.status === 404)) throw e;
    }
    await gh(`/contents/${file}`, {
      method: 'PUT',
      // [skip render]: Render's documented phrase, so this commit does not rebuild the app there
      json: { message: `${sha ? 'Update' : 'Add'} OmniMesh watcher (${path.basename(file)}) [skip render]`, content: encoded, branch: input.branch, ...(sha ? { sha } : {}) },
    });
  }
  if (Object.keys(input.files).length) deps.log(`GitHub: watcher added to ${repo}; it runs every 10 minutes (see the Actions tab)`);
}
