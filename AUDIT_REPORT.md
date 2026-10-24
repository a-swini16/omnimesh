# OmniMesh Audit Report

Scope: lean (decision D4 in [AUDIT_PLAN.md](AUDIT_PLAN.md)). Source of truth: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Status: **in progress.** The Critical issue and 4 of 6 High issues are fixed; load testing has not started.

| Severity | Found | Fixed | Open |
|---|---|---|---|
| Critical | 1 | 1 | 0 |
| High | 6 | 4 | 2 |
| Medium | 9 | 0 | 9 |
| Low | 4 | 0 | 4 |

**Is this safe for real users yet? Not yet.** Two High issues are open: rate limiting is not shared across router instances (H-4), and `omnimesh deploy` adapters report fake success (H-5). None of the load and chaos scenarios have been run against a mock mesh yet. Fixes from the two earlier hardening commits (`4b741e8`, `15fd726`) are listed at the end.

Tests: 52/52 pass; strict typecheck clean.

---

### [C-1] Failover retry could run a payment twice — CRITICAL
Area: node middleware | File: `packages/node/src/idempotency.ts` (`idempotency()` default store)
What happens: `idempotency()` defaulted to a per-process memory store, and every example used it. When node A writes but times out at the router, the retry lands on node B, which has never seen the key, so it runs the write again: a double charge.
How to reproduce: two Hono apps, each with `idempotency()` and no store; POST the same key to A, then to B, and both execute.
Fix: use Upstash automatically when `UPSTASH_REDIS_REST_*` is set; in production, refuse to start without a shared store.
Test: `packages/node/test/middleware.test.ts` › `[C-1]` (failed before the fix).
Status: FIXED in `d28ebdb`

### [H-1] Reused Idempotency-Key with a different body was silently replayed — HIGH
Area: node middleware | File: `packages/node/src/idempotency.ts`
What happens: a client that reused a key for a *new* order got the first order's response back. The new order was never created, but the client was told it succeeded.
Fix: store a SHA-256 of the request body with the response; on mismatch, answer `422 ERR_IDEMPOTENCY_KEY_REUSED`.
Test: `packages/node/test/middleware.test.ts` › `[H-1]` (failed before the fix).
Status: FIXED in `ede38a2`

### [H-2] Auth example accepted any password — HIGH
Area: examples | File: `examples/auth-service/src/index.ts`
What happens: `POST /auth/login` signed a 24-hour JWT for any email and password. Anyone deploying the example had no authentication.
Fix: new `src/app.ts`. bcrypt (cost 12) hashing; one generic error for unknown email and wrong password, with a dummy hash compare to equalize timing; lockout after 5 failures per IP **and** per account (stops spreading guesses across IPs); 15-minute tokens; input validation; a 10–72 character password rule (bcrypt only reads 72 bytes). Hashing runs on a compute node, not in the Worker.
Test: `examples/auth-service/test/auth.test.ts` (failed before the fix).
Status: FIXED in `68da0e6`. Remaining: counters are per process (see H-4), and there is no refresh-token or revocation flow yet.

### [H-3] Quickstart and CLI broken from a clean clone — HIGH
Area: CLI | Files: `packages/cli/bin/omnimesh.js`, `README.md`
What happens: the binary imported `../src/index.js`, which does not exist (sources are `.ts`, no build), so every command crashed with `ERR_MODULE_NOT_FOUND`. The README's `npx omnimesh` returns 404 because the package is unpublished, and anyone could register that name and get README users to run their code.
Fix: the binary loads the sources through `tsx`; the README explains how to run from a clone until the package is published.
Test: `packages/cli/test/cli.test.ts` › `[H-3]` spawns the real binary (failed before the fix).
Status: FIXED in `7380144`. Remaining: choose and publish an npm name you control (decision D5).

### [H-4] Rate limiting not shared across router instances — HIGH
Area: router | File: `packages/router/src/rate-limiter.ts`
What happens: `MemoryRateLimiter` counts per isolate. Cloudflare runs many isolates, so a distributed bot gets roughly limit × isolates. There is no per-user limit.
Plan: wire the Cloudflare rate-limit binding (shared, free-plan friendly) in an example `wrangler.toml` and make it the documented default; add per-user keys. Upstash per request would burn its 10k/day command quota.
Status: OPEN

### [H-5] Provider adapters report deploys and usage that never happened — HIGH
Area: providers | Files: `packages/providers/src/*/index.ts`
What happens: `deploy()` returns `success: true` without calling any API; `getUsage()` returns hardcoded numbers.
Plan: make `deploy()` say plainly that deployment happens through each provider's GitHub integration (architecture v1 §5.3), and remove the fake usage numbers.
Status: OPEN

---

## Medium and Low (open)

M-1 `Location` header leaks backend URLs · M-2 no gateway-secret rotation · M-3 unmatched paths fall through to `/api` · M-4 JWT has no `iss`/`aud` and `exp` is optional · M-5 no single-probe half-open circuit · M-6 config accepts empty pools and duplicate prefixes · M-7 `init` overwrites files and keep-alive is on by default · M-8 unpinned `cloudflared:latest` · M-9 cross-user cache test not written yet · L-1 k6 fallback secret · L-2 no root `.env.example` · L-3 `any` casts in request paths · L-4 unreproduced README benchmark numbers. Details in [AUDIT_PLAN.md §4](AUDIT_PLAN.md).

## Fixed earlier on this branch (`4b741e8`, `15fd726`)

Secrets written to the committed config and `.env.example` · backend URLs exposed in headers and errors · unauthenticated status page · idempotency failing open when Upstash is unconfigured, and keys not scoped per caller · non-constant-time secret compare · JWT `alg` not pinned · unbounded body buffering (memory DoS) · `/apiX` matching `/api` · spoofable forwarded headers · configured rate limit never enforced · router rebuilt on every request · KV write quota burned in minutes · credential validators passing tokens when offline · CI pnpm mismatch and no-op audit · weighted load balancing · failure-threshold circuit · quota-based switching. Each has tests in the router, node and CLI suites.

## Not yet run

Load-test scenarios (§6), measured failover time and capacity numbers, human walkthroughs (§7), OSS readiness (§8), and the independent subagent re-audit.
