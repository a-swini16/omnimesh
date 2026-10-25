# OmniMesh Audit Plan

Status: **waiting for owner approval** before any fixing starts (brief §2.1).
Source of truth: [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md), extracted from `docs/architecture-v2.pdf`.
Branch: `harden-router-security-and-load-balancing` (two earlier hardening commits, `4b741e8` and `15fd726`, already on it).

---

## 1. Repo map

| Path | What it is | Request path? |
|---|---|---|
| `packages/core` | Zod config schema, shared types, error classes | config only |
| `packages/router` | Hono edge router: pool matching, failover loop, circuit breaker, quota tracker, rate limiter, KV health store, Worker entry, keep-alive cron | **yes** |
| `packages/node` | Middleware for compute nodes: gateway secret, HS256 JWT, idempotency (memory/Upstash), `/health` | **yes** |
| `packages/providers` | 13 adapters plus `limits.json` per provider; Oracle `docker-compose.yml` and replication script | no |
| `packages/cli` | `omnimesh` CLI: init, doctor, status, deploy, chaos, add/remove-provider, db promote | no |
| `packages/dashboard` | Single static HTML page with **simulated** data | no |
| `examples/` | rest-api, auth-service, webhooks (Hono on Node) | demo |
| `benchmarks/` | one k6 script and one chaos script (no mock-provider harness yet) | test |
| `.github/workflows` | `ci.yml` (typecheck, test, audit, gitleaks) and `deploy-mesh.yml` (dry run only) | CI |

There is no database layer, no SQL, no file uploads, no CORS handling and no password hashing anywhere in the repo (grep confirmed).

## 2. How to build and test

```bash
pnpm install
pnpm run typecheck   # root tsc, strict mode
pnpm test            # vitest, all packages
```

| Baseline | Result |
|---|---|
| Original commit `2a1ceed` | 31/31 tests pass; **typecheck fails** (no `@types/node`, packages not ESM); CI could not pass (pnpm 9 vs 12 mismatch) |
| Current branch head `15fd726` | **44/44 tests pass, typecheck clean** |
| Lint | `pnpm lint` is a no-op (`echo "Linting clean"`); no linter is configured |
| Build | No build step exists; every package ships raw `.ts` |

Tools on this machine: docker, redis-server and psql are available. **k6, wrangler/miniflare and gitleaks are not installed** (see decision D3).

## 3. What exists vs. what the architecture says

| Architecture item (doc §) | In code? | Notes |
|---|---|---|
| Edge router: timeout, ≤3 attempts, 6 s budget, 30 s circuit (§5) | ✅ | |
| Health shared across router instances (§4, §5) | ⚠️ partial | KV store exists; reads cached 10 s; `getAllNodeHealth` is local only |
| Health-checker cron every 1 min (§4) | ❌ | `scheduled()` only does keep-alive pings |
| POST/PATCH retried only with Idempotency-Key (§5, §7) | ✅ | |
| Uploads > 1 MB streamed, not retried (§5) | ✅ | Chunked bodies over the cap now get a 413 |
| Idempotency stored in **shared** Upstash before running (§7) | ⚠️ | **Default store is per-process memory** (see C-1 below) |
| Stateless JWT shared by all nodes (§7) | ✅ HS256 | No iss/aud, `exp` optional |
| Cache in shared Redis, never in-process (§7) | ❌ | No cache layer exists |
| Mode A: read-only from cache when DB is down (§7) | ❌ | Not implemented |
| Mode B: logical replication Oracle → Neon (§7) | ⚠️ | Script exists, but see decision **D1** |
| `db promote` is a human decision (§7) | ⚠️ | Only edits the YAML file; promotes nothing on Neon |
| Gateway secret; Oracle with no public ports (§8) | ✅ | |
| Rate limits per IP **and per user** at the edge (§8) | ⚠️ | Per IP only, per-isolate memory (or a CF binding if configured) |
| Quota-aware routing stops before limits (§8) | ✅ | Approximate: counted per router instance |
| Secret scanning, audit, CodeQL in CI (§8) | ⚠️ | Audit + gitleaks added; **no CodeQL**; actions not pinned by SHA |
| Keep-alive **off by default** with a warning (§8, §9) | ❌ | No-card profile enables it, and `init` always writes `keep-alive.yml` |
| `deploy`: build, deploy all, router last, **roll back** on failed health (§9) | ❌ | Adapters' `deploy()` return fake success; no rollback; health check is real now |
| `status`: live table incl. **quota used** (§9) | ⚠️ | Shows static limits, not usage |
| Dashboard: live status, failovers, quota bars (§4) | ❌ | Simulated data only |
| Turborepo, Starlight/VitePress docs (§10) | ❌ | Not used |
| Quickstart: `npx omnimesh init` in < 10 min (§9) | ❌ | **`omnimesh` isn't on npm (404) and `bin/omnimesh.js` crashes from a clean checkout** |

