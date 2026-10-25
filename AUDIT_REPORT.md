# OmniMesh Audit Report

Scope: lean (decision D4 in [AUDIT_PLAN.md](AUDIT_PLAN.md)). Source of truth: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Status: **in progress.** Every known Critical, High and Medium issue is fixed with a test, and all 6 lean load scenarios pass. 4 Low issues and the independent re-audit are next.

| Severity | Found | Fixed | Open |
|---|---|---|---|
| Critical | 2 | 2 | 0 |
| High | 9 | 9 | 0 |
| Medium | 9 | 9 | 0 |
| Low | 4 | 0 | 4 |

**Is this safe for real users yet? Not yet, but the request path is in good shape.** Every known Critical, High and Medium issue is fixed with a test that failed before its fix, and all 6 lean load scenarios pass: 0 duplicate orders across 500 buyers, failover costing only the in-flight requests, clean outages within budget, quota switching with 0 errors, bad input rejected cleanly, and 0 cacheable private responses. Before launch: 9 of the 15 load scenarios have not run (including the 30-minute soak, database-down and Redis-down), an independent re-audit hasn't happened, 4 Low issues are open, and the npm package name is unpublished (D5).

Tests: 90/90 pass; strict typecheck clean.

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

### [H-6] No hard cap on request body size — HIGH
Area: router | File: `packages/router/src/dispatcher.ts` (`prepareBufferedRequest`)
What happens: bodies with a `Content-Length` above `maxBufferBytes` are streamed to the node with no upper limit. In `bad-input`, a 5 MB body went straight to the node, which crashed while parsing it, and the client got a misleading `503` saying to attach an Idempotency-Key. An attacker can push huge uploads at free-tier nodes, using up their bandwidth quota and memory.
How to reproduce: `benchmarks/mock-mesh/run.sh bad-input`
Fix: new `router.maxBodyBytes` (default 10 MB). A `Content-Length` over it gets `413 ERR_BODY_TOO_LARGE` before any node is contacted. Bodies without a length were already capped at `maxBufferBytes`.
Test: `packages/router/test/failover.test.ts` › `[H-6]` (failed before the fix); load scenario `bad-input`: 11 MB body → 413.
Status: FIXED in `c774746`

### [H-7] One client can open the circuit on every node with malformed input — HIGH
Area: router + node | Files: `packages/router/src/router.ts` (soft-failure handling), `examples/rest-api` pattern
What happens: an app that parses JSON without guarding it answers malformed input with `500`. The router counts each `500` as a node failure, and with an Idempotency-Key retries it on 3 nodes (3× amplification). In `bad-input`, **10 malformed requests opened the circuit on all 5 nodes.** Reads kept working only because dead nodes are still tried as a last resort. Weighted and quota routing were disrupted, and with the KV store, every isolate would see all nodes as down.
How to reproduce: `benchmarks/mock-mesh/run.sh bad-input`
Fix (owner-approved change to architecture §5): only timeouts, connection errors, `429` and `502`–`504` open a node's circuit. Other `5xx` (the app's own answer) are retried for GET/HEAD and passed through unchanged for writes, which removes the 3× amplification. `@omnimesh/node` adds `omniErrorHandler` (malformed JSON → `400 ERR_BAD_JSON`; internal errors logged but never sent to clients), and every example uses it. `router.failureThreshold` is now ignored and kept only so existing configs validate.
Test: `packages/router/test/failover.test.ts` › both `[H-7]` tests and `packages/node/test/middleware.test.ts` › `[H-7]` (all 3 failed before the fix); load scenario `bad-input` after the fix: malformed JSON → 400 on the first attempt; after 30 app errors and 10 malformed requests, the primary still served 100/100 reads on its first try.
Status: FIXED in `d92dae4`

