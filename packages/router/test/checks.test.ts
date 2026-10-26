import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { gatewayAuth } from '@omnimesh/node';
import { validateOmniMeshConfig } from '@omnimesh/core';
import { createRouterApp, nodeState } from '../src/router.js';
import { checkNode, checkTargets, recordDownServers, runChecks } from '../src/checks.js';
import { KvHealthStore, MemoryHealthStore } from '../src/health-store.js';

const SECRET = 's3cr3t_gateway_token_min_32_characters_long_for_security';
const TOKEN = 'status-token-for-tests-0123456789abcdef';
const auth = { Authorization: `Bearer ${TOKEN}` };

function fakeKv() {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k: string) => data.get(k) ?? null,
    put: async (k: string, v: string) => void data.set(k, v),
    delete: async (k: string) => void data.delete(k),
  };
}

describe('Server checks, pause and resume', () => {
  const servers: any[] = [];
  let locked = '';
  let open = '';
  let broken = '';
  let closed = '';
  let lockedDown = false;

  const start = (app: Hono) =>
    new Promise<string>((resolve) => {
      servers.push(serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => resolve(`http://127.0.0.1:${info.port}`)));
    });

  beforeAll(async () => {
    const a = new Hono();
    a.use('*', gatewayAuth({ secret: SECRET }));
    a.get('/health', (c) => (lockedDown ? c.text('down', 503) : c.json({ ok: true })));
    a.get('/', (c) => (lockedDown ? c.text('down', 503) : c.json({ from: 'locked' })));
    locked = await start(a);

    const b = new Hono();
    b.get('/', (c) => c.json({ from: 'open' })); // no /health route: a 404 still proves it is up
    open = await start(b);

    const d = new Hono();
    d.get('/health', (c) => c.text('database unreachable', 500));
    broken = await start(d);

    // A port that was listening and is now closed: connection refused
    const tmp = new Hono();
    closed = await start(tmp);
    await new Promise((r) => servers.pop().close(r));
  });

  afterAll(() => servers.forEach((s) => s.close()));

  it('reports online, the lock level, app errors and unreachable servers', async () => {
    const t = (url: string) => ({ url, pool: '/', label: 'n', healthPath: '/health', sleepsIfIdle: false });
    const a = await checkNode(t(locked), SECRET, 2000);
    expect(a).toMatchObject({ state: 'online', status: 200, lock: 'locked', reason: null });
    expect(a.latencyMs).toBeGreaterThanOrEqual(0);

    expect(await checkNode(t(open), SECRET, 2000)).toMatchObject({ state: 'online', status: 404, lock: 'open' });
    expect(await checkNode(t(broken), SECRET, 2000)).toMatchObject({ state: 'error', status: 500, lock: 'open' });
    expect(await checkNode(t(closed), SECRET, 2000)).toMatchObject({ state: 'down', status: null, reason: 'could not connect' });

    lockedDown = true;
    try {
      expect(await checkNode(t(locked), SECRET, 2000)).toMatchObject({ state: 'down', status: 503, lock: 'unknown' });
    } finally {
      lockedDown = false;
    }
  });

  it('sees the lock even when the app leaves /health public', async () => {
    const app = new Hono();
    app.get('/health', (c) => c.json({ ok: true })); // before gatewayAuth: anyone may call it
    app.use('*', gatewayAuth({ secret: SECRET }));
    app.get('/orders', (c) => c.json([]));
    const url = await start(app);
    expect(await checkNode({ url, pool: '/', label: 'n', healthPath: '/health', sleepsIfIdle: false }, SECRET, 2000)).toMatchObject({ state: 'online', lock: 'locked' });
  });

  it('tells the circuit breaker only when a server goes from up to down (KV writes stay inside the free plan)', async () => {
    const marked: string[] = [];
    const store = { markNodeDead: async (url: string) => void marked.push(url) };
    const down = { state: 'down' as const, status: null, latencyMs: null, reason: 'x', lock: 'unknown' as const, at: 1 };
    const up = { ...down, state: 'online' as const };
    await recordDownServers(store, null, { a: down, b: up });
    await recordDownServers(store, { at: 1, trigger: 'schedule', lastScheduledAt: 1, nodes: { a: down } }, { a: down });
    await recordDownServers(store, { at: 1, trigger: 'schedule', lastScheduledAt: 1, nodes: { a: up } }, { a: down });
    expect(marked).toEqual(['a', 'a']);
  });

  it('skips servers that sleep when idle on the schedule, but checks them on demand', async () => {
    const config = validateOmniMeshConfig({
      profile: 'no-card',
      domain: 'x.test',
      defaultPool: '/',
      pools: { '/': [{ url: locked, providerId: 'oracle' }, { url: open, providerId: 'render' }] },
    });
    const targets = checkTargets(config);
    expect(targets.map((t) => t.sleepsIfIdle)).toEqual([false, true]);

    const scheduled = await runChecks({ targets, gatewaySecret: SECRET, trigger: 'schedule', previous: null, timeoutMs: 2000 });
    expect(Object.keys(scheduled.checked)).toEqual([locked]);
    expect(scheduled.snapshot.lastScheduledAt).toBe(scheduled.snapshot.at);

    const manual = await runChecks({ targets, gatewaySecret: SECRET, trigger: 'manual', previous: scheduled.snapshot, timeoutMs: 2000 });
    expect(Object.keys(manual.snapshot.nodes).sort()).toEqual([locked, open].sort());
    expect(manual.snapshot.lastScheduledAt).toBe(scheduled.snapshot.at);
  });

  function router(healthStore = new MemoryHealthStore(), nodes = [{ url: locked, providerId: 'koyeb' }, { url: open, providerId: 'render' }]) {
    const config = validateOmniMeshConfig({ profile: 'no-card', domain: 'x.test', defaultPool: '/', pools: { '/': nodes } });
    return createRouterApp({ config, gatewaySecret: SECRET, statusToken: TOKEN, healthStore });
  }
  const post = (app: any, path: string, body: unknown) =>
    app.request(path, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('a manual check that finds a server down records it in the activity, and keeps its known lock level', async () => {
    const store = new MemoryHealthStore();
    const app = router(store);
    expect((await post(app, '/_omnimesh/actions/check', {})).status).toBe(200);
    lockedDown = true;
    try {
      const snapshot = await store.getChecks();
      const { snapshot: next } = await runChecks({ targets: checkTargets(validateOmniMeshConfig({ pools: { '/': [locked] } })), gatewaySecret: SECRET, trigger: 'manual', previous: snapshot, timeoutMs: 2000 });
      expect(next.nodes[locked]).toMatchObject({ state: 'down', lock: 'locked' });

      const fresh = router(new MemoryHealthStore());
      expect((await post(fresh, '/_omnimesh/actions/check', {})).status).toBe(200);
      const status = await (await fresh.request('/_omnimesh/status', { headers: auth })).json();
      expect(status.events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'node_down', node: 'koyeb' })]));
      expect(status.pools[0].nodes.find((n: any) => n.label === 'koyeb').state).toBe('down');
    } finally {
      lockedDown = false;
    }
  });

  it('the GitHub watcher\'s check skips sleeping servers unless keep-awake is on, and is recorded', async () => {
    const make = (keepAwake: boolean) =>
      createRouterApp({
        config: validateOmniMeshConfig({ profile: 'no-card', domain: 'x.test', defaultPool: '/', pools: { '/': [{ url: locked, providerId: 'oracle' }, { url: open, providerId: 'render' }] }, keepAlive: { enabled: keepAwake } }),
        gatewaySecret: SECRET,
        statusToken: TOKEN,
      });
    const off = await (await post(make(false), '/_omnimesh/actions/check', { source: 'watcher' })).json();
    expect(Object.keys(off.nodes)).toEqual([locked]); // render sleeps when idle: left alone

    const app = make(true);
    const on = await (await post(app, '/_omnimesh/actions/check', { source: 'watcher' })).json();
    expect(Object.keys(on.nodes).sort()).toEqual([locked, open].sort());
    const status = await (await app.request('/_omnimesh/status', { headers: auth })).json();
    expect(status.checks.lastTrigger).toBe('watcher');
    expect(Date.parse(status.checks.lastWatcherAt)).toBeGreaterThan(Date.now() - 10_000);
  });

  it('counts Cloudflare\'s "cannot reach the server" answers (530, 52x) as down', async () => {
    const a = new Hono();
    a.get('/health', (c) => c.text('error code: 1033', 530 as any));
    const url = await start(a);
    expect(await checkNode({ url, pool: '/', label: 'n', healthPath: '/health', sleepsIfIdle: false }, SECRET, 2000)).toMatchObject({ state: 'down', status: 530 });
  });

  it('hides every action from callers without the sign-in key', async () => {
    const app = router();
    for (const path of ['/_omnimesh/actions/pause', '/_omnimesh/actions/resume', '/_omnimesh/actions/check']) {
      const res = await app.request(path, { method: 'POST', body: '{}' });
      expect(res.status).toBe(404);
    }
  });

  it('a pause moves traffic to the other cloud and a resume brings it back', async () => {
    const app = router();
    expect((await app.request('/')).headers.get('X-Omni-Node')).toBe('koyeb');

    const paused = await post(app, '/_omnimesh/actions/pause', { pool: '/', node: 'koyeb', seconds: 60 });
    expect(paused.status).toBe(200);
    expect(await paused.json()).toMatchObject({ paused: 'koyeb', shared: true });

    for (let i = 0; i < 3; i++) {
      const res = await app.request('/');
      expect(res.headers.get('X-Omni-Node')).toBe('render');
      expect(res.headers.get('X-Omni-Attempts')).toBe('1');
    }

    const status = await (await app.request('/_omnimesh/status', { headers: auth })).json();
    const koyeb = status.pools[0].nodes.find((n: any) => n.label === 'koyeb');
    expect(koyeb.state).toBe('paused');
    expect(Date.parse(koyeb.pausedUntil)).toBeGreaterThan(Date.now());
    expect(status.events.some((e: any) => e.kind === 'paused' && e.node === 'koyeb')).toBe(true);

    expect((await post(app, '/_omnimesh/actions/resume', { pool: '/', node: 'koyeb' })).status).toBe(200);
    expect((await app.request('/')).headers.get('X-Omni-Node')).toBe('koyeb');
  });

  it('never lets a pause take the app offline', async () => {
    const single = router(new MemoryHealthStore(), [{ url: locked, providerId: 'koyeb' }]);
    const res = await post(single, '/_omnimesh/actions/pause', { pool: '/', node: 'koyeb' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ERR_LAST_SERVER');

    // Both paused is refused too: the second pause would leave nobody
    const app = router();
    expect((await post(app, '/_omnimesh/actions/pause', { pool: '/', node: 'koyeb' })).status).toBe(200);
    expect((await post(app, '/_omnimesh/actions/pause', { pool: '/', node: 'render' })).status).toBe(409);

    // If the other server fails while one is paused, the paused one still answers
    const store = new MemoryHealthStore();
    const broke = router(store, [{ url: locked, providerId: 'koyeb' }, { url: closed, providerId: 'render' }]);
    await store.pauseNode(locked, Date.now() + 60_000);
    const answer = await broke.request('/');
    expect(answer.status).toBe(200);
    expect(answer.headers.get('X-Omni-Node')).toBe('koyeb');
  });

  it('validates pause requests', async () => {
    const app = router();
    expect((await post(app, '/_omnimesh/actions/pause', { pool: '/', node: 'nope' })).status).toBe(400);
    expect((await post(app, '/_omnimesh/actions/pause', { pool: '/', node: 'koyeb', seconds: 301 })).status).toBe(400);
    expect((await post(app, '/_omnimesh/actions/pause', { pool: '/', node: 'koyeb', seconds: 'x' })).status).toBe(400);
    expect((await post(app, '/_omnimesh/actions/pause', { pool: 'constructor', node: 'x' })).status).toBe(400);
    expect((await post(app, '/_omnimesh/actions/resume', { pool: '__proto__', node: 'x' })).status).toBe(400);
  });

  it('a manual check shows real results in the status and is rate limited', async () => {
    const app = router();
    const res = await post(app, '/_omnimesh/actions/check', {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nodes[locked]).toMatchObject({ state: 'online', lock: 'locked' });
    expect(body.nodes[open]).toMatchObject({ state: 'online', lock: 'open' });

    const status = await (await app.request('/_omnimesh/status', { headers: auth })).json();
    expect(status.checks.lastTrigger).toBe('manual');
    expect(status.checks.lastScheduledAt).toBeNull();
    const byLabel = Object.fromEntries(status.pools[0].nodes.map((n: any) => [n.label, n]));
    // Koyeb's free instance scales to zero after 1 hour without traffic
    expect(byLabel.koyeb).toMatchObject({ state: 'healthy', lock: 'locked', sleepsIfIdle: true });
    expect(byLabel.render).toMatchObject({ state: 'healthy', lock: 'open', sleepsIfIdle: true });

    const again = await post(app, '/_omnimesh/actions/check', {});
    expect(again.status).toBe(429);
    expect(again.headers.get('Retry-After')).toBeTruthy();
  });

  it('shares pauses and check results between router instances through KV', async () => {
    const kv = fakeKv();
    const a = new KvHealthStore(kv, { readCacheMs: 0 });
    const b = new KvHealthStore(kv, { readCacheMs: 0 });
    const until = Date.now() + 60_000;
    await a.pauseNode('https://k.example', until);
    expect(await b.getPaused()).toEqual({ 'https://k.example': until });
    await b.resumeNode('https://k.example');
    expect(await a.getPaused()).toEqual({});
    expect(kv.data.has('omnimesh:paused')).toBe(false);

    const snapshot = { at: 1, trigger: 'schedule' as const, lastScheduledAt: 1, nodes: {} };
    await a.saveChecks(snapshot);
    expect(await b.getChecks()).toEqual(snapshot);
  });

  it('picks the newest evidence for a server state', () => {
    const check = { state: 'down' as const, status: null, latencyMs: null, reason: 'x', lock: 'unknown' as const, at: 100 };
    expect(nodeState(undefined, undefined, undefined)).toBe('unknown');
    expect(nodeState({ status: 'healthy', lastChecked: 200 }, check, undefined)).toBe('healthy');
    expect(nodeState({ status: 'healthy', lastChecked: 50 }, check, undefined)).toBe('down');
    expect(nodeState({ status: 'dead', lastChecked: 50 }, { ...check, state: 'online' }, undefined)).toBe('healthy');
    expect(nodeState(undefined, check, Date.now() + 1000)).toBe('paused');
  });
});

describe('Staying signed in on a browser', () => {
  const SECRET2 = 's3cr3t_gateway_token_min_32_characters_long_for_security';
  const KEY = 'status-token-for-tests-0123456789abcdef';
  const make = (statusToken = KEY) =>
    createRouterApp({
      config: validateOmniMeshConfig({ profile: 'no-card', domain: 'x.test', defaultPool: '/', pools: { '/': ['https://a.example', 'https://b.example'] } }),
      gatewaySecret: SECRET2,
      statusToken,
    });
  const signIn = (app: any, body: unknown, origin = 'https://x.test') =>
    app.request(`${origin}/_omnimesh/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const cookieOf = (res: Response) => res.headers.get('set-cookie')!.split(';')[0];

  it('swaps the key for a signed, HttpOnly cookie that only /_omnimesh receives', async () => {
    const app = make();
    expect((await signIn(app, { token: 'wrong' })).status).toBe(401);
    const res = await signIn(app, { token: KEY, remember: true });
    expect(res.status).toBe(200);
    const set = res.headers.get('set-cookie')!;
    expect(set).toMatch(/^omnimesh_session=\d+\.[0-9a-f]{64}; Path=\/_omnimesh; HttpOnly; SameSite=Strict; Secure; Max-Age=2592000$/);
    expect(set).not.toContain(KEY); // the key itself never goes into the cookie
    const status = await app.request('https://x.test/_omnimesh/status', { headers: { Cookie: cookieOf(res) } });
    expect(status.status).toBe(200);
    // Without "keep me signed in" the cookie ends with the browser session
    expect((await signIn(app, { token: KEY, remember: false })).headers.get('set-cookie')).not.toContain('Max-Age');
  });

  it('rejects forged, expired and old-key sessions', async () => {
    const app = make();
    const cookie = cookieOf(await signIn(app, { token: KEY }));
    const [exp, mac] = cookie.split('=')[1].split('.');
    const ask = (c: string) => app.request('https://x.test/_omnimesh/status', { headers: { Cookie: c } }).then((r: Response) => r.status);
    expect(await ask(`omnimesh_session=${Number(exp) + 1000}.${mac}`)).toBe(404); // longer life, same signature
    expect(await ask(`omnimesh_session=${exp}.${'0'.repeat(64)}`)).toBe(404);
    expect(await ask(`omnimesh_session=${Date.now() - 1000}.${mac}`)).toBe(404);
    // A new sign-in key (omnimesh token --rotate) signs every browser out
    expect((await make('another-status-token-0123456789abcdef').request('https://x.test/_omnimesh/status', { headers: { Cookie: cookie } })).status).toBe(404);
  });

  it('a signed-in browser can act only from the dashboard\'s own origin', async () => {
    const app = make();
    const cookie = cookieOf(await signIn(app, { token: KEY }));
    const act = (origin?: string) =>
      app.request('https://x.test/_omnimesh/actions/resume', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
        body: JSON.stringify({ pool: '/', node: 'node-1' }),
      }).then((r: Response) => r.status);
    expect(await act('https://x.test')).toBe(200);
    expect(await act('https://evil.example')).toBe(404);
    expect(await act()).toBe(404);
  });

  it('signing out clears the cookie', async () => {
    const res = await make().request('https://x.test/_omnimesh/session', { method: 'DELETE' });
    expect(res.headers.get('set-cookie')).toMatch(/^omnimesh_session=; Path=\/_omnimesh; .*Max-Age=0/);
  });
});
