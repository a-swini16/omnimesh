'use strict';
/*
 * OmniMesh gate: locks a server to its router without changing the app's code.
 * It takes the public port first (so the cloud can only ever route to the gate), starts your app's own
 * start command on a private port, and lets a request in only when it carries the router's
 * X-Gateway-Secret. Anyone who finds the server's direct address gets 403. omnimesh up sets it as the
 * start command:
 *   node -e "eval(Buffer.from(process.env.OMNIMESH_GATE,'base64').toString())" <your start command>
 * No dependencies; plain Node.js.
 */
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

const log = (m) => console.error(`[omnimesh-gate] ${m}`);
const secrets = [process.env.GATEWAY_SECRET, process.env.GATEWAY_SECRET_PREVIOUS].filter((s) => s && s.length >= 32).map((s) => Buffer.from(s));
const PORT = Number(process.env.PORT) || 10000;
const APP_PORT = Number(process.env.OMNIMESH_APP_PORT) || (PORT < 65535 ? PORT + 1 : PORT - 1);
// A path the cloud's own health check may call without the secret (only GET/HEAD, only this exact path)
const PUBLIC_PATH = process.env.OMNIMESH_GATE_PUBLIC_PATH || '';
const command = process.argv.slice(1).join(' ').trim();
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade']);

if (!secrets.length) {
  log('GATEWAY_SECRET is missing or shorter than 32 characters, so nothing could get in. Refusing to start.');
  process.exit(1);
}
if (!command) {
  log('no start command given');
  process.exit(1);
}

function allowed(req) {
  const got = req.headers['x-gateway-secret'];
  if (typeof got === 'string') {
    const b = Buffer.from(got);
    if (secrets.some((s) => s.length === b.length && crypto.timingSafeEqual(s, b))) return true;
  }
  return Boolean(PUBLIC_PATH) && (req.method === 'GET' || req.method === 'HEAD') && req.url.split('?')[0] === PUBLIC_PATH;
}

const without = (headers) => Object.fromEntries(Object.entries(headers).filter(([k]) => !HOP.has(k.toLowerCase())));

// 1. Your app, on the private port, started once the gate holds the public port (see the end).
// If it stops, the gate stops too, so the cloud restarts both.
let app = null;
function startApp() {
  app = spawn(command, { shell: true, stdio: 'inherit', env: { ...process.env, PORT: String(APP_PORT) } });
  app.on('exit', (code, signal) => {
    log(`your app exited (${signal || code})`);
    process.exit(code === null ? 1 : code);
  });
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => (app ? app.kill(sig) : process.exit(0)));

// 2. Requests that arrive while the app is still starting wait for it (like a cold start) instead of failing
const started = Date.now();
const appReady = new Promise((resolve) => {
  (function waitForApp() {
    const probe = net.connect(APP_PORT, '127.0.0.1');
    probe.once('connect', () => {
      probe.destroy();
      log(`your app is answering (ready in ${Date.now() - started} ms)`);
      resolve();
    });
    probe.once('error', () => {
      probe.destroy();
      setTimeout(waitForApp, 250);
    });
  })();
});

// 3. The public port
const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });
const server = http.createServer(async (req, res) => {
  if (!allowed(req)) {
    req.resume();
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end('{"error":"Forbidden: this server only accepts requests through its OmniMesh router"}');
    return;
  }
  await appReady;
  const upstream = http.request({ host: '127.0.0.1', port: APP_PORT, method: req.method, path: req.url, headers: without(req.headers), agent }, (r) => {
    res.writeHead(r.statusCode || 502, r.statusMessage, without(r.headers));
    r.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end('{"error":"The app is not answering"}');
  });
  req.pipe(upstream);
});

// WebSockets and other upgrades: check the secret, then join the two connections
server.on('upgrade', async (req, socket, head) => {
  if (!allowed(req)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  await appReady;
  const upstream = net.connect(APP_PORT, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

// The public port opens before the app's, so a cloud that detects ports by itself finds the gate
server.listen(PORT, '0.0.0.0', () => {
  log(`locked: port ${PORT} accepts only requests from your router (your app runs on ${APP_PORT})`);
  startApp();
});
