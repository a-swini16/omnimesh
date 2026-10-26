import type { Deps } from '../src/up/http.js';

/** A fake cloud: GitHub, Koyeb, Render and Cloudflare APIs plus the deployed router, all in memory. */
export interface MockCloudOptions {
  renderBroken?: boolean;
  privateRepo?: boolean;
  noSubdomain?: boolean;
  cronLimit?: boolean;
  /** Oracle availability domains that still have free Arm capacity (default: all) */
  oracleCapacity?: string[];
  /** Arm OCPUs already used by other servers in the tenancy */
  oracleUsedOcpus?: number;
  /** State of an Oracle server created earlier */
  oracleInstanceState?: string;
  /** Its metadata; without an "omnimesh" key it was made by an older OmniMesh */
  oracleMetadata?: Record<string, string>;
  /** The hostname already has a DNS record pointing elsewhere */
  dnsTaken?: boolean;
  /** The hostname already points at our tunnel (a redeploy) */
  dnsOurs?: boolean;
  /** Base64 public key GitHub would hand out for encrypting secrets */
  githubPublicKey?: string;
  /** Health check path set on the Render service */
  renderHealthPath?: string;
}

const ADS = ['Uocm:US-ASHBURN-AD-1', 'Uocm:US-ASHBURN-AD-2', 'Uocm:US-ASHBURN-AD-3'];

