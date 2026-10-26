import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from '@omnimesh/core';
import { realDeps, type Deps } from './http.js';
import { runUp, loadState, readDotEnv, writeDotEnv, type UpInput, type UpOptions, type UpResult } from './orchestrate.js';
import { parseOciCredentials, type OciCredentials } from './oci.js';

const WIZARD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'wizard');
const ASSETS: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html'],
  '/app.js': ['app.js', 'text/javascript'],
  '/style.css': ['style.css', 'text/css'],
};
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};
const TOKEN_ENV = { koyeb: 'KOYEB_API_TOKEN', render: 'RENDER_API_KEY', cloudflare: 'CLOUDFLARE_API_TOKEN', github: 'OMNIMESH_GITHUB_TOKEN' } as const;
/** The Oracle private key lives next to the deployment state (git-ignored, readable only by you) */
const OCI_KEY_FILE = path.join('.omnimesh', 'oci_api_key.pem');

/** Oracle credentials saved by an earlier run, or null. */
function savedOracle(cwd: string): { creds: OciCredentials; hostname: string } | null {
  const env = readDotEnv(cwd);
  try {
    const pem = fs.readFileSync(path.join(cwd, OCI_KEY_FILE), 'utf-8');
    const config = ociConfigText({ tenancy: env.OCI_TENANCY, user: env.OCI_USER, fingerprint: env.OCI_FINGERPRINT, region: env.OCI_REGION });
    return env.ORACLE_HOSTNAME ? { creds: parseOciCredentials(config, pem), hostname: env.ORACLE_HOSTNAME } : null;
  } catch {
    return null;
  }
}

const ociConfigText = (c: { tenancy?: string; user?: string; fingerprint?: string; region?: string }) =>
  `tenancy=${c.tenancy}\nuser=${c.user}\nfingerprint=${c.fingerprint}\nregion=${c.region}`;

function saveOracle(cwd: string, oracle: { creds: OciCredentials; hostname: string }): void {
  fs.mkdirSync(path.join(cwd, '.omnimesh'), { recursive: true });
  fs.writeFileSync(path.join(cwd, OCI_KEY_FILE), oracle.creds.privateKey + '\n', { mode: 0o600 });
  fs.chmodSync(path.join(cwd, OCI_KEY_FILE), 0o600);
  const { tenancy, user, fingerprint, region } = oracle.creds;
  writeDotEnv(cwd, { OCI_TENANCY: tenancy, OCI_USER: user, OCI_FINGERPRINT: fingerprint, OCI_REGION: region, ORACLE_HOSTNAME: oracle.hostname });
}

interface Job {
  running: boolean;
  log: Array<{ at: number; text: string }>;
  result: UpResult | null;
  error: string | null;
}

export interface WizardServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/**
 * Local wizard for `omnimesh up`. Bound to 127.0.0.1, and every API call needs the one-time key
 * from the printed URL, so other websites open in the browser cannot read state or start a deploy.
 */
