import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { parseOmniMeshConfigYaml } from '@omnimesh/core';
import { loadState, readDotEnv } from '../up/orchestrate.js';
import { realDeps, type Deps } from '../up/http.js';

export interface ChaosOptions {
  cwd?: string;
  /** How long the server stays paused (the test resumes it as soon as it is done) */
  seconds?: number;
  /** Where the router is and the sign-in key; read from the project folder when left out */
  routerUrl?: string;
  token?: string;
  deps?: Deps;
  /** How long to wait for every router instance to stop sending to the paused server */
  switchTimeoutMs?: number;
}

export interface ChaosResult {
  ok: boolean;
  /** Plain-language verdict, also printed */
  summary: string;
  pool?: string;
  paused?: string;
  answeredBy?: Record<string, number>;
}

interface Answer {
  status: number;
  node: string | null;
  attempts: number;
  ms: number;
}

const SAMPLES = 10;

function locate(cwd: string): string | null {
  const state = loadState(cwd);
  if (state) return state.router.url;
  try {
    const config = parseOmniMeshConfigYaml(fs.readFileSync(path.join(cwd, 'omnimesh.config.yaml'), 'utf-8'));
    return `https://${config.domain}`;
  } catch {
    return null;
  }
}

/** The path used for test requests: the server's health path when it belongs to this pool, else the pool itself. */
function testPath(prefix: string, healthPath: string | null): string {
  if (healthPath && (prefix === '/' || healthPath === prefix || healthPath.startsWith(`${prefix.replace(/\/$/, '')}/`))) return healthPath;
  return prefix;
}

const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
const tally = (answers: Answer[]) =>
  answers.reduce<Record<string, number>>((acc, a) => ((acc[a.node ?? 'none'] = (acc[a.node ?? 'none'] ?? 0) + 1), acc), {});

/**
 * `omnimesh chaos`: a real failover test on your own deployment. It pauses the server that is
 * answering, sends real requests through your router, shows which cloud took over, and then
 * puts the server back. Nothing is switched off: the pause only tells the router to skip it.
 */