/** A fake cloud: GitHub, Koyeb, Render, Cloudflare and Oracle APIs plus the deployed router, all in memory. */
export function mockCloud(opts: MockCloudOptions = {}) {
  const calls: Array<{ method: string; url: string; body: any; headers: Headers }> = [];
  let koyebPolls = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    let body: any = null;
    if (init.body instanceof FormData) {
      body = { metadata: JSON.parse(await (init.body.get('metadata') as Blob).text()), script: await (init.body.get('worker.js') as Blob).text() };
    } else if (typeof init.body === 'string') body = init.body ? JSON.parse(init.body) : '';
    calls.push({ method, url, body, headers: new Headers(init.headers) });
    const u = new URL(url);
    const p = u.pathname;

    if (u.host === 'api.github.com') {
      if (p === '/repos/me/shop-api') return json({ private: Boolean(opts.privateRepo), default_branch: 'main' });
      if (p === '/repos/me/shop-api/contents' || p === '/repos/me/shop-api/contents/services/auth') return json([{ name: 'package.json' }, { name: 'src' }]);
      if (p === '/repos/me/shop-api/contents/package.json' || p === '/repos/me/shop-api/contents/services/auth/package.json')
        return json({ content: Buffer.from(JSON.stringify({ scripts: { build: 'tsc', start: 'node dist/server.js' } })).toString('base64') });
      return json({ message: 'Not Found' }, 404);
    }
    if (u.host === 'koyeb.test') {
      if (method === 'POST' && p === '/v1/apps') return json({ app: { id: 'app1', domains: [{ name: 'om-shop-api-me.koyeb.app', type: 'AUTOASSIGNED' }] } });
      if (method === 'POST' && p === '/v1/services') return json({ service: { id: 'ksvc1', status: 'STARTING' } });
      if (method === 'POST' && p === '/v1/services/ksvc1/redeploy') return json({});
      if (method === 'PUT' && p === '/v1/services/ksvc1') return json({ service: { id: 'ksvc1', status: 'STARTING' } });
      if (method === 'GET' && p === '/v1/services/ksvc1') return json({ service: { id: 'ksvc1', status: ++koyebPolls > 1 ? 'HEALTHY' : 'STARTING' } });
    }
    if (u.host === 'render.test') {
      if (opts.renderBroken) return json({ message: 'unauthorized' }, 401);
      if (p === '/v1/owners') return json([{ owner: { id: 'own1' } }]);
      if (method === 'POST' && p === '/v1/services') {
        // Each new Render service gets its own id and address (the first one is rsvc1, as before)
        const n = calls.filter((c) => c.method === 'POST' && c.url === 'https://render.test/v1/services').length;
        return json({ service: { id: n === 1 ? 'rsvc1' : `rsvc${n}`, serviceDetails: { url: `https://${body.name}.onrender.com` } }, deployId: 'dep1' });
      }
      if (method === 'POST' && /^\/v1\/services\/rsvc\d+\/deploys$/.test(p)) return json({ id: 'dep2' });
      if (method === 'GET' && /^\/v1\/services\/rsvc\d+$/.test(p)) return json({ id: 'rsvc1', serviceDetails: { healthCheckPath: opts.renderHealthPath ?? '' } });
      if (method === 'PATCH' && /^\/v1\/services\/rsvc\d+$/.test(p)) return json({ id: 'rsvc1' });
      if ((method === 'PUT' || method === 'DELETE') && /^\/v1\/services\/rsvc\d+\/env-vars\//.test(p)) return json({ key: decodeURIComponent(p.split('/').pop()!), value: body.value });
      if (method === 'GET' && /^\/v1\/services\/rsvc\d+\/deploys\//.test(p)) return json({ status: 'live' });
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
    if (u.host === 'cloudflare.test') {
      const cf = (result: unknown) => json({ success: true, result });
      if (method === 'GET' && p === '/zones') return cf(u.searchParams.get('name') === 'example.com' ? [{ id: 'zone1' }] : []);
      if (method === 'GET' && p === '/accounts/acc1/cfd_tunnel') return cf(calls.some((c) => c.method === 'POST' && c.url.endsWith('/cfd_tunnel')) ? [{ id: 'tun1' }] : []);
      if (method === 'GET' && p === '/zones/zone1/dns_records' && opts.dnsOurs) return cf([{ id: 'r1', type: 'CNAME', content: 'tun1.cfargotunnel.com' }]);
      if (method === 'POST' && p === '/accounts/acc1/cfd_tunnel') return cf({ id: 'tun1', name: body.name });
      if (method === 'PUT' && p === '/accounts/acc1/cfd_tunnel/tun1/configurations') return cf({});
      if (method === 'GET' && p === '/zones/zone1/dns_records') return cf(opts.dnsTaken ? [{ id: 'r1', type: 'A', content: '203.0.113.7' }] : []);
      if (method === 'POST' && p === '/zones/zone1/dns_records') return cf({ id: 'r2' });
      if (method === 'GET' && p === '/accounts/acc1/cfd_tunnel/tun1/token') return cf('tunnel-token-xyz');
    }
    if (u.host === 'oracle.test') {
      const oci = p.replace(/^\/(iaas|identity)\/20160918/, '');
      if (oci.endsWith('/regionSubscriptions')) return json([{ regionName: 'eu-frankfurt-1', isHomeRegion: false }, { regionName: 'us-ashburn-1', isHomeRegion: true }]);
      if (oci === '/availabilityDomains') return json(ADS.map((name) => ({ name })));
      if (method === 'GET' && oci === '/instances') {
        return json(opts.oracleUsedOcpus ? [{ displayName: 'my-other-vm', shape: 'VM.Standard.A1.Flex', lifecycleState: 'RUNNING', shapeConfig: { ocpus: opts.oracleUsedOcpus } }] : []);
      }
      if (method === 'GET' && oci === '/vcns') return json([]);
      if (method === 'POST' && oci === '/vcns') return json({ id: 'vcn1', lifecycleState: 'PROVISIONING', defaultRouteTableId: 'rt1', defaultSecurityListId: 'sl1' });
      if (method === 'GET' && oci === '/vcns/vcn1') return json({ id: 'vcn1', lifecycleState: 'AVAILABLE', defaultRouteTableId: 'rt1', defaultSecurityListId: 'sl1' });
      if (method === 'GET' && (oci === '/internetGateways' || oci === '/subnets')) return json([]);
      if (method === 'POST' && oci === '/internetGateways') return json({ id: 'igw1' });
      if (method === 'PUT' && (oci === '/routeTables/rt1' || oci === '/securityLists/sl1')) return json({});
      if (method === 'POST' && oci === '/subnets') return json({ id: 'sub1' });
      if (method === 'GET' && oci === '/subnets/sub1') return json({ id: 'sub1', lifecycleState: 'AVAILABLE' });
      if (method === 'GET' && oci === '/images') {
        return json([{ id: 'img-min', displayName: 'Canonical-Ubuntu-24.04-Minimal-aarch64-2026.09.18-0' }, { id: 'img1', displayName: 'Canonical-Ubuntu-24.04-aarch64-2026.09.18-0' }]);
      }
      const deleted = calls.some((c) => c.method === 'DELETE' && c.url.includes('/instances/inst1'));
      if (method === 'POST' && oci === '/instances') {
        const capacity = opts.oracleCapacity ?? ADS;
        if (!capacity.includes(body.availabilityDomain)) return json({ code: 'InternalError', message: 'Out of host capacity.' }, 500);
        // After the old server was deleted, the new one gets a new id
        return json({ id: deleted ? 'inst2' : 'inst1', lifecycleState: 'PROVISIONING' });
      }
      if (method === 'GET' && oci.startsWith('/instances/')) {
        const old = oci.startsWith('/instances/inst1');
        return json({ id: old ? 'inst1' : 'inst2', lifecycleState: old && deleted ? 'TERMINATED' : old ? opts.oracleInstanceState ?? 'RUNNING' : 'RUNNING', metadata: opts.oracleMetadata ?? { user_data: 'dXNlcg==', omnimesh: '{}' } });
      }
      if (method === 'POST' && oci.startsWith('/instances/')) return json({ id: 'inst1', lifecycleState: 'STARTING' });
      if ((method === 'PUT' || method === 'DELETE') && oci.startsWith('/instances/')) return json({ id: 'inst1' });
    }
    if (u.host.endsWith('.example.com') && u.host.startsWith('oracle')) return json({ ok: true });
    if (u.host === 'github.test') {
      if (method === 'GET' && p === '/repos/me/shop-api/actions/secrets/public-key') return json({ key_id: 'k1', key: opts.githubPublicKey ?? '' });
      if (method === 'PUT' && p.startsWith('/repos/me/shop-api/actions/secrets/')) return new Response(null, { status: 201 });
      if (method === 'GET' && p.startsWith('/repos/me/shop-api/contents/')) return json({ message: 'Not Found' }, 404);
      if (method === 'PUT' && p.startsWith('/repos/me/shop-api/contents/')) return json({ content: {} }, 201);
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