export async function startWizard(opts: UpOptions & { port?: number; deps?: (log: (m: string) => void) => Deps }): Promise<WizardServer> {
  const key = crypto.randomBytes(24).toString('hex');
  const job: Job = { running: false, log: [], result: null, error: null };
  let port = 0;

  const send = (res: http.ServerResponse, status: number, body: unknown, type = 'application/json') => {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': `${type}; charset=utf-8` });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };

  const readBody = (req: http.IncomingMessage) =>
    new Promise<any>((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 64 * 1024) {
          reject(new Error('body too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}'));
        } catch {
          reject(new Error('invalid JSON'));
        }
      });
    });

  const server = http.createServer(async (req, res) => {
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    // Blocks DNS rebinding: only our own address may talk to this server
    if (!allowedHosts.includes(req.headers.host || '')) return send(res, 421, { error: 'Wrong host' });
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);

    if (req.method === 'GET' && ASSETS[url.pathname]) {
      const [file, type] = ASSETS[url.pathname];
      return send(res, 200, fs.readFileSync(path.join(WIZARD_DIR, file), 'utf-8'), type);
    }
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });

    const origin = req.headers.origin;
    if (origin && !allowedHosts.map((h) => `http://${h}`).includes(origin)) return send(res, 403, { error: 'Forbidden origin' });
    if (!timingSafeEqual(String(req.headers['x-omnimesh-key'] || ''), key)) return send(res, 401, { error: 'Open the exact link printed in your terminal.' });

    try {
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const state = loadState(opts.cwd);
        const env = readDotEnv(opts.cwd);
        return send(res, 200, {
          deployed: state
            ? {
                repoUrl: state.repo.url,
                appUrl: state.router.url,
                dashboardUrl: `${state.router.url}/_omnimesh/dashboard`,
                statusToken: env.OMNIMESH_STATUS_TOKEN || null,
                nodes: state.nodes,
                updatedAt: state.updatedAt,
              }
            : null,
          savedTokens: {
            ...Object.fromEntries(Object.entries(TOKEN_ENV).map(([p, k]) => [p, Boolean(env[k])])),
            oracle: Boolean(savedOracle(opts.cwd)),
            oracleHostname: env.ORACLE_HOSTNAME || null,
          },
          settings: state ? { keepAwake: state.keepAwake !== false, watcher: Boolean(state.watcher) } : null,
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/progress') {
        return send(res, 200, job);
      }
      if (req.method === 'POST' && url.pathname === '/api/deploy') {
        if (job.running) return send(res, 409, { error: 'A deploy is already running.' });
        const body = await readBody(req);
        const saved = readDotEnv(opts.cwd);
        const pick = (p: keyof typeof TOKEN_ENV) => (typeof body.tokens?.[p] === 'string' && body.tokens[p].trim()) || saved[TOKEN_ENV[p]] || undefined;
        const tokens = { koyeb: pick('koyeb'), render: pick('render'), cloudflare: pick('cloudflare') || '', github: pick('github') };
        const previous = loadState(opts.cwd);

        // Oracle: new fields win, then saved ones. `oracle: null` means "no card", so it is skipped.
        // "Redeploy latest code" sends no oracle field at all and keeps what the last deploy used.
        let oracle: UpInput['oracle'];
        const sent = body.oracle && typeof body.oracle === 'object' ? body.oracle : null;
        if (sent && (sent.config || sent.privateKey)) {
          // Replacing only the key (or only the config) keeps the saved other half
          const kept = savedOracle(opts.cwd);
          const config = String(sent.config || '') || (kept ? ociConfigText(kept.creds) : '');
          const privateKey = String(sent.privateKey || '') || kept?.creds.privateKey || '';
          oracle = { creds: parseOciCredentials(config, privateKey), hostname: String(sent.hostname || kept?.hostname || '').trim().toLowerCase() };
        } else if (sent || (body.oracle === undefined && previous?.nodes.some((n) => n.provider === 'oracle'))) {
          const kept = savedOracle(opts.cwd);
          if (kept) oracle = { ...kept, hostname: sent?.hostname ? String(sent.hostname).trim().toLowerCase() : kept.hostname };
        }
        const keepAwake = typeof body.keepAwake === 'boolean' ? body.keepAwake : previous?.keepAwake !== false;
        const watcher = typeof body.watcher === 'boolean' ? body.watcher : Boolean(previous?.watcher);

        if (body.remember) {
          writeDotEnv(opts.cwd, { [TOKEN_ENV.koyeb]: tokens.koyeb, [TOKEN_ENV.render]: tokens.render, [TOKEN_ENV.cloudflare]: tokens.cloudflare || undefined, [TOKEN_ENV.github]: tokens.github });
          if (oracle) saveOracle(opts.cwd, oracle);
        }

        Object.assign(job, { running: true, log: [], result: null, error: null });
        const log = (text: string) => {
          job.log.push({ at: Date.now(), text });
          if (job.log.length > 500) job.log.shift();
        };
        const deps = (opts.deps ?? realDeps)(log);
        runUp(deps, { repoUrl: String(body.repoUrl || ''), branch: body.branch || undefined, startCommand: body.startCommand || undefined, tokens, oracle, keepAwake, watcher }, opts)
          .then((result) => (job.result = result))
          .catch((e: Error) => {
            job.error = e.message;
            log(`✖ ${e.message}`);
          })
          .finally(() => (job.running = false));
        return send(res, 202, { started: true });
      }
      return send(res, 404, { error: 'Not found' });
    } catch (e) {
      return send(res, 400, { error: (e as Error).message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
  return {
    url: `http://127.0.0.1:${port}/#key=${key}`,
    port,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
