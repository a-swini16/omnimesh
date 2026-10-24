import { describe, it, expect, vi, afterEach } from 'vitest';
import { MemoryHealthStore } from '../src/health-store.js';

describe('[M-5] half-open circuit lets exactly one probe through', () => {
  afterEach(() => vi.restoreAllMocks());
  const at = (ms: number) => vi.spyOn(Date, 'now').mockReturnValue(ms);
  const URL = 'https://node-1.example.com';

  it('after the circuit TTL, only one caller probes; the rest keep skipping until it succeeds', async () => {
    const store = new MemoryHealthStore();
    at(0);
    await store.markNodeDead(URL, 'Timeout');
    at(31_000); // past the 30 s TTL

    expect(await store.isNodeHealthy(URL, 30_000)).toBe(true); // the probe
    expect(await store.isNodeHealthy(URL, 30_000)).toBe(false); // everyone else waits
    expect(await store.isNodeHealthy(URL, 30_000)).toBe(false);

    await store.markNodeHealthy(URL, 12); // probe succeeded: circuit closes
    expect(await store.isNodeHealthy(URL, 30_000)).toBe(true);
    expect(await store.isNodeHealthy(URL, 30_000)).toBe(true);
  });

  it('a failed probe re-opens the circuit for a full TTL; a lost probe frees the slot after 10 s', async () => {
    const store = new MemoryHealthStore();
    at(0);
    await store.markNodeDead(URL);
    at(31_000);
    expect(await store.isNodeHealthy(URL, 30_000)).toBe(true);
    await store.markNodeDead(URL, 'still down'); // probe failed
    at(40_000);
    expect(await store.isNodeHealthy(URL, 30_000)).toBe(false);

    at(62_000); // TTL passed again: new probe
    expect(await store.isNodeHealthy(URL, 30_000)).toBe(true);
    at(73_000); // that probe never reported back (e.g. not attempted): slot frees after 10 s
    expect(await store.isNodeHealthy(URL, 30_000)).toBe(true);
  });
});
