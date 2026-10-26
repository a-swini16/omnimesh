// OmniMesh watcher. GitHub Actions runs it every 10 minutes (.github/workflows/omnimesh-watch.yml).
// It asks your router to check every server, waits a minute, checks again, and restarts the servers
// that are still down through each cloud's own API. Written by `omnimesh up`; safe to edit or delete.
// No dependencies: it runs on the plain Node.js that GitHub provides.
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const env = process.env;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function need(name) {
  if (!env[name]) throw new Error(`the ${name} secret is missing in this repository (run omnimesh up again to add it)`);
  return env[name];
}

/** Ask the router to check every server now. It allows one check every 20 s, so wait and retry when asked. */
async function check(router) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${router}/_omnimesh/actions/check`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${need('OMNIMESH_STATUS_TOKEN')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'watcher' }),
      signal: AbortSignal.timeout(150_000),
    });
    if (res.status === 429) {
      await sleep((Number(res.headers.get('retry-after')) || 20) * 1000 + 500);
      continue;
    }
    if (res.status === 404) throw new Error('the router did not accept OMNIMESH_STATUS_TOKEN (run omnimesh up again to refresh the secret)');
    if (!res.ok) throw new Error(`the router answered ${res.status}`);
    return (await res.json()).nodes || {};
  }
  throw new Error('the router kept saying it had just checked');
}

async function call(url, init, cloud) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { message: text.slice(0, 200) };
  }
  if (!res.ok) throw new Error(`${cloud} answered ${res.status}: ${body.message || body.error || res.statusText}`);
  return body;
}

/** Oracle request signing, the same as Oracle's SDKs (date, (request-target), host; plus body headers). */
function oracle(method, region, path) {
  const url = new URL(`https://iaas.${region}.oraclecloud.com/20160918${path}`);
  const date = new Date().toUTCString();
  const headers = { date };
  const signed = [['date', date], ['(request-target)', `${method.toLowerCase()} ${url.pathname}${url.search}`], ['host', url.host]];
  const body = method === 'POST' ? '' : undefined;
  if (body !== undefined) {
    const sha = crypto.createHash('sha256').update(body).digest('base64');
    Object.assign(headers, { 'content-type': 'application/json', 'x-content-sha256': sha });
    signed.push(['content-length', '0'], ['content-type', 'application/json'], ['x-content-sha256', sha]);
  }
  const signature = crypto.sign('sha256', Buffer.from(signed.map(([k, v]) => `${k}: ${v}`).join('\n')), need('OCI_PRIVATE_KEY')).toString('base64');
  const keyId = `${need('OCI_TENANCY')}/${need('OCI_USER')}/${need('OCI_FINGERPRINT')}`;
  headers.authorization = `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",headers="${signed.map(([k]) => k).join(' ')}",signature="${signature}"`;
  return call(url.toString(), { method, headers, body }, 'Oracle');
}

/** Bring one server back with its cloud's own API. Returns what was done, in plain words. */
const HEAL = {
  async koyeb(s) {
    const auth = { Authorization: `Bearer ${need('KOYEB_API_TOKEN')}` };
    const base = `https://app.koyeb.com/v1/services/${s.serviceId}`;
    const { service } = await call(base, { headers: auth }, 'Koyeb');
    if (service.status === 'PAUSED') {
      await call(`${base}/resume`, { method: 'POST', headers: auth }, 'Koyeb');
      return 'was paused; resumed it';
    }
    if (['STARTING', 'RESUMING', 'PAUSING'].includes(service.status)) return `already ${service.status.toLowerCase()}`;
    if (['DELETING', 'DELETED'].includes(service.status)) throw new Error('the Koyeb service was deleted; run omnimesh up to create it again');
    // skip_build: start the last successful build again instead of rebuilding
    await call(`${base}/redeploy`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ skip_build: true }) }, 'Koyeb');
    return 'restarted (same build)';
  },
  async render(s) {
    await call(`https://api.render.com/v1/services/${s.serviceId}/restart`, { method: 'POST', headers: { Authorization: `Bearer ${need('RENDER_API_KEY')}` } }, 'Render');
    return 'restarted';
  },
  async oracle(s) {
    const { lifecycleState } = await oracle('GET', s.region, `/instances/${s.serviceId}`);
    if (lifecycleState === 'STOPPED') {
      // Oracle can stop Always Free servers it considers idle
      await oracle('POST', s.region, `/instances/${s.serviceId}?action=START`);
      return 'was stopped; started it';
    }
    if (lifecycleState === 'RUNNING') {
      await oracle('POST', s.region, `/instances/${s.serviceId}?action=SOFTRESET`);
      return 'was not answering; rebooted it';
    }
    if (lifecycleState === 'TERMINATED' || lifecycleState === 'TERMINATING') throw new Error('the Oracle server was deleted; run omnimesh up to create a new one');
    return `already ${lifecycleState.toLowerCase()}`;
  },
};

/** One watcher run. Returns how many servers stayed down and could not be brought back. */
export async function run(log = console.log) {
  const router = (env.OMNIMESH_ROUTER_URL || '').replace(/\/$/, '');
  const servers = JSON.parse(env.OMNIMESH_SERVERS || '[]');
  if (!router || !servers.length) throw new Error('OMNIMESH_ROUTER_URL or OMNIMESH_SERVERS is missing from the workflow');
  const first = await check(router);
  for (const s of servers) log(`${s.label}: ${first[s.url] ? first[s.url].state + (first[s.url].reason ? ` (${first[s.url].reason})` : '') : 'not checked (sleeps when idle; keep-awake is off)'}`);
  const down = servers.filter((s) => first[s.url]?.state === 'down');
  if (!down.length) return { failed: 0, healed: [] };

  // A slow wake-up or a short blip is not an outage: look again before restarting anything
  const wait = Number(env.OMNIMESH_RECHECK_SECONDS ?? 60);
  log(`Waiting ${wait} s, then checking again before restarting anything…`);
  await sleep(wait * 1000);
  const second = await check(router);
  let failed = 0;
  const healed = [];
  for (const s of down.filter((x) => second[x.url]?.state === 'down')) {
    try {
      log(`${s.label}: ${await HEAL[s.provider](s)}`);
      healed.push(s.label);
    } catch (e) {
      failed += 1;
      log(`::error::${s.label}: ${e.message}`);
    }
  }
  return { failed, healed };
}

// Run when GitHub starts this file (not when a test imports it)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().then(
    // A failed run makes GitHub email you, so you hear about servers the watcher could not fix
    (r) => {
      if (r.failed) process.exitCode = 1;
    },
    (e) => {
      console.log(`::error::${e.message}`);
      process.exitCode = 1;
    }
  );
}
