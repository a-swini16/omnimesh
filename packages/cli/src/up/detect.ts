import { callApi, type Deps } from './http.js';

export interface RepoInfo {
  /** github.com/owner/name */
  slug: string;
  url: string;
  branch: string;
  /** Scheduled GitHub workflows run only on this branch */
  defaultBranch: string;
  runtime: 'docker' | 'node' | 'python';
  buildCommand?: string;
  startCommand?: string;
}

/** Accepts https://github.com/owner/repo(.git)(/tree/branch) or owner/repo. */
export function parseGithubUrl(input: string): { owner: string; repo: string; branch?: string } {
  const trimmed = input.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const m =
    trimmed.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)(?:\/tree\/([\w./-]+))?$/i) ||
    trimmed.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!m) throw new Error('Paste a GitHub repository link, for example https://github.com/you/your-backend');
  return { owner: m[1], repo: m[2], branch: m[3] };
}

/**
 * Look at a public GitHub repo and decide how to build it: a Dockerfile wins, then Node
 * (package.json), then Python (requirements.txt / pyproject.toml).
 */
export async function detectRepo(deps: Deps, input: string, overrides: { branch?: string; startCommand?: string } = {}): Promise<RepoInfo> {
  const { owner, repo, branch: urlBranch } = parseGithubUrl(input);
  const meta = await callApi(deps, 'GitHub', `https://api.github.com/repos/${owner}/${repo}`).catch((e) => {
    if (e.status === 404) throw new Error(`GitHub: ${owner}/${repo} was not found. The repository must exist and be public.`);
    throw e;
  });
  if (meta.private) throw new Error('GitHub: this repository is private. Make it public, or connect GitHub in each provider first.');
  const branch = overrides.branch || urlBranch || meta.default_branch || 'main';
  if (!/^[\w./-]+$/.test(branch) || branch.includes('..')) throw new Error(`GitHub: "${branch}" is not a valid branch name.`);
  const files: Array<{ name: string }> = await callApi(deps, 'GitHub', `https://api.github.com/repos/${owner}/${repo}/contents?ref=${encodeURIComponent(branch)}`);
  const names = new Set(files.map((f) => f.name));
  const base = { slug: `github.com/${owner}/${repo}`, url: `https://github.com/${owner}/${repo}`, branch, defaultBranch: meta.default_branch || branch };

  if (names.has('Dockerfile')) return { ...base, runtime: 'docker' };
  if (names.has('package.json')) {
    const pkgFile = await callApi(deps, 'GitHub', `https://api.github.com/repos/${owner}/${repo}/contents/package.json?ref=${encodeURIComponent(branch)}`);
    let scripts: Record<string, string> = {};
    try {
      scripts = JSON.parse(Buffer.from(pkgFile.content, 'base64').toString('utf-8')).scripts || {};
    } catch {
      // unreadable package.json: fall back to defaults
    }
    const install = names.has('pnpm-lock.yaml') ? 'npx pnpm install' : names.has('yarn.lock') ? 'yarn install' : 'npm install';
    return {
      ...base,
      runtime: 'node',
      buildCommand: scripts.build ? `${install} && npm run build` : install,
      startCommand: overrides.startCommand || (scripts.start ? 'npm start' : 'node index.js'),
    };
  }
  if (names.has('requirements.txt') || names.has('pyproject.toml')) {
    if (!overrides.startCommand) {
      throw new Error('Python app found. Enter its start command, for example: uvicorn main:app --host 0.0.0.0 --port $PORT');
    }
    return { ...base, runtime: 'python', buildCommand: names.has('requirements.txt') ? 'pip install -r requirements.txt' : 'pip install .', startCommand: overrides.startCommand };
  }
  throw new Error('Could not tell how to run this repo. Add a Dockerfile, or a package.json with a "start" script.');
}
