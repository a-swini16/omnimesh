import crypto from 'node:crypto';
import pc from 'picocolors';
import { openBrowser } from '../browser.js';
import { loadState, readDotEnv, writeDotEnv } from '../up/orchestrate.js';
import { callApi, realDeps, type Deps } from '../up/http.js';
import { CLOUDFLARE_API } from '../up/cloudflare.js';
import { installWatcher } from '../up/watcher.js';

function deployed(cwd: string) {
  const state = loadState(cwd);
  if (!state) {
    console.log(pc.red('✖ No deployment found in this folder. Run omnimesh up here first (or cd into your project folder).'));
    return null;
  }
  return state;
}

/** `omnimesh open`: open the dashboard already signed in (the key travels in the #fragment, never to the server). */
export async function runOpen(options: { cwd?: string; open?: boolean } = {}): Promise<boolean> {
  const cwd = options.cwd || process.cwd();
  const state = deployed(cwd);
  if (!state) return false;
  const token = readDotEnv(cwd).OMNIMESH_STATUS_TOKEN;
  if (!token) {
    console.log(pc.red('✖ OMNIMESH_STATUS_TOKEN is missing from .env. Run omnimesh token --rotate to create a new sign-in key.'));
    return false;
  }
  const dashboard = `${state.router.url}/_omnimesh/dashboard`;
  const opened = options.open !== false && openBrowser(`${dashboard}#token=${token}`);
  console.log(opened ? pc.green(`✔ Opening your dashboard: ${dashboard}`) : `Your dashboard: ${pc.bold(dashboard)}\nSign in with the key from ${pc.bold('omnimesh token')}.`);
  return true;
}

/** `omnimesh token [--rotate]`: print the dashboard sign-in key, or replace it on the live router. */
export async function runToken(options: { cwd?: string; rotate?: boolean; deps?: Deps; apiBase?: string; githubApi?: string } = {}): Promise<boolean> {
  const cwd = options.cwd || process.cwd();
  const env = readDotEnv(cwd);
  if (!options.rotate) {
    if (!env.OMNIMESH_STATUS_TOKEN) {
      console.log(pc.red('✖ No sign-in key in .env. Run omnimesh token --rotate to create one.'));
      return false;
    }
    console.log(env.OMNIMESH_STATUS_TOKEN);
    return true;
  }

  const state = deployed(cwd);
  if (!state) return false;
  if (!env.CLOUDFLARE_API_TOKEN) {
    console.log(pc.red('✖ CLOUDFLARE_API_TOKEN is not saved in .env, so the router cannot be updated. Run omnimesh up and tick "Remember these tokens".'));
    return false;
  }
  const deps = options.deps ?? realDeps(() => {});
  const fresh = crypto.randomBytes(24).toString('hex');
  // Worker secret update: PUT /accounts/{account_id}/workers/scripts/{script_name}/secrets  {name, text, type: "secret_text"}
  // (verified against github.com/cloudflare/api-schemas openapi.json, 2026-10-26)
  await callApi(deps, 'Cloudflare', `${options.apiBase ?? CLOUDFLARE_API}/accounts/${state.router.accountId}/workers/scripts/${state.appName}/secrets`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
    json: { name: 'OMNIMESH_STATUS_TOKEN', text: fresh, type: 'secret_text' },
  });
  writeDotEnv(cwd, { OMNIMESH_STATUS_TOKEN: fresh });
  console.log(pc.green('✔ New sign-in key is live on your router; the old one no longer works. Run omnimesh open to sign in.'));
  // The GitHub watcher signs in with its own copy of the key
  if (state.watcher) {
    if (!env.OMNIMESH_GITHUB_TOKEN) {
      console.log(pc.yellow('! Your GitHub watcher still has the old key. Run omnimesh up and deploy once with your GitHub token to update it.'));
      return true;
    }
    try {
      await installWatcher(deps, { token: env.OMNIMESH_GITHUB_TOKEN, slug: state.repo.slug, branch: state.repo.defaultBranch ?? state.repo.branch, files: {}, secrets: { OMNIMESH_STATUS_TOKEN: fresh } }, options.githubApi);
      console.log(pc.green('✔ Your GitHub watcher has the new key too.'));
    } catch (e) {
      console.log(pc.yellow(`! Could not update the key in GitHub (${(e as Error).message}). Run omnimesh up and deploy once to fix it.`));
    }
  }
  return true;
}