## 4. Preliminary findings (not yet fixed, to be confirmed with tests)

Found while reading the code. Each will get an ID, a failing test, a fix and a commit.

| ID | Sev | Finding |
|---|---|---|
| C-1 | **Critical** | `idempotency()` defaults to an in-memory store, and every example uses it. In the exact failover case (node A times out after writing, the router retries on node B), node B has no record and runs the write again: a **double charge**. Fix: refuse a memory store in production and require a shared store. |
| H-1 | High | The same Idempotency-Key with a *different* body silently replays the first response. The second order is never created, but the client is told it was. |
| H-2 | High | `examples/auth-service` issues a valid JWT for **any** email and password. Anyone who deploys the example as-is has no auth at all. |
| H-3 | High | Quickstart is broken: `npx omnimesh` returns 404, and the bin imports a `.js` file that doesn't exist. Also, **anyone could register the `omnimesh` name** and README users would run their code. |
| H-4 | High | Rate limiting is per isolate, not shared (§4.6), and there's no per-user or login rate limit. |
| H-5 | High | Provider `deploy()` returns fake success and `getUsage()` returns made-up numbers. |
| M-1 | Med | Upstream `Location` headers on redirects leak raw backend URLs. |
| M-2 | Med | No gateway-secret rotation (current + previous). |
| M-3 | Med | Unmatched paths (e.g. `/admin`) fall through to the `/api` pool. |
| M-4 | Med | JWT: no `iss`/`aud`, `exp` not required, no clock-skew bound. |
| M-5 | Med | Circuit has no single-probe half-open: after 30 s all traffic hits a possibly still-dead node. |
| M-6 | Med | Config accepts empty pools, duplicate prefixes and unknown providers. |
| M-7 | Med | `init` overwrites an existing config and workflow; keep-alive is on by default (ToS, §8). |
| M-8 | Med | Oracle compose: `cloudflared:latest` unpinned; no non-root user policy for the app image. |
| M-9 | Med | Router passes upstream `Cache-Control` unchanged and adds no `Vary`. The cross-user cache test (§6 #13) must prove user A can't get user B's response. |
| L-1 | Low | k6 script has a hardcoded fallback gateway secret (CONTRIBUTING bans fallbacks). |
| L-2 | Low | No root `.env.example`; `OMNIMESH_STATUS_TOKEN` isn't documented. |
| L-3 | Low | 11 `any` casts in router/node request paths; lint is a no-op. |
| L-4 | Low | README benchmark numbers and the "<2.5 s" badge aren't reproducible yet. |

**Secrets check (§2.7):** a git history scan found only demo/test values (`s3cr3t_gateway_token_…`, `valid_token_sample_123`). **No real keys.** A full gitleaks run happens in Phase 1.

Fixed earlier on this branch (will be logged in `AUDIT_REPORT.md` with IDs and the tests that cover them): secrets written to the committed config and `.env.example`; upstream URL leaks; unauthenticated status page; idempotency failing open when Upstash is unconfigured, and keys not scoped per caller; non-constant-time secret compare; JWT `alg` not pinned; unbounded body buffering; `/apiX` matching `/api`; spoofable forwarded headers; rate limit never enforced; router rebuilt per request; KV quota burn; validators passing tokens when offline; CI pnpm mismatch; weighted LB; failure-threshold circuit; quota switching.

## 5. Audit plan by phase

| Phase | Work | Output |
|---|---|---|
| 0 Build & run | Fix the CLI bin (add a build step or a tsx shim); add a real linter (ESLint + typescript-eslint); add root `.env.example` and startup env checks; follow the README from a fresh `git clone` into a temp dir and log every failing step | Green build/lint/typecheck; quickstart notes |
| 1 Security | Walk every §4 checklist item → OK / issue (file:line) / not implemented; run gitleaks (via Docker) on full history; path tests (`/api/../admin`, `%2e%2e`, `/API`, `//`, `?`/`#`) | `AUDIT_REPORT.md` entries + a failing test per issue |
| 2 Reliability | §5 checklist: timeouts on every outbound call, total budget, memory caps, half-open probe, config validation, CLI re-run safety, SIGTERM in examples | Report entries + tests |
| 3 Load | Build `benchmarks/mock-mesh/` (5 mock providers with modes: ok, latency, timeout, 5xx, 429, drop, slow body, sleeping); run the real router on the Node adapter in front, with local Postgres and Redis; k6 scenarios from §6; measure router CPU time per request | Results table with p50/p95/p99, error rate, failover time, throughput; honest capacity numbers with cited free-tier limits |
| 4 Human walkthroughs | The 8 scenarios in §7, run as a real developer from a clean clone, timed | Every confusing step and bad error message, fixed or logged |
| 5 OSS readiness | README honesty pass, SECURITY/CONTRIBUTING/LICENSE check, CI (lint, typecheck, unit, integration, short load test), coverage report, changelog/release | Checklist |
| Review | A fresh subagent that hasn't seen the fixes re-audits the Critical and High areas | Independent findings appended to the report |

Fix order: Critical → High → Medium → Low. One issue per commit, e.g. `fix(node): require shared idempotency store in production [C-1]`. A summary after each phase.

## 6. Decisions I need from you

**D1. The architecture doc seems wrong on Mode B (§7).** Oracle Postgres sits behind a Cloudflare Tunnel with no open ports, yet Neon must subscribe to it with logical replication. Neon (the subscriber) has to open a TCP connection *to* Oracle, and Neon can't run `cloudflared`, so this can't work as drawn. Options: (a) open 5432 only to Neon's published egress IPs, with TLS and a dedicated replication role; (b) push changes out from Oracle with a sync job (higher RPO); (c) drop Mode B and use Mode A for everyone. *My pick: (a), documented with its risk.*

**D2. Features the checklist expects that don't exist.** The brief says not to add big features without asking. For each, build it or mark it "not implemented, documented"?
- Login/signup with argon2id/bcrypt, per-account rate limiting, refresh tokens or a Redis denylist (§4.2)
- Mode A read-only cache mode when the DB is down (§5)
- Shared rate limiter backed by Upstash or a Durable Object (§4.6)
- Health-checker cron and half-open probe (§5)
- Real provider deploy APIs plus rollback for `omnimesh deploy` (§9)
- Live dashboard data with the 80% quota warning (§4.6)

*My pick: build the health cron, half-open probe, shared rate limiter and secret rotation (small, in the request path). Turn the auth example into a safe reference (bcrypt, login rate limit, short-lived tokens). Mark the rest as not implemented, with honest docs.*

**D3. Tools.** To run k6 and gitleaks without installing system packages, I'd use the `grafana/k6` and `zricethezav/gitleaks` Docker images, and Miniflare (npm dev dependency) for Worker-accurate CPU timing. OK to pull these?

**D4. Scope versus credits.** You asked me earlier to keep credit use low. The full brief (15 k6 scenarios, a 30-minute soak, per-issue commits, an independent re-audit) is large. Options:
- **Lean:** Phase 0, every Critical/High issue with tests, load scenarios 3, 4, 7, 8, 11 and 13, and a short report.
- **Full:** everything in the brief.

*My pick: Lean first, then decide on the rest from the report.*

**D5. npm name.** Should I prepare the CLI for publishing under a name you control (e.g. `@your-scope/omnimesh`) and change the README? Publishing itself is your call.

**D6. Two architecture docs disagree.** `Omni_Backend_System_Architecture_Document.pdf` (v1) says keep-alive runs every 14 min and that `deploy-mesh` auto-deploys. v2 says keep-alive is off by default. I'll treat **v2 as authoritative** unless you say otherwise.

The real-provider smoke test (§6) stays off until you approve it separately.
