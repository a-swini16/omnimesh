import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { gateEnv, gateStartCommand } from '../src/up/gate.js';

const SECRET = 'g'.repeat(64);

/** A small app: echoes the path, keeps cookies, and answers a WebSocket-style upgrade. */
const APP = `
const http = require('http');
const s = http.createServer((req, res) => {
  if (req.url === '/crash') process.exit(3);
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('Set-Cookie', ['a=1', 'b=2']);
    res.end(JSON.stringify({ path: req.url, method: req.method, body, port: process.env.PORT, sawSecret: Boolean(req.headers['x-gateway-secret']) }));
  });
});
s.on('upgrade', (req, socket) => {
  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: echo\\r\\nConnection: Upgrade\\r\\n\\r\\n');
  socket.on('data', (d) => socket.write('echo:' + d));
});
setTimeout(() => s.listen(Number(process.env.PORT), '127.0.0.1'), 300); // a slow start
`;

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

describe('OmniMesh gate: locks a server without changing the app', () => {
  let dir: string;
  let gate: ChildProcess;
  let base = '';
  let logs = '';

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnimesh-gate-'));
    fs.writeFileSync(path.join(dir, 'app.js'), APP);
    const port = await freePort();
    // Exactly the start command and environment omnimesh up gives the cloud
    gate = spawn(gateStartCommand('node app.js'), {
      shell: true,
      cwd: dir,
      env: { ...process.env, PORT: String(port), GATEWAY_SECRET: SECRET, OMNIMESH_GATE_PUBLIC_PATH: '/healthz', ...gateEnv() },
    });
    gate.stderr!.on('data', (d) => (logs += d));
    base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100 && !logs.includes('locked:'); i++) await new Promise((r) => setTimeout(r, 50));
  });
  afterAll(() => {
    gate?.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('takes the public port before the app starts, and holds requests until the app answers', async () => {
    expect(logs).toMatch(/locked: port \d+ accepts only requests from your router/);
    // The app listens 300 ms after starting: a request sent now waits for it instead of failing
    const res = await fetch(`${base}/early`, { headers: { 'X-Gateway-Secret': SECRET } });
    expect(res.status).toBe(200);
    expect(logs.indexOf('locked:')).toBeLessThan(logs.indexOf('your app is answering'));
  });

  it('refuses anyone without the secret, and lets the router through untouched', async () => {
    const direct = await fetch(`${base}/orders`);
    expect(direct.status).toBe(403);
    expect(await direct.json()).toEqual({ error: 'Forbidden: this server only accepts requests through its OmniMesh router' });
    expect((await fetch(`${base}/orders`, { headers: { 'X-Gateway-Secret': 'x'.repeat(64) } })).status).toBe(403);

    const res = await fetch(`${base}/orders?id=7`, { method: 'POST', headers: { 'X-Gateway-Secret': SECRET, 'Content-Type': 'text/plain' }, body: 'hello' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ path: '/orders?id=7', method: 'POST', body: 'hello', sawSecret: true });
    expect(Number(body.port)).not.toBe(Number(new URL(base).port)); // the app itself is on a private port
    expect(res.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
  });

  it('lets the cloud\'s own health check reach only its one path', async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/healthz`, { method: 'POST' })).status).toBe(403);
    expect((await fetch(`${base}/healthz/../orders`)).status).toBe(403);
  });

  it('checks the secret on WebSocket upgrades too', async () => {
    const talk = (withSecret: boolean) =>
      new Promise<string>((resolve) => {
        const s = net.connect(Number(new URL(base).port), '127.0.0.1', () => {
          s.write(`GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: echo\r\nConnection: Upgrade\r\n${withSecret ? `X-Gateway-Secret: ${SECRET}\r\n` : ''}\r\n`);
          setTimeout(() => s.write('ping'), 100);
        });
        let got = '';
        s.on('data', (d) => (got += d));
        setTimeout(() => {
          s.destroy();
          resolve(got);
        }, 400);
      });
    expect(await talk(false)).toMatch(/^HTTP\/1\.1 403/);
    const ok = await talk(true);
    expect(ok).toMatch(/^HTTP\/1\.1 101/);
    expect(ok).toContain('echo:ping');
  });

  it('stops when the app stops, so the cloud restarts it', async () => {
    const exited = new Promise<number | null>((r) => gate.once('exit', (code) => r(code)));
    await fetch(`${base}/crash`, { headers: { 'X-Gateway-Secret': SECRET } }).catch(() => null);
    expect(await exited).toBe(3);
    expect(logs).toMatch(/your app exited \(3\)/);
  });

  it('refuses to start without a strong secret', async () => {
    const r = spawn(gateStartCommand('node -e 1'), { shell: true, env: { ...process.env, PORT: '1', GATEWAY_SECRET: 'short', ...gateEnv() } });
    let err = '';
    r.stderr!.on('data', (d) => (err += d));
    expect(await new Promise((res) => r.once('exit', res))).toBe(1);
    expect(err).toMatch(/GATEWAY_SECRET is missing or shorter than 32/);
  });
});
