import { callApi, type Deps } from './http.js';
import { CLOUDFLARE_API } from './cloudflare.js';

export interface TunnelInput {
  token: string;
  accountId: string;
  /** Tunnel name, reused on later runs */
  name: string;
  /** Public names on a domain already in this Cloudflare account (e.g. oracle.example.com), each with
   * where cloudflared forwards it on the server (e.g. http://localhost:8000) */
  routes: Array<{ hostname: string; service: string }>;
}

export interface TunnelResult {
  tunnelId: string;
  /** cloudflared needs this to connect; it is a secret */
  tunnelToken: string;
}

const HOSTNAME = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * A remotely managed Cloudflare Tunnel from the server to `hostname`: the server opens no ports at all;
 * cloudflared connects out to Cloudflare. Needs Account → Cloudflare Tunnel: Edit, Zone → Zone: Read and
 * Zone → DNS: Edit on the token.
 * https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/
 */
export async function ensureTunnel(deps: Deps, input: TunnelInput, apiBase = CLOUDFLARE_API): Promise<TunnelResult> {
  const routes = input.routes.map((r) => ({ ...r, hostname: r.hostname.trim().toLowerCase() }));
  for (const r of routes) {
    if (!HOSTNAME.test(r.hostname)) throw new Error(`Cloudflare: "${r.hostname}" is not a valid server name. Use something like oracle.yourdomain.com.`);
  }
  const auth = { Authorization: `Bearer ${input.token}` };
  const cf = (path: string, init: RequestInit & { json?: unknown } = {}) =>
    callApi(deps, 'Cloudflare', `${apiBase}${path}`, { ...init, headers: { ...auth, ...(init.headers as Record<string, string>) } }).then((b) => b.result);
  const acc = `/accounts/${input.accountId}`;

  // The zone is the longest suffix of the name that is a domain in this account
  const zoneOf = async (hostname: string) => {
    const labels = hostname.split('.');
    for (let i = 1; i <= labels.length - 2; i++) {
      const zones: Array<{ id: string }> = await cf(`/zones?name=${encodeURIComponent(labels.slice(i).join('.'))}`);
      if (zones?.[0]?.id) return zones[0].id;
    }
    throw new Error(`Cloudflare: ${hostname} is not under a domain in your Cloudflare account. Add your domain to Cloudflare first (free plan), then use a name under it.`);
  };
  const zones = new Map<string, string>();
  for (const r of routes) zones.set(r.hostname, await zoneOf(r.hostname));

  deps.log('Cloudflare: preparing a private tunnel for the Oracle server');
  const existing: Array<{ id: string }> = await cf(`${acc}/cfd_tunnel?name=${encodeURIComponent(input.name)}&is_deleted=false`);
  const tunnelId: string = existing?.[0]?.id ?? (await cf(`${acc}/cfd_tunnel`, { method: 'POST', json: { name: input.name, config_src: 'cloudflare' } })).id;

  // Point each name at the tunnel, but never take over a record that already serves something else.
  // All names are checked before any is changed.
  const target = `${tunnelId}.cfargotunnel.com`;
  const missing: string[] = [];
  for (const r of routes) {
    const records: Array<{ id: string; type: string; content: string }> = await cf(`/zones/${zones.get(r.hostname)}/dns_records?name=${encodeURIComponent(r.hostname)}`);
    const record = records?.[0];
    if (!record) missing.push(r.hostname);
    else if (record.content !== target) {
      throw new Error(`Cloudflare: ${r.hostname} already has a ${record.type} record (${record.content}). Pick a server name that is not in use yet.`);
    }
  }
  await cf(`${acc}/cfd_tunnel/${tunnelId}/configurations`, {
    method: 'PUT',
    json: { config: { ingress: [...routes.map((r) => ({ hostname: r.hostname, service: r.service, originRequest: {} })), { service: 'http_status:404' }] } },
  });
  for (const hostname of missing) {
    await cf(`/zones/${zones.get(hostname)}/dns_records`, { method: 'POST', json: { type: 'CNAME', name: hostname, content: target, proxied: true } });
  }

  const tunnelToken: string = await cf(`${acc}/cfd_tunnel/${tunnelId}/token`);
  if (typeof tunnelToken !== 'string' || !tunnelToken) throw new Error('Cloudflare: the tunnel was created but no connection token came back.');
  return { tunnelId, tunnelToken };
}
