# OmniMesh Audit Report

Scope: lean (decision D4 in [AUDIT_PLAN.md](AUDIT_PLAN.md)). Source of truth: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Status: **in progress.** All Critical and High issues are fixed; Medium/Low and load testing are next.

| Severity | Found | Fixed | Open |
|---|---|---|---|
| Critical | 2 | 2 | 0 |
| High | 6 | 6 | 0 |
| Medium | 9 | 0 | 9 |
| Low | 4 | 0 | 4 |

**Is this safe for real users yet? Not yet.** Every known Critical and High issue is fixed and tested, but none of the load and chaos scenarios (§6) have been run against a mock mesh, 9 Medium issues are open, and no independent re-audit has happened. Fixes from the two earlier hardening commits (`4b741e8`, `15fd726`) are listed at the end.

Tests: 59/59 pass; strict typecheck clean.

---

### [C-1] Failover retry could run a payment twice — CRITICAL
Area: node middleware | File: `packages/node/src/idempotency.ts` (`idempotency()` default store)
What happens: `idempotency()` defaulted to a per-process memory store, and every example used it. When node A writes but times out at the router, the retry lands on node B, which has never seen the key, so it runs the write again: a double charge.
How to reproduce: two Hono apps, each with `idempotency()` and no store; POST the same key to A, then to B, and both execute.
Fix: use Upstash automatically when `UPSTASH_REDIS_REST_*` is set; in production, refuse to start without a shared store.
Test: `packages/node/test/middleware.test.ts` › `[C-1]` (failed before the fix).
Status: FIXED in `d28ebdb`

### [C-2] CLI sends the gateway secret to placeholder hosts owned by third parties — CRITICAL
Area: CLI | Files: `packages/core/src/config.ts` (`generateDefaultConfig` pools), `packages/cli/src/commands/status.ts`, `packages/cli/src/commands/deploy.ts`
What happens: `init` writes example pool URLs such as `https://core-api.koyeb.app` and `https://webhooks.netlify.app`. Those names can belong to anyone. `omnimesh status` and `omnimesh deploy` then send `X-Gateway-Secret` to every pool URL, so running them before editing the pools gives the secret to whoever owns those apps.
How to reproduce: `omnimesh init --no-card --quick`, then `omnimesh status` (not run during the audit, to avoid sending a secret to a third party).
The same leak existed in three more places: the default domain `api.yourdomain.com` (a real, registered domain) used by the generated keep-alive workflow, which sent `X-Gateway-Secret`; `add-provider`'s default `*.yourdomain.com` URL; and the default keep-alive targets.
Fix: every generated host now ends in `.replace-me.invalid`. The reserved `.invalid` TLD (RFC 2606) never resolves, so nobody can own it. `isPlaceholderUrl()` in core is enforced everywhere: the router refuses to start, `deploy` stops with a list of URLs to replace (exit code 1), `status` skips them, keep-alive never pings them, and `doctor` fails on each one. The keep-alive workflow no longer sends the secret at all (the router adds it when forwarding). `status` now reads `GATEWAY_SECRET` from `.env`; before, it sent an empty secret, so every node showed 403.
Test: `packages/cli/test/placeholder-secret.test.ts` (all 4 failed before the fix; fetch is mocked, so no request leaves the machine).
Status: FIXED in `3927b62`

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
Fix: the router limits per IP **and** per caller (a SHA-256 of the `Authorization` header, so raw tokens never reach the limiter). The Worker uses the shared Cloudflare `RATE_LIMITER` binding; `packages/router/wrangler.toml.example` configures it, and the Worker warns once when it is missing. Upstash was rejected: one command per request would use up its 10k/day free quota.
Test: `packages/router/test/worker-rate-limit.test.ts` (both failed before the fix).
Status: FIXED in `6d28df2`. Remaining: Cloudflare's binding counts per Cloudflare location, not globally; for one exact global limit, add a Cloudflare WAF rate-limit rule. The login lockout in the auth example is still per process.

### [H-5] Provider adapters report deploys and usage that never happened — HIGH
Area: providers | Files: `packages/providers/src/*/index.ts`
What happens: `deploy()` returns `success: true` without calling any API; `getUsage()` returns hardcoded numbers.
Fix: every adapter's `deploy()` throws `DeployNotAutomatedError` with the real path: Git auto-deploy (compute), `wrangler deploy` (Cloudflare router), `docker compose` (Oracle), or the dashboard (managed data services). The fake `getUsage()` numbers are removed. `omnimesh deploy` prints that guidance, then runs its real `/health` verification.
Test: `packages/providers/test/providers.test.ts` › `[H-5]` (failed before the fix).
Status: FIXED in `cd5ac89`. Remaining: real API deploys and the rollback described in architecture §9 are not implemented.

---

## Medium and Low (open)

M-1 `Location` header leaks backend URLs · M-2 no gateway-secret rotation · M-3 unmatched paths fall through to `/api` · M-4 JWT has no `iss`/`aud` and `exp` is optional · M-5 no single-probe half-open circuit · M-6 config accepts empty pools and duplicate prefixes · M-7 `init` overwrites files and keep-alive is on by default · M-8 unpinned `cloudflared:latest` · M-9 cross-user cache test not written yet · L-1 k6 fallback secret · L-2 no root `.env.example` · L-3 `any` casts in request paths · L-4 unreproduced README benchmark numbers. Details in [AUDIT_PLAN.md §4](AUDIT_PLAN.md).

## Fixed earlier on this branch (`4b741e8`, `15fd726`)

Secrets written to the committed config and `.env.example` · backend URLs exposed in headers and errors · unauthenticated status page · idempotency failing open when Upstash is unconfigured, and keys not scoped per caller · non-constant-time secret compare · JWT `alg` not pinned · unbounded body buffering (memory DoS) · `/apiX` matching `/api` · spoofable forwarded headers · configured rate limit never enforced · router rebuilt on every request · KV write quota burned in minutes · credential validators passing tokens when offline · CI pnpm mismatch and no-op audit · weighted load balancing · failure-threshold circuit · quota-based switching. Each has tests in the router, node and CLI suites.

## Not yet run

Load-test scenarios (§6), measured failover time and capacity numbers, human walkthroughs (§7), OSS readiness (§8), and the independent subagent re-audit.
