export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface Deps {
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
}

export class CloudApiError extends Error {
  constructor(public provider: string, public status: number, message: string) {
    super(`${provider}: ${message}`);
    this.name = 'CloudApiError';
  }
}

/** JSON request to a provider API. Errors carry the provider's own message, never the token. */
export async function callApi<T = any>(
  deps: Deps,
  provider: string,
  url: string,
  init: RequestInit & { json?: unknown } = {}
): Promise<T> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set('Content-Type', 'application/json');
  const res = await deps.fetch(url, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { message: text.slice(0, 300) };
  }
  if (!res.ok) {
    const detail =
      body?.message || body?.error || body?.errors?.[0]?.message || (typeof body === 'string' ? body : '') || res.statusText;
    const hint = res.status === 401 || res.status === 403 ? ' (check that the token is correct and has the needed permissions)' : '';
    throw new CloudApiError(provider, res.status, `${detail}${hint}`);
  }
  return body as T;
}

/** Poll until `check` returns a value or `timeoutMs` passes. */
export async function waitFor<T>(deps: Deps, check: () => Promise<T | null>, timeoutMs: number, everyMs = 5000): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await check();
    if (value !== null) return value;
    await deps.sleep(everyMs);
  }
  return null;
}

export const realDeps = (log: (m: string) => void): Deps => ({
  fetch: (url, init) => fetch(url, init),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log,
});
