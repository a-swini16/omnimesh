export interface KeepAliveOptions {
  targets: string[];
  gatewaySecret?: string;
  timeoutMs?: number;
}

/**
 * Pings configured targets (Render, Koyeb, etc.) to keep them awake
 * and resident in memory.
 */
export async function runKeepAlive(options: KeepAliveOptions): Promise<Record<string, boolean>> {
  const { targets, gatewaySecret, timeoutMs = 5000 } = options;
  const results: Record<string, boolean> = {};

  await Promise.allSettled(
    targets.map(async (url) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const headers: Record<string, string> = {
          'User-Agent': 'OmniMesh-KeepAlive/1.0',
        };
        if (gatewaySecret) {
          headers['X-Gateway-Secret'] = gatewaySecret;
        }

        const res = await fetch(url, {
          method: 'GET',
          headers,
          signal: controller.signal,
        });

        results[url] = res.ok;
      } catch {
        results[url] = false;
      } finally {
        clearTimeout(timeoutId);
      }
    })
  );

  return results;
}
