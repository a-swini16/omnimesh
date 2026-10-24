import fs from 'node:fs';
import path from 'node:path';

/** Read KEY=value pairs from <cwd>/.env (process.env wins for keys set in both). */
export function readEnvFile(cwd: string): Record<string, string> {
  const env: Record<string, string> = {};
  const envPath = path.join(cwd, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
      const match = line.match(/^\s*([\w]+)\s*=\s*["']?(.*?)["']?\s*$/);
      if (match) env[match[1]] = match[2];
    }
  }
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  return env;
}

/** Every pool URL that is still a generated placeholder, as "pool -> url". */
export function placeholderNodes(pools: Record<string, unknown[]>, isPlaceholder: (u: string) => boolean): string[] {
  const out: string[] = [];
  for (const [poolPath, nodes] of Object.entries(pools)) {
    for (const n of nodes as any[]) {
      const url = typeof n === 'string' ? n : n.url;
      if (isPlaceholder(url)) out.push(`${poolPath} -> ${url}`);
    }
  }
  return out;
}