### [H-8] Cached reads do not bypass the Worker on Cloudflare (architecture issue) — HIGH
Area: architecture / capacity | Docs: `docs/ARCHITECTURE.md` §2–3, v1 §4.1, README "absorbs 85–90% read traffic"
What happens: the design puts a Cloudflare Cache Rule "ahead of the Worker route" so cached reads never invoke the Worker. Cloudflare's docs say the opposite: Workers run **before** the cache, and cache hits on a Worker route still count as Worker requests toward the free plan's 100,000/day ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Workers Cache](https://developers.cloudflare.com/workers/cache/)). So in no-card mode, **every** request through the router, cached or not, counts against the 100,000/day ceiling.
Fix (owner decision: keep one route): the README diagram and limits section now state the 100,000 requests/day ceiling (error 1027 after it), and `docs/ARCHITECTURE.md` carries an errata note. Not unit-testable (documentation only).
Status: FIXED in `4969e87`

## Load-test results (local mock mesh)

All 6 scenarios were rerun after the Medium fixes (half-open circuit, default pool, redirect and cache-header rewriting all changed the router): every one still passes with the same numbers (flash sale 500/500 orders and 0 duplicates; primary dies 251 slow requests; all down max 6.01 s; quota 975/0/2,025 with 0 errors).

Harness: `benchmarks/mock-mesh/` contains 5 mock providers (shared idempotency store and orders table standing in for Upstash/Postgres) and the real router on the Node adapter. k6 runs from Docker image `grafana/k6:1.0.0`. Run any scenario with `benchmarks/mock-mesh/run.sh <name>`. All numbers are from one Linux machine; they measure router *behavior*, not Cloudflare edge latency.

| # | Scenario | Result | Key numbers |
|---|---|---|---|
| 3 | **Flash sale:** 500 buyers, primary writes then answers after 2.6 s (> 2.5 s timeout), clients retry | ✅ PASS | **500 orders, 0 duplicates, 0 missing**; 100% got 201; p50 2.93 s, p99 3.25 s (the first wave waits out the timeout) |
| 4 | **Primary dies** (hangs) at 10 s during 100 req/s for 40 s | ✅ PASS | 4,001/4,001 succeeded; **exactly 250 slow requests** (= 100 req/s × 2.5 s, the ones already in flight); every later request skipped the dead node; p50 1.6 ms, max 2.5 s |
| 7 | **All nodes down** (hang), then recovery | ✅ PASS | 100% clean `503 ERR_FAILOVER_EXHAUSTED`; max 6.01 s (budget 6 s); after recovery 500/500 succeeded at once |
| 8 | **Quota + 429:** koyeb 1,000/day quota, render answers 429 | ✅ PASS | 3,000/3,000 succeeded, 0 client errors; koyeb served 976 (target 950, small overshoot from 50 concurrent requests), render 0, vercel 2,024; ~1,400 req/s |
| 11 | **Bad input:** oversized body, malformed JSON, buggy endpoint, then reads | ✅ PASS (after H-6/H-7) | 11 MB body → `413`; malformed JSON → `400` on the first attempt; 30 app `500`s opened no circuit; the primary then served 100/100 reads on its first try. *Before the fixes: the body was not rejected and 10 requests opened every node's circuit.* |
| 13 | **Cross-user cache:** users A and B read `/api/me` concurrently, 50 VUs | ✅ PASS (after M-9) | 0 of 44,725 responses had the other user's data, and 0 were cacheable by a shared cache (all `private, no-store` + `Vary: Authorization`); ~3,000 req/s. *Before M-9: 100% lacked those headers.* |

Not run (outside the lean scope): scenarios 1, 2, 5, 6, 9, 10, 12, 14, 15; slowloris (handled by Cloudflare's edge in production; the local Node adapter would not be representative); router CPU time per request (needs Miniflare).

**Measured failover time:** the first requests after a node hangs take one timeout (2.5 s); after that, 0 extra latency. When a node errors fast (5xx or connection refused), failover adds only that node's response time (milliseconds).

**Realistic free capacity (no-card mode):** limited by the router, not by compute. Cloudflare Workers Free allows 100,000 requests/day, about 3M/month, resetting at midnight UTC, and per H-8 that includes cached reads. Adding Oracle or more providers raises compute capacity but not this ceiling. Beyond it, you need a paid Workers plan (same code) or option (a) under H-8.

## Medium (all fixed)

Each has a test that failed before its fix; one commit per issue.

| ID | Issue | Fix | Test | Commit |
|---|---|---|---|---|
| M-9 | Responses to authenticated requests had no `Cache-Control`/`Vary`, so a CDN or proxy cache could serve user A's data to user B | Router forces `private, no-store` on any response to a request with `Authorization` or `Cookie` (unless the app already set private), and adds them to `Vary` | `failover.test.ts` › `[M-9]`; load scenario 13 | `6243b1c` |
| M-2 | No way to rotate `GATEWAY_SECRET` without downtime | Nodes accept `previousSecrets` / `GATEWAY_SECRET_PREVIOUS` (each ≥ 32 chars, constant-time); `SECURITY.md` documents the 4-step rotation | `middleware.test.ts` › `[M-2]` (3 tests) | `efb7dd9` |
| M-1 | Absolute `Location`/`Content-Location` built from a node's own URL leaked backend hosts | Any URL on any mesh node is rewritten onto the public origin; relative and external redirects untouched | `failover.test.ts` › `[M-1]` | `09bddb0` |
| M-3 | Unmatched paths (e.g. `/admin`) always went to `/api`; `/_omnimesh/*` paths reached nodes | `defaultPool` (default `/api` as in the architecture; `null` → 404); router namespace never proxied. Verified `/api/../admin`, `%2e%2e`, `/API`, `/apiX` | `failover.test.ts` › `[M-3]` (2 tests) | `1d7c4ee` |
| M-4 | JWTs without `exp` valid forever; no `iss`/`aud`; no clock-skew allowance | `signJwt` defaults to 15 min and can set `iss`/`aud`; `verifyJwt`/`jwtAuth` require `exp`, allow 30 s skew (max 300), check `iss`/`aud` when configured | `middleware.test.ts` › `[M-4]` (3 tests) | `97c302c` |
| M-5 | After the 30 s circuit TTL, all traffic rushed back to a possibly still-dead node | Half-open: one probe; success closes the circuit, failure re-opens it for a full TTL; an unreported probe frees the slot after 10 s | `half-open.test.ts` | `a7c0f44` |
| M-6 | Empty pools, prefixes without `/`, `/api` vs `/api/`, duplicate nodes and a missing `defaultPool` were accepted; unknown providers not flagged | Schema rejects each with a clear path and message; `doctor` flags unknown `providerId` values. Duplicate YAML keys were already rejected by the parser (test kept as a guard) | `config.test.ts` › `[M-6]` (7 tests); `cli.test.ts` › `[M-6]` | `39ce893` |
| M-7 | `init` overwrote an existing config; keep-alive was on by default (architecture §8 says off, because of provider terms) | `init` refuses without `--force`; keep-alive only with `--keep-alive`, and the workflow carries a terms-of-service warning | `cli.test.ts` › `[M-7]` (2 tests) | `1fb2719` |
| M-8 | Oracle compose: `cloudflared:latest` floating tag; containers could escalate privileges | Pinned `cloudflared:2026.10.3` (verified multi-arch incl. arm64 for Oracle Ampere); `core-api` non-root, read-only root filesystem, all capabilities dropped; `no-new-privileges` on every service | `providers.test.ts` › `[M-8]` parses the compose file | `f9417cf` |

Behavior changes to note: `signJwt` now adds a 15-minute `exp` by default, and `verifyJwt` rejects tokens without one. Tokens issued by older code without `exp` will stop working, which is the point.

## Dashboard (architecture §4): was simulated, now live

Found while reviewing the product as a user: `packages/dashboard/index.html` showed hardcoded nodes and `Math.random()` numbers and never contacted the router, so the "live status, failovers, quota bars, latency" component in architecture §4 did not exist.

Fix (`31dc380`): the router records bounded telemetry (fixed-size rings; repeated events within 5 s collapse into one line) and `GET /_omnimesh/status` returns totals, latency p50/p95/p99, every pool and node (serving / standby / down with reason / quota reached), quota use, and an event timeline (node down, recovered, failover, quota switch, outage). The router serves the dashboard at `/_omnimesh/dashboard`. Security: 404 unless `OMNIMESH_STATUS_TOKEN` is set (now generated by `init`); the page holds no data and reads the API with the token typed in (kept in that browser tab only); nonce-based CSP with `connect-src 'self'` and `frame-ancestors 'none'`; `no-store`; every value rendered with `textContent`.
Tests: `packages/router/test/dashboard.test.ts` (5 tests).
Verified live in a browser against the mock mesh: Koyeb filled its quota and traffic moved on, then Render hung and Vercel took over, with 0 failed requests out of 453. The dashboard showed each step, and the phone-width layout was checked. Review in the browser caught and fixed one bug: standby nodes were shown in "down" banners (regression test added).
Limit: on Cloudflare, counters belong to the router instance that served the page; node health is shared through KV.

## Low (open)

L-1 k6 script `benchmarks/k6/load-test.js` has a hardcoded fallback gateway secret · L-2 no root `.env.example` (and `GATEWAY_SECRET_PREVIOUS`/`OMNIMESH_STATUS_TOKEN` are only documented in the generated `.env` and `SECURITY.md`) · L-3 `any` casts in router/node request paths; `pnpm lint` is a no-op · L-4 README benchmark numbers and the "<2.5 s" badge predate the mock-mesh results.

## Fixed earlier on this branch (`4b741e8`, `15fd726`)

Secrets written to the committed config and `.env.example` · backend URLs exposed in headers and errors · unauthenticated status page · idempotency failing open when Upstash is unconfigured, and keys not scoped per caller · non-constant-time secret compare · JWT `alg` not pinned · unbounded body buffering (memory DoS) · `/apiX` matching `/api` · spoofable forwarded headers · configured rate limit never enforced · router rebuilt on every request · KV write quota burned in minutes · credential validators passing tokens when offline · CI pnpm mismatch and no-op audit · weighted load balancing · failure-threshold circuit · quota-based switching. Each has tests in the router, node and CLI suites.

## Not yet run

The other 9 load scenarios, router CPU timing, human walkthroughs (§7), OSS readiness (§8), and the independent subagent re-audit.
