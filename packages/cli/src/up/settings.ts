import fs from 'node:fs';
import path from 'node:path';

/** Names OmniMesh sets itself on every server; an app setting cannot replace them. */
const RESERVED = new Set(['PORT', 'GATEWAY_SECRET', 'GATEWAY_SECRET_PREVIOUS']);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SETTINGS_FILE = path.join('.omnimesh', 'app-settings.json');

/** Check one service's settings (environment variables) and say plainly what is wrong. */
export function checkAppSettings(settings: Record<string, unknown>, where = 'App settings'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(settings)) {
    if (!NAME.test(key)) throw new Error(`${where}: "${key}" is not a valid name. Use letters, digits and _, not starting with a digit.`);
    if (RESERVED.has(key) || key.startsWith('OMNIMESH_')) throw new Error(`${where}: ${key} is set by OmniMesh itself. Pick another name.`);
    const value = String(raw ?? '');
    if (/[\r\n]/.test(value)) throw new Error(`${where}: the value of ${key} has a line break. Put it on one line (write \\n where you need one).`);
    if (value.length > 4096) throw new Error(`${where}: the value of ${key} is longer than 4096 characters.`);
    out[key] = value;
  }
  if (Object.keys(out).length > 100) throw new Error(`${where}: more than 100 settings.`);
  return out;
}

/** Read settings pasted in .env style: KEY=value lines, # comments and blank lines ignored, optional quotes. */
export function parseAppSettings(text: string, where = 'App settings'): Record<string, string> {
  const out: Record<string, string> = {};
  text.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const m = t.match(/^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/);
    if (!m) throw new Error(`${where}, line ${i + 1}: write it as NAME=value.`);
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  });
  return checkAppSettings(out, where);
}

/** Saved settings per route, readable only by you and never committed (.omnimesh/ is git-ignored). */
export function loadAppSettings(cwd: string): Record<string, Record<string, string>> {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, SETTINGS_FILE), 'utf-8'));
  } catch {
    return {};
  }
}

export function saveAppSettings(cwd: string, byRoute: Record<string, Record<string, string>>): void {
  fs.mkdirSync(path.join(cwd, '.omnimesh'), { recursive: true });
  const file = path.join(cwd, SETTINGS_FILE);
  fs.writeFileSync(file, JSON.stringify(byRoute, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
