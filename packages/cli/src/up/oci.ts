import crypto from 'node:crypto';
import { CloudApiError, type Deps } from './http.js';

/** What Oracle shows under Profile → API keys → "Configuration file preview", plus the downloaded private key. */
export interface OciCredentials {
  tenancy: string;
  user: string;
  fingerprint: string;
  region: string;
  privateKey: string;
}

const OCID = (kind: string) => new RegExp(`^ocid1\\.${kind}\\.oc1\\.\\.[a-z0-9]+$`);

/** Read the config preview text and the .pem key; explain in plain words what is missing. */
export function parseOciCredentials(configText: string, privateKeyPem: string): OciCredentials {
  const get = (k: string) => configText.match(new RegExp(`^\\s*${k}\\s*=\\s*(\\S+)`, 'm'))?.[1] ?? '';
  const creds = { tenancy: get('tenancy'), user: get('user'), fingerprint: get('fingerprint').toLowerCase(), region: get('region') };
  if (!OCID('tenancy').test(creds.tenancy)) throw new Error('Oracle: the configuration text has no valid "tenancy=ocid1.tenancy.oc1..." line. Paste the whole "Configuration file preview".');
  if (!OCID('user').test(creds.user)) throw new Error('Oracle: the configuration text has no valid "user=ocid1.user.oc1..." line.');
  if (!/^([0-9a-f]{2}:){15}[0-9a-f]{2}$/.test(creds.fingerprint)) throw new Error('Oracle: the configuration text has no valid "fingerprint=" line.');
  if (!/^[a-z]{2}-[a-z]+-\d+$/.test(creds.region)) throw new Error('Oracle: the configuration text has no valid "region=" line (for example us-ashburn-1).');
  // Oracle's downloaded key files can carry an extra "OCI_API_KEY" line after the key
  const pem = privateKeyPem.match(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/)?.[0];
  if (!pem) throw new Error('Oracle: paste the private key file you downloaded when adding the API key (it starts with -----BEGIN PRIVATE KEY-----).');
  let key: crypto.KeyObject;
  try {
    key = crypto.createPrivateKey(pem);
  } catch {
    throw new Error('Oracle: that private key could not be read. Use the unencrypted .pem file Oracle let you download.');
  }
  if (key.asymmetricKeyType !== 'rsa') throw new Error('Oracle: API keys must be RSA keys.');
  return { ...creds, privateKey: pem };
}

/**
 * Oracle request signing (signature version 1, rsa-sha256). Signs date, (request-target) and host, plus
 * x-content-sha256, content-type and content-length for requests with a body, as Oracle's own SDK does.
 * https://docs.oracle.com/en-us/iaas/Content/API/Concepts/signingrequests.htm
 */
export function ociSignedHeaders(creds: OciCredentials, method: string, url: URL, body: string | null, date = new Date().toUTCString()): Record<string, string> {
  const lower = method.toLowerCase();
  // fetch derives Host from the URL, so it is signed but not set here
  const headers: Record<string, string> = { date };
  const signed: Array<[string, string]> = [
    ['date', date],
    ['(request-target)', `${lower} ${url.pathname}${url.search}`],
    ['host', url.host],
  ];
  if (lower === 'post' || lower === 'put' || lower === 'patch') {
    const text = body ?? '';
    const sha = crypto.createHash('sha256').update(text).digest('base64');
    headers['content-type'] = 'application/json';
    headers['x-content-sha256'] = sha;
    // fetch sends this length itself for a string body; it is signed here so Oracle can check it
    signed.push(['content-length', String(Buffer.byteLength(text))], ['content-type', 'application/json'], ['x-content-sha256', sha]);
  }
  const signingString = signed.map(([k, v]) => `${k}: ${v}`).join('\n');
  const signature = crypto.sign('sha256', Buffer.from(signingString), creds.privateKey).toString('base64');
  const keyId = `${creds.tenancy}/${creds.user}/${creds.fingerprint}`;
  headers.authorization =
    `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",headers="${signed.map(([k]) => k).join(' ')}",signature="${signature}"`;
  return headers;
}

export type OciService = 'iaas' | 'identity';

/** Oracle's endpoints for the commercial realm (oc1), as in Oracle's SDKs. */
export function ociHost(service: OciService, region: string): string {
  return service === 'iaas' ? `iaas.${region}.oraclecloud.com` : `identity.${region}.oci.oraclecloud.com`;
}

export interface OciCall {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Override the region (Always Free works only in the home region) */
  region?: string;
}

/** A signed JSON client. Errors carry Oracle's own message, never the key. */
export function ociClient(deps: Deps, creds: OciCredentials, baseOverride?: string) {
  return async function oci<T = any>(service: OciService, method: string, path: string, call: OciCall = {}): Promise<{ data: T; nextPage: string | null }> {
    const origin = baseOverride ? `${baseOverride}/${service}` : `https://${ociHost(service, call.region ?? creds.region)}`;
    const url = new URL(`${origin}/20160918${path}`);
    for (const [k, v] of Object.entries(call.query ?? {})) if (v !== undefined) url.searchParams.append(k, String(v));
    const body = call.body === undefined ? (method === 'GET' ? null : '') : JSON.stringify(call.body);
    const res = await deps.fetch(url.toString(), {
      method,
      headers: ociSignedHeaders(creds, method, url, body),
      body: body === null ? undefined : body,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { message: text.slice(0, 300) };
    }
    if (!res.ok) {
      const hint = res.status === 401 ? ' (check the configuration text, the private key, and that the key is added to this user)' : '';
      throw new CloudApiError('Oracle', res.status, `${data?.message || res.statusText}${hint}`);
    }
    return { data: data as T, nextPage: res.headers.get('opc-next-page') };
  };
}

/** Every page of a list call. */
export async function ociList<T>(
  oci: ReturnType<typeof ociClient>,
  service: OciService,
  path: string,
  call: OciCall = {},
  maxPages = 10
): Promise<T[]> {
  const out: T[] = [];
  let page: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const { data, nextPage } = await oci<T[]>(service, 'GET', path, { ...call, query: { ...call.query, page } });
    out.push(...(data ?? []));
    if (!nextPage) break;
    page = nextPage;
  }
  return out;
}
