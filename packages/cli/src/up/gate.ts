import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RepoInfo } from './detect.js';

const GATE_SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'gate', 'gate.cjs');

/**
 * The gate travels as an environment variable (base64, so no shell or YAML can mangle it) and the start
 * command decodes and runs it. Nothing is downloaded at build or start time, and the app's code is untouched.
 */
export function gateEnv(): { OMNIMESH_GATE: string } {
  return { OMNIMESH_GATE: fs.readFileSync(GATE_SOURCE).toString('base64') };
}

/** Wrap the app's start command: the gate runs it on a private port and guards the public one. */
export function gateStartCommand(startCommand: string): string {
  return `node -e "eval(Buffer.from(process.env.OMNIMESH_GATE,'base64').toString())" ${startCommand}`;
}

/** The gate needs Node.js next to the app: native Node apps always have it; Docker and Python images may not. */
export function canGate(repo: RepoInfo): boolean {
  return repo.runtime === 'node';
}