export async function runChaos(options: ChaosOptions = {}): Promise<ChaosResult> {
  const cwd = options.cwd || process.cwd();
  const deps = options.deps ?? realDeps((m) => console.log(m));
  const log = deps.log;
  const seconds = options.seconds ?? 60;
  const fail = (summary: string, extra: Partial<ChaosResult> = {}): ChaosResult => {
    log(pc.red(`✖ ${summary}`));
    return { ok: false, summary, ...extra };
  };

  const routerUrl = (options.routerUrl ?? locate(cwd))?.replace(/\/$/, '');
  if (!routerUrl) return fail('No deployment found in this folder. Run omnimesh up here first (or cd into your project folder).');
  const token = options.token ?? readDotEnv(cwd).OMNIMESH_STATUS_TOKEN ?? process.env.OMNIMESH_STATUS_TOKEN;
  if (!token) return fail('OMNIMESH_STATUS_TOKEN is missing from .env. Run omnimesh token --rotate to create a new sign-in key.');
  const auth = { Authorization: `Bearer ${token}` };

  log(pc.bold(`\nFailover test on ${routerUrl}`));
  log(pc.dim('This pauses one of your servers for a moment and checks that another cloud answers instead. Your users stay served.\n'));

  let status: any;
  try {
    const res = await deps.fetch(`${routerUrl}/_omnimesh/status`, { headers: auth, signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) return fail('The router did not accept the sign-in key. Run omnimesh token --rotate, then try again.');
    if (!res.ok) return fail(`The router answered ${res.status} to the status request.`);
    status = await res.json();
  } catch (e) {
    return fail(`Could not reach your router (${(e as Error).message}).`);
  }

  const pools: any[] = status.pools ?? [];
  const pool = [...pools].sort((a, b) => Number(b.isDefault) - Number(a.isDefault)).find((p) => p.nodes.length >= 2);
  if (!pool) return fail('Every route has only one server, so there is nothing to fail over to. Connect a second cloud with omnimesh up.');
  const labels: string[] = pool.nodes.map((n: any) => n.label);
  const target = testPath(pool.prefix, pool.nodes[0].healthPath ?? null);

  const ask = async (): Promise<Answer> => {
    const started = Date.now();
    try {
      const res = await deps.fetch(`${routerUrl}${target}`, { signal: AbortSignal.timeout(30_000) });
      await res.body?.cancel().catch(() => {});
      return { status: res.status, node: res.headers.get('x-omni-node'), attempts: Number(res.headers.get('x-omni-attempts') ?? 0), ms: Date.now() - started };
    } catch {
      return { status: 0, node: null, attempts: 0, ms: Date.now() - started };
    }
  };

  // 1. Who answers now
  const before: Answer[] = [];
  for (let i = 0; i < 3; i++) before.push(await ask());
  const served = before.filter((a) => a.status > 0 && a.status < 500 && a.node && labels.includes(a.node));
  if (served.length === 0) {
    const seen = before.map((a) => (a.status ? String(a.status) : 'no answer')).join(', ');
    return fail(`Your app is not answering through the router right now (got ${seen} on ${target}). Fix that first: open the dashboard to see which servers are down.`);
  }
  const counts = tally(served);
  const paused = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  log(`1. Your app is answering on ${pc.bold(target)}: ${served.length} of ${before.length} requests, served by ${pc.bold(paused)} (avg ${avg(served.map((a) => a.ms))} ms)`);

  // 2. Pause it
  const action = (name: 'pause' | 'resume', body: Record<string, unknown>) =>
    deps.fetch(`${routerUrl}/_omnimesh/actions/${name}`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pool: pool.prefix, node: paused, ...body }),
      signal: AbortSignal.timeout(15_000),
    });
  const pauseRes = await action('pause', { seconds });
  const pauseBody: any = await pauseRes.json().catch(() => ({}));
  if (!pauseRes.ok) {
    if (pauseRes.status === 409) return fail(`Failover would not work right now. ${pauseBody.error ?? ''}`.trim(), { pool: pool.prefix, paused });
    return fail(`The router refused the pause (${pauseRes.status}: ${pauseBody.error ?? 'no reason given'}).`);
  }
  let resumed = false;
  const resume = async () => {
    if (resumed) return;
    resumed = true;
    try {
      const res = await action('resume', {});
      log(res.ok ? `4. ${pc.bold(paused)} is back in service` : pc.yellow(`! Could not resume ${paused} (${res.status}); the pause ends by itself in ${seconds} s.`));
    } catch {
      log(pc.yellow(`! Could not reach the router to resume ${paused}; the pause ends by itself in ${seconds} s.`));
    }
  };
  const onInterrupt = () => void resume().finally(() => process.exit(130));
  process.once('SIGINT', onInterrupt);
  log(`2. Paused ${pc.bold(paused)} for up to ${seconds} s${pauseBody.shared === false ? pc.yellow(' (only on one router instance: the shared store did not answer)') : ''}`);

  try {
    // 3. Wait until the router sends traffic elsewhere. Other router instances learn about the
    // pause within seconds, so a few early answers may still come from the paused server.
    const switchStarted = Date.now();
    const deadline = switchStarted + (options.switchTimeoutMs ?? 45_000);
    let first: Answer | null = null;
    let fallback: Answer | null = null;
    while (Date.now() < deadline) {
      const a = await ask();
      if (a.node && a.node !== paused && a.status > 0 && a.status < 500) {
        first = a;
        break;
      }
      // The paused server answering after others were tried means no other server could
      if (a.node === paused && a.attempts > 1) fallback = a;
      if (a.status === 0 || a.status >= 500) fallback = a;
      await deps.sleep(1000);
    }
    if (!first) {
      const why = fallback
        ? fallback.node === paused
          ? `no other server could answer, so the router had to use ${paused} anyway`
          : `requests failed (${fallback.status || 'no answer'}) while ${paused} was paused`
        : `the router kept sending requests to ${paused}; its other instances may not have heard about the pause yet`;
      return fail(`Failover did not work: ${why}. Open the dashboard to see what is wrong with the other servers.`, { pool: pool.prefix, paused });
    }
    const tookMs = Date.now() - switchStarted;

    const during: Answer[] = [first];
    while (during.length < SAMPLES) during.push(await ask());
    const good = during.filter((a) => a.status > 0 && a.status < 500 && a.node !== paused);
    const answeredBy = tally(during);
    const others = Object.keys(answeredBy).filter((n) => n !== paused && n !== 'none');
    log(
      `3. ${pc.bold(others.join(' and '))} took over after ${(tookMs / 1000).toFixed(1)} s: ${good.length} of ${during.length} requests answered (avg ${avg(good.map((a) => a.ms))} ms)`
    );

    await resume();
    if (good.length < during.length) {
      const bad = during.filter((a) => !good.includes(a)).map((a) => (a.node === paused ? `${paused} again` : a.status || 'no answer'));
      return fail(`Failover only partly worked: ${during.length - good.length} of ${during.length} requests were not answered by another server (${bad.join(', ')}).`, {
        pool: pool.prefix,
        paused,
        answeredBy,
      });
    }
    const summary = `Failover works. If ${paused} goes down, your users are moved to ${others.join(' and ')} without errors.`;
    log(pc.green(`\n✔ ${summary}\n`));
    return { ok: true, summary, pool: pool.prefix, paused, answeredBy };
  } finally {
    await resume();
    process.removeListener('SIGINT', onInterrupt);
  }
}
