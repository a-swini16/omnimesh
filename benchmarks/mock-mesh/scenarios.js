// k6 scenarios against the local mock mesh. Run with: ./run.sh <scenario>
import exec from 'k6/execution';
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const ROUTER = 'http://127.0.0.1:8788';
const SECRET = __ENV.GATEWAY_SECRET;
const SCENARIO = __ENV.SCENARIO;
const NODES = { koyeb: 4101, render: 4102, vercel: 4103, netlify: 4104, deno: 4105 };
const ctl = { 'X-Gateway-Secret': SECRET, 'Content-Type': 'application/json' };

const setMode = (name, mode) => http.post(`http://127.0.0.1:${NODES[name]}/__mock/mode`, JSON.stringify(mode), { headers: ctl, tags: { name: 'control' } });
const stats = (name) => http.get(`http://127.0.0.1:${NODES[name]}/__mock/stats`, { headers: ctl, tags: { name: 'control' } }).json();

const wrongUser = new Counter('wrong_user_data');
const cdnCacheable = new Rate('private_response_cdn_cacheable');
const duplicateOrders = new Counter('duplicate_orders');
const missingOrders = new Counter('missing_orders');
const routerOk = new Rate('router_ok');
const routerDuration = new Trend('router_duration', true);
const slowRequests = new Counter('slow_requests_over_2s');

function hit(method, path, body, params = {}) {
  const res = http.request(method, `${ROUTER}${path}`, body, { ...params, tags: { name: 'router', ...(params.tags || {}) } });
  routerDuration.add(res.timings.duration, params.tags || {});
  if (res.timings.duration > 2000) slowRequests.add(1);
  return res;
}

const configs = {
  // 500 buyers place one order each; the primary writes, then answers too late (2.6 s > 2.5 s timeout),
  // so the router retries on the next node. Clients also retry on 409/503 like a real app would.
  'flash-sale': {
    scenarios: { buyers: { executor: 'per-vu-iterations', vus: 500, iterations: 1, maxDuration: '2m', exec: 'flashSale' } },
    thresholds: { duplicate_orders: ['count==0'], missing_orders: ['count==0'], router_ok: ['rate==1'] },
  },
  // Steady reads; at 10 s the primary stops answering (VM hang).
  'primary-dies': {
    scenarios: {
      traffic: { executor: 'constant-arrival-rate', rate: 100, timeUnit: '1s', duration: '40s', preAllocatedVUs: 300, maxVUs: 600, exec: 'reads' },
      chaos: { executor: 'per-vu-iterations', vus: 1, iterations: 1, startTime: '10s', exec: 'killPrimary' },
    },
    thresholds: { router_ok: ['rate==1'], router_duration: ['max<3000'], slow_requests_over_2s: ['count<300'] },
  },
  // Every node hangs: answers must be a clean 503 within the 6 s budget; then nodes come back.
  'all-down': {
    scenarios: {
      outage: { executor: 'constant-arrival-rate', rate: 20, timeUnit: '1s', duration: '15s', preAllocatedVUs: 200, maxVUs: 400, exec: 'expectCleanOutage' },
      recover: { executor: 'per-vu-iterations', vus: 1, iterations: 1, startTime: '22s', exec: 'recoverAll' },
      after: { executor: 'constant-arrival-rate', rate: 50, timeUnit: '1s', duration: '10s', startTime: '23s', preAllocatedVUs: 50, maxVUs: 100, exec: 'reads' },
    },
    thresholds: { 'checks{phase:outage}': ['rate==1'], 'router_ok{phase:after}': ['rate==1'], 'router_duration{phase:outage}': ['max<6500'] },
  },
  // koyeb has a 1,000/day quota and render answers 429 from the start: traffic must move on with no client errors.
  'quota-429': {
    scenarios: { traffic: { executor: 'shared-iterations', vus: 50, iterations: 3000, maxDuration: '2m', exec: 'reads' } },
    thresholds: { router_ok: ['rate==1'], checks: ['rate==1'] },
  },
  // Huge body and malformed JSON, then normal reads must still succeed.
  'bad-input': {
    scenarios: { attack: { executor: 'per-vu-iterations', vus: 1, iterations: 1, exec: 'badInput' } },
    thresholds: { checks: ['rate==1'] },
  },
  // Users A and B read their own profile concurrently.
  'cross-user-cache': {
    scenarios: { users: { executor: 'constant-vus', vus: 50, duration: '15s', exec: 'profiles' } },
    thresholds: { wrong_user_data: ['count==0'], private_response_cdn_cacheable: ['rate==0'] },
  },
};

export const options = { ...configs[SCENARIO], summaryTrendStats: ['p(50)', 'p(95)', 'p(99)', 'max'] };

