import { callApi, type Deps } from './http.js';
import { CLOUDFLARE_API } from './cloudflare.js';

export interface TunnelInput {
  token: string;
  accountId: string;
  /** Tunnel name, reused on later runs */
  name: string;
  /** Public name for the server, on a domain already in this Cloudflare account, e.g. oracle.example.com */
  hostname: string;
  /** Where cloudflared forwards on the server */
  service: string;
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
  const hostname = input.hostname.trim().toLowerCase();
  if (!HOSTNAME.test(hostname)) throw new Error(`Cloudflare: "${input.hostname}" is not a valid server name. Use something like oracle.yourdomain.com.`);
  const auth = { Authorization: `Bearer ${input.token}` };
  const cf = (path: string, init: RequestInit & { json?: unknown } = {}) =>
    callApi(deps, 'Cloudflare', `${apiBase}${path}`, { ...init, headers: { ...auth, ...(init.headers as Record<string, string>) } }).then((b) => b.result);
  const acc = `/accounts/${input.accountId}`;

  // The zone is the longest suffix of the name that is a domain in this account
  const labels = hostname.split('.');
  let zoneId: string | undefined;
  for (let i = 1; i <= labels.length - 2 && !zoneId; i++) {
    const zones: Array<{ id: string }> = await cf(`/zones?name=${encodeURIComponent(labels.slice(i).join('.'))}`);
    zoneId = zones?.[0]?.id;
  }
  if (!zoneId) {
    throw new Error(`Cloudflare: ${hostname} is not under a domain in your Cloudflare account. Add your domain to Cloudflare first (free plan), then use a name under it.`);
  }

  deps.log('Cloudflare: preparing a private tunnel for the Oracle server');
  const existing: Array<{ id: string }> = await cf(`${acc}/cfd_tunnel?name=${encodeURIComponent(input.name)}&is_deleted=false`);
  const tunnelId: string = existing?.[0]?.id ?? (await cf(`${acc}/cfd_tunnel`, { method: 'POST', json: { name: input.name, config_src: 'cloudflare' } })).id;

  await cf(`${acc}/cfd_tunnel/${tunnelId}/configurations`, {
    method: 'PUT',
    json: { config: { ingress: [{ hostname, service: input.service, originRequest: {} }, { service: 'http_status:404' }] } },
  });

  // Point the name at the tunnel, but never take over a record that already serves something else
  const target = `${tunnelId}.cfargotunnel.com`;
  const records: Array<{ id: string; type: string; content: string }> = await cf(`/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}`);
  const record = records?.[0];
  if (!record) {
    await cf(`/zones/${zoneId}/dns_records`, { method: 'POST', json: { type: 'CNAME', name: hostname, content: target, proxied: true } });
  } else if (record.content !== target) {
    throw new Error(`Cloudflare: ${hostname} already has a ${record.type} record (${record.content}). Pick a name that is not in use yet, for example api-oracle.${labels.slice(1).join('.')}.`);
  }

  const tunnelToken: string = await cf(`${acc}/cfd_tunnel/${tunnelId}/token`);
  if (typeof tunnelToken !== 'string' || !tunnelToken) throw new Error('Cloudflare: the tunnel was created but no connection token came back.');
  return { tunnelId, tunnelToken };
}
