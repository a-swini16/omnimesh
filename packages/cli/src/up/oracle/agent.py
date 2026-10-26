#!/usr/bin/env python3
"""OmniMesh agent for an Oracle server.

Runs every 5 minutes (systemd timer). Reads what this server should run from its own instance metadata
(the "omnimesh" key, written by `omnimesh up`), then makes it so: the Cloudflare tunnel, and one container
per service, rebuilt only when that service's code or settings changed. Services removed from your app are
stopped. Only the Python standard library, git and Docker are used.
"""
import hashlib
import json
import os
import subprocess
import sys
import urllib.request

ROOT = os.environ.get('OMNIMESH_ROOT', '/opt/omnimesh')
# Oracle's instance metadata service (IMDSv2); tests point this at a local server
MANIFEST_URL = os.environ.get('OMNIMESH_MANIFEST_URL', 'http://169.254.169.254/opc/v2/instance/metadata/omnimesh')


def log(message):
    print(f'[omnimesh] {message}', flush=True)


def run(*args, check=True):
    return subprocess.run(list(args), check=check, text=True, capture_output=True)


def manifest():
    req = urllib.request.Request(MANIFEST_URL, headers={'Authorization': 'Bearer Oracle'})
    with urllib.request.urlopen(req, timeout=10) as res:
        return json.loads(res.read().decode())


def running_hash(name):
    """The settings hash of a running container, or None when it is missing or stopped."""
    r = run('docker', 'inspect', '-f', '{{index .Config.Labels "omnimesh.hash"}} {{.State.Running}}', name, check=False)
    if r.returncode != 0:
        return None
    parts = r.stdout.strip().split(' ')
    return parts[0] if len(parts) == 2 and parts[1] == 'true' else None


def code_version(src, folder):
    """Changes when the service's code changes, but not for commits that only touch .github (the watcher)."""
    if folder:
        return run('git', '-C', src, 'rev-parse', f'HEAD:{folder}').stdout.strip()
    entries = [line for line in run('git', '-C', src, 'ls-tree', 'HEAD').stdout.splitlines() if not line.endswith('\t.github')]
    return hashlib.sha256('\n'.join(entries).encode()).hexdigest()


def dockerfile(s):
    base = 'node:22-bookworm-slim' if s['runtime'] == 'node' else 'python:3.12-slim'
    lines = [f'FROM {base}', 'WORKDIR /app', 'COPY . .']
    if s.get('buildCommand'):
        lines.append('RUN ' + s['buildCommand'])
    # Exec form with sh -c, so $PORT is expanded when the container starts
    lines.append('CMD ["sh", "-c", ' + json.dumps(s['startCommand']) + ']')
    return '\n'.join(lines) + '\n'


def deploy(s, gate):
    name = 'omnimesh-' + s['id']
    home = os.path.join(ROOT, 'svc-' + s['id'])
    src = os.path.join(home, 'src')
    os.makedirs(home, mode=0o700, exist_ok=True)
    if not os.path.isdir(os.path.join(src, '.git')):
        run('git', 'clone', '--depth', '1', '--branch', s['branch'], s['repoUrl'], src)
    else:
        run('git', '-C', src, 'fetch', '--depth', '1', 'origin', s['branch'])
        run('git', '-C', src, 'reset', '--hard', 'FETCH_HEAD')
    env = dict(s.get('env', {}))
    env['PORT'] = str(s['port'])
    if s.get('gated'):
        env['OMNIMESH_GATE'] = gate
    want = hashlib.sha256(json.dumps([code_version(src, s.get('folder')), s, env], sort_keys=True).encode()).hexdigest()[:32]
    if running_hash(name) == want:
        return False
    context = os.path.join(src, s['folder']) if s.get('folder') else src
    log(f"{s['route']}: building")
    if s['runtime'] == 'docker':
        run('docker', 'build', '-t', name, context)
    else:
        path = os.path.join(home, 'Dockerfile')
        with open(path, 'w') as f:
            f.write(dockerfile(s))
        run('docker', 'build', '-f', path, '-t', name, context)
    env_file = os.path.join(home, 'app.env')
    fd = os.open(env_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(''.join(f'{k}={v}\n' for k, v in env.items()))
    run('docker', 'rm', '-f', name, check=False)
    run('docker', 'run', '-d', '--name', name, '--restart', 'unless-stopped', '--network', 'host',
        '--env-file', env_file, '--label', 'omnimesh.hash=' + want, name)
    log(f"{s['route']}: running on port {s['port']}")
    return True


def tunnel(token):
    want = hashlib.sha256(token.encode()).hexdigest()[:32]
    if running_hash('omnimesh-tunnel') == want:
        return
    run('docker', 'rm', '-f', 'omnimesh-tunnel', check=False)
    run('docker', 'run', '-d', '--name', 'omnimesh-tunnel', '--restart', 'unless-stopped', '--network', 'host',
        '--label', 'omnimesh.hash=' + want, 'cloudflare/cloudflared:latest', 'tunnel', '--no-autoupdate', 'run', '--token', token)
    log('tunnel started')


def main():
    m = manifest()
    failed = 0
    try:
        tunnel(m['tunnelToken'])
    except subprocess.CalledProcessError as e:
        failed += 1
        log('tunnel: ' + (e.stderr or str(e))[-500:])
    wanted = set()
    for s in m['services']:
        wanted.add('omnimesh-' + s['id'])
        try:
            deploy(s, m.get('gate', ''))
        except subprocess.CalledProcessError as e:
            # One broken service does not stop the others; the next run tries again
            failed += 1
            log(f"{s['route']}: failed: " + (e.stderr or str(e))[-800:])
    for name in run('docker', 'ps', '-a', '--format', '{{.Names}}').stdout.split():
        if name.startswith('omnimesh-') and name != 'omnimesh-tunnel' and name not in wanted:
            run('docker', 'rm', '-f', name, check=False)
            log(f'stopped {name}: it is no longer part of your app')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
