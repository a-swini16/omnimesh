import type { Deps } from '../src/up/http.js';

/** A fake cloud: GitHub, Koyeb, Render and Cloudflare APIs plus the deployed router, all in memory. */
export function mockCloud(opts: { renderBroken?: boolean; privateRepo?: boolean; noSubdomain?: boolean; cronLimit?: boolean } = {}) {
  const calls: Array<{ method: string; url: string; body: any }> = [];
  let koyebPolls = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    let body: any = null;
    if (init.body instanceof FormData) {
      body = { metadata: JSON.parse(await (init.body.get('metadata') as Blob).text()), script: await (init.body.get('worker.js') as Blob).text() };
    } else if (typeof init.body === 'string') body = JSON.parse(init.body);
    calls.push({ method, url, body });
    const u = new URL(url);
    const p = u.pathname;

    if (u.host === 'api.github.com') {
      if (p === '/repos/me/shop-api') return json({ private: Boolean(opts.privateRepo), default_branch: 'main' });
      if (p === '/repos/me/shop-api/contents') return json([{ name: 'package.json' }, { name: 'src' }]);
      if (p === '/repos/me/shop-api/contents/package.json')
        return json({ content: Buffer.from(JSON.stringify({ scripts: { build: 'tsc', start: 'node dist/server.js' } })).toString('base64') });
      return json({ message: 'Not Found' }, 404);
    }
    if (u.host === 'koyeb.test') {
      if (method === 'POST' && p === '/v1/apps') return json({ app: { id: 'app1', domains: [{ name: 'om-shop-api-me.koyeb.app', type: 'AUTOASSIGNED' }] } });
      if (method === 'POST' && p === '/v1/services') return json({ service: { id: 'ksvc1', status: 'STARTING' } });
      if (method === 'POST' && p === '/v1/services/ksvc1/redeploy') return json({});
      if (method === 'GET' && p === '/v1/services/ksvc1') return json({ service: { id: 'ksvc1', status: ++koyebPolls > 1 ? 'HEALTHY' : 'STARTING' } });
    }
    if (u.host === 'render.test') {
      if (opts.renderBroken) return json({ message: 'unauthorized' }, 401);
      if (p === '/v1/owners') return json([{ owner: { id: 'own1' } }]);
      if (method === 'POST' && p === '/v1/services') return json({ service: { id: 'rsvc1', serviceDetails: { url: 'https://om-shop-api.onrender.com' } }, deployId: 'dep1' });
      if (method === 'POST' && p === '/v1/services/rsvc1/deploys') return json({ id: 'dep2' });
      if (method === 'GET' && p.startsWith('/v1/services/rsvc1/deploys/')) return json({ status: 'live' });
    }
    if (u.host === 'cloudflare.test') {
      if (p === '/accounts') return json({ success: true, result: [{ id: 'acc1' }] });
      if (method === 'GET' && p === '/accounts/acc1/storage/kv/namespaces') return json({ success: true, result: [] });
      if (method === 'POST' && p === '/accounts/acc1/storage/kv/namespaces') return json({ success: true, result: { id: 'kv1' } });
      if (method === 'PUT' && p === '/accounts/acc1/workers/scripts/om-shop-api') return json({ success: true, result: {} });
      if (method === 'POST' && p.endsWith('/subdomain')) return json({ success: true, result: {} });
      if (method === 'PUT' && p === '/accounts/acc1/workers/scripts/om-shop-api/schedules') {
        return opts.cronLimit
          ? json({ success: false, errors: [{ message: 'You have exceeded the limit of 5 cron triggers.' }] }, 400)
          : json({ success: true, result: { schedules: body } });
      }
      if (method === 'GET' && p === '/accounts/acc1/workers/subdomain') return opts.noSubdomain ? json({ success: false, errors: [{ message: 'no subdomain' }] }, 404) : json({ success: true, result: { subdomain: 'me' } });
    }
    if (u.host === 'om-shop-api.me.workers.dev') {
      if (p === '/_omnimesh/status') return json({ pools: [{ nodes: [{}, {}] }] });
      return json({ ok: true });
    }
    return json({ message: `unmocked ${method} ${url}` }, 500);
  };
  const deps: Deps = { fetch: fetchImpl as any, sleep: async () => {}, log: () => {} };
  return { deps, calls };
}

