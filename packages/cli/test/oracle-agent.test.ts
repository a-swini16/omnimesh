import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { oracleManifest, type OracleService } from '../src/up/oracle.js';
import type { RepoInfo } from '../src/up/detect.js';

const AGENT = path.join(__dirname, '..', 'src', 'up', 'oracle', 'agent.py');
const hasPython = spawnSync('python3', ['--version']).status === 0;

// Stand-ins for docker and git that record what the agent asks for, and keep "containers" as files
const FAKE_DOCKER = `#!/bin/bash
echo "docker $*" >> "$FAKE_LOG"
C="$FAKE_STATE/containers"; mkdir -p "$C"
case "$1" in
  inspect) name="\${@: -1}"; [ -f "$C/$name" ] || exit 1; echo "$(cat "$C/$name") true" ;;
  run) name=""; hash=""; while [ $# -gt 0 ]; do case "$1" in --name) name="$2"; shift ;; --label) hash="\${2#omnimesh.hash=}"; shift ;; esac; shift; done; echo "$hash" > "$C/$name" ;;
  rm) rm -f "$C/\${@: -1}" ;;
  ps) ls "$C" ;;
  build) exit 0 ;;
esac
`;
const FAKE_GIT = `#!/bin/bash
echo "git $*" >> "$FAKE_LOG"
case "$1" in
  clone) mkdir -p "\${@: -1}/.git" ;;
  -C) case "$3" in
        rev-parse) echo "tree-$(cat "$FAKE_STATE/commit" 2>/dev/null || echo 1)" ;;
        ls-tree) echo "100644 blob $(cat "$FAKE_STATE/commit" 2>/dev/null || echo 1)	package.json"; echo "040000 tree w$(cat "$FAKE_STATE/watcher" 2>/dev/null || echo 1)	.github" ;;
      esac ;;
esac
`;

const repo: RepoInfo = { slug: 'github.com/me/shop-api', url: 'https://github.com/me/shop-api', branch: 'main', defaultBranch: 'main', runtime: 'node', buildCommand: 'npm ci', startCommand: 'npm start' };
const services = (extra: Record<string, string> = {}, withAuth = true): OracleService[] => [
  { id: 'main', route: '/', repo, env: { GATEWAY_SECRET: 'g'.repeat(64), ...extra }, hostname: 'oracle.example.com', port: 8000 },
  ...(withAuth ? [{ id: 'auth', route: '/auth', repo: { ...repo, folder: 'services/auth' }, env: { GATEWAY_SECRET: 'g'.repeat(64) }, hostname: 'oracle-auth.example.com', port: 8010 }] : []),
];

describe.skipIf(!hasPython)('Oracle agent (the program on the server)', () => {
  let dir: string;
  let server: http.Server;
  let manifest = '';
  let url = '';

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnimesh-agent-'));
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.writeFileSync(path.join(dir, 'bin', 'docker'), FAKE_DOCKER, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'bin', 'git'), FAKE_GIT, { mode: 0o755 });
    // Plays Oracle's instance metadata service, which needs this exact header
    server = http.createServer((req, res) => {
      if (req.headers.authorization !== 'Bearer Oracle') return res.writeHead(401).end();
      res.end(manifest);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as any).port}/opc/v2/instance/metadata/omnimesh`;
  });
  afterAll(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Not spawnSync: the metadata server above runs in this process and must keep answering
  const runAgent = () =>
    new Promise<{ code: number | null; out: string; calls: string[]; runs: string[] }>((resolve) => {
      fs.writeFileSync(path.join(dir, 'log'), '');
      const child = spawn('python3', [AGENT], {
        env: { ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, OMNIMESH_ROOT: path.join(dir, 'root'), OMNIMESH_MANIFEST_URL: url, FAKE_LOG: path.join(dir, 'log'), FAKE_STATE: dir },
      });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('close', (code) => {
        const calls = fs.readFileSync(path.join(dir, 'log'), 'utf-8').split('\n').filter(Boolean);
        resolve({ code, out, calls, runs: calls.filter((c) => c.startsWith('docker run')) });
      });
    });

  it('starts the tunnel and every service, each on its port, with its settings kept private', async () => {
    manifest = oracleManifest({ services: services({ OPENAI_API_KEY: 'sk-test' }), tunnelToken: 'tok', lock: true });
    const r = await runAgent();
    expect(r.code).toBe(0);
    expect(r.runs.map((c) => c.match(/--name (\S+)/)![1]).sort()).toEqual(['omnimesh-auth', 'omnimesh-main', 'omnimesh-tunnel']);
    expect(r.runs.find((c) => c.includes('omnimesh-tunnel'))).toContain('cloudflare/cloudflared:latest tunnel --no-autoupdate run --token tok');
    // The auth service is built from its folder
    expect(r.calls).toContain(`docker build -f ${path.join(dir, 'root', 'svc-auth', 'Dockerfile')} -t omnimesh-auth ${path.join(dir, 'root', 'svc-auth', 'src', 'services/auth')}`);
    const envFile = path.join(dir, 'root', 'svc-main', 'app.env');
    expect(fs.statSync(envFile).mode & 0o077).toBe(0);
    const env = fs.readFileSync(envFile, 'utf-8');
    expect(env).toContain('PORT=8000\n');
    expect(env).toContain('OPENAI_API_KEY=sk-test\n');
    expect(env).toMatch(/^OMNIMESH_GATE=.{1000,}$/m); // locked: the gate rides along
    expect(fs.readFileSync(path.join(dir, 'root', 'svc-main', 'Dockerfile'), 'utf-8')).toContain('CMD ["sh", "-c", "node -e \\"eval(Buffer.from(process.env.OMNIMESH_GATE');
    expect(fs.readFileSync(path.join(dir, 'root', 'svc-auth', 'app.env'), 'utf-8')).toContain('PORT=8010\n');
  });

  it('does nothing when nothing changed, and ignores a commit that only touches .github', async () => {
    expect((await runAgent()).runs).toEqual([]);
    fs.writeFileSync(path.join(dir, 'watcher'), '2'); // the GitHub watcher's own commit
    expect((await runAgent()).runs).toEqual([]);
  });

  it('rebuilds only the service whose code or settings changed', async () => {
    manifest = oracleManifest({ services: services({ OPENAI_API_KEY: 'sk-new' }), tunnelToken: 'tok', lock: true });
    expect((await runAgent()).runs.map((c) => c.match(/--name (\S+)/)![1])).toEqual(['omnimesh-main']);
    fs.writeFileSync(path.join(dir, 'commit'), '2'); // a new commit: both services come from this repo
    expect((await runAgent()).runs.map((c) => c.match(/--name (\S+)/)![1]).sort()).toEqual(['omnimesh-auth', 'omnimesh-main']);
  });

  it('stops a service you removed from your app', async () => {
    manifest = oracleManifest({ services: services({ OPENAI_API_KEY: 'sk-new' }, false), tunnelToken: 'tok', lock: true });
    const r = await runAgent();
    expect(r.calls).toContain('docker rm -f omnimesh-auth');
    expect(r.out).toContain('stopped omnimesh-auth: it is no longer part of your app');
  });
});