export function setup() {
  for (const n of Object.keys(NODES)) setMode(n, { kind: 'ok' });
  if (SCENARIO === 'flash-sale') setMode('koyeb', { kind: 'latency', ms: 2600 });
  if (SCENARIO === 'quota-429') setMode('render', { kind: 'status', status: 429 });
  if (SCENARIO === 'all-down') for (const n of Object.keys(NODES)) setMode(n, { kind: 'hang' });
}

export function teardown() {
  const s = Object.fromEntries(Object.keys(NODES).map((n) => [n, stats(n)]));
  console.log(`node stats: ${JSON.stringify(Object.fromEntries(Object.entries(s).map(([n, v]) => [n, v.served])))}`);
  if (SCENARIO === 'flash-sale') {
    const o = s.koyeb.orders;
    console.log(`orders: ${JSON.stringify(o)}`);
    duplicateOrders.add(o.duplicates);
    missingOrders.add(Math.max(0, 500 - o.distinctKeys));
  }
  if (SCENARIO === 'quota-429') {
    check(s, {
      'koyeb stopped near its 1,000/day quota (95% = 950)': (x) => x.koyeb.served >= 900 && x.koyeb.served <= 1000,
      'render (429) served nothing': (x) => x.render.served === 0,
    });
  }
}

export function reads() {
  const phase = exec.scenario.name === 'after' ? 'after' : 'main';
  const res = hit('GET', '/api/data', null, { tags: { phase } });
  routerOk.add(res.status === 200, { phase });
}

export function killPrimary() {
  setMode('koyeb', { kind: 'hang' });
}

export function recoverAll() {
  for (const n of Object.keys(NODES)) setMode(n, { kind: 'ok' });
}

export function expectCleanOutage() {
  const res = hit('GET', '/api/data', null, { tags: { phase: 'outage' } });
  check(res, {
    'clean 503 JSON': (r) => r.status === 503 && r.json('code') === 'ERR_FAILOVER_EXHAUSTED',
    'within 6.5 s budget': (r) => r.timings.duration < 6500,
  }, { phase: 'outage' });
}

export function flashSale() {
  const key = `order-${__VU}`;
  const body = JSON.stringify({ item: 'phone', qty: 1 });
  let res;
  for (let attempt = 0; attempt < 6; attempt++) {
    res = hit('POST', '/api/orders', body, { headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key } });
    if (res.status === 201) break;
    sleep(1); // 409 (in flight elsewhere) or 503: retry with the same key, as clients should
  }
  routerOk.add(res.status === 201);
}

export function badInput() {
  const big = 'x'.repeat(5 * 1024 * 1024);
  const huge = hit('POST', '/api/items', big, { headers: { 'Content-Type': 'application/json' } });
  console.log(`5 MB body -> ${huge.status} ${String(huge.body).slice(0, 120)}`);
  check(huge, { '5 MB body rejected with 413': (r) => r.status === 413 });

  for (let i = 0; i < 10; i++) {
    const r = hit('POST', '/api/items', '{"broken', { headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `bad-${i}` } });
    if (i === 0) console.log(`malformed JSON -> ${r.status} attempts=${r.headers['X-Omni-Attempts']} ${String(r.body).slice(0, 120)}`);
    check(r, { 'malformed JSON gets a 4xx, not a 5xx': (x) => x.status >= 400 && x.status < 500 });
  }

  let ok = 0;
  const servedBy = {};
  for (let i = 0; i < 100; i++) {
    const r = hit('GET', '/api/data');
    if (r.status === 200) ok++;
    servedBy[`${r.headers['X-Omni-Node']}/attempts=${r.headers['X-Omni-Attempts']}`] = (servedBy[`${r.headers['X-Omni-Node']}/attempts=${r.headers['X-Omni-Attempts']}`] || 0) + 1;
  }
  console.log(`reads after attack: ${JSON.stringify(servedBy)}`);
  check(ok, { 'normal reads still all succeed after the attack': (n) => n === 100 });
}

export function profiles() {
  const user = Math.random() < 0.5 ? 'alice' : 'bob';
  const res = hit('GET', '/api/me', null, { headers: { Authorization: `Bearer ${user}` } });
  if (res.status !== 200 || res.json('user') !== user) wrongUser.add(1);
  const cc = (res.headers['Cache-Control'] || '').toLowerCase();
  const vary = (res.headers['Vary'] || '').toLowerCase();
  // A CDN rule like "cache everything" must still be told this response is per-user
  cdnCacheable.add(!(cc.includes('private') || cc.includes('no-store')) || !vary.includes('authorization'));
}
