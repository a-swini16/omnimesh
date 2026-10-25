<div align="center">

# 🌐 OmniMesh

### *Your free tiers, merged into one cloud.*

A resilient, zero-cost backend mesh for side projects, startups, student apps, and MVPs — with automatic multi-cloud failover.

[![CI Status](https://github.com/omnimesh/omnimesh/actions/workflows/ci.yml/badge.svg)](https://github.com/omnimesh/omnimesh/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Zero Credit Card Ready](https://img.shields.io/badge/Zero%20Credit%20Card-100%25%20Supported-emerald.svg)](#-zero-credit-card-mode)
[![Failover Time](https://img.shields.io/badge/Auto--Failover-%3C%202.5s-cyan.svg)](#-measured-benchmarks)

</div>

---

## ⚡ What is OmniMesh?

Think of it as **"OmniRouter, but for servers instead of AI providers"**: one entry point, many interchangeable backends, automatic failover.

OmniMesh merges many cloud providers' free tiers (**Cloudflare, Koyeb, Render, Vercel, Netlify, Deno Deploy, Neon, Supabase, Upstash, and Oracle Cloud**) behind a single domain. If one server goes down, times out, or hits its quota, traffic moves to the next one automatically.

```
Incoming Request: GET https://api.yourdomain.com/api/products
  │
  ├── [Attempt 1] ──> Oracle ARM / Koyeb (Down or Timeout > 2.5s) ──✖ (Trip circuit breaker for 30s)
  │
  └── [Attempt 2] ──> Render / Vercel (Healthy) ───────────────────✔ 200 OK (Served in 2.4s!)
```

---

## 🚀 Quickstart in 3 Commands

> The `omnimesh` package is **not on npm yet**, so `npx omnimesh` will not work. Until it is published, run the CLI from a clone:
>
> ```bash
> git clone https://github.com/omnimesh/omnimesh.git && cd omnimesh && pnpm install
> alias omnimesh="node $PWD/packages/cli/bin/omnimesh.js"
> ```
>
> Then use `omnimesh` instead of `npx omnimesh` in the steps below, from your own app's folder.

### 1. Initialize OmniMesh in your repo
```bash
npx omnimesh init
```
*Detects whether you have a credit card. If not, automatically configures the **100% no-card profile** (Cloudflare + Koyeb + Render + Vercel + Netlify + Neon + Upstash + Supabase).*

### 2. Verify credentials and origin security
```bash
npx omnimesh doctor
```

### Live dashboard

Your router serves an operator dashboard at `https://<your-domain>/_omnimesh/dashboard`: node health, failovers, latency, free-tier quota bars and an incident timeline, refreshed every 3 seconds. Sign in with `OMNIMESH_STATUS_TOKEN` from your `.env`.

### 3. Watch real-time failover live in your terminal
```bash
npx omnimesh chaos
```

---

## 🎬 Live Chaos Demo (Run it yourself!)

Run `npx omnimesh chaos` to watch a simulated node failure and sub-3-second cross-cloud failover live:

```text
🔥 OmniMesh Live Chaos & Auto-Failover Simulator
Demonstrating sub-3-second cross-cloud failover in real-time...

1. Testing Steady-State Traffic:
   ✔ 200 OK served by Primary (Oracle/Koyeb) in 23ms (Attempts: 1)

2. Injecting Chaos: Killing Primary Node...
   Primary node (http://127.0.0.1:41875) is now unresponsive (simulating VM crash/outage)

3. Client sends request to https://api.yourdomain.com/api/resource...

   🚀 FAILOVER SUCCESSFUL! Client received 200 OK
   • Total Failover Duration: 2.42 seconds
   • Serving Node:           Warm Backup (Render/Vercel)
   • Total Attempts:         2
   • Upstream URL:           https://core-api.onrender.com

4. Testing Circuit Breaker on subsequent request:
   ✔ 200 OK directly routed to Warm Backup in 2ms (Dead node skipped instantly, Attempts: 1)

🎉 Chaos test passed! Your backend survived node failure without downtime.
```

---

## 🏛️ System Architecture (v2)

```
                            [ Client Applications ]
                        (Web, Mobile, External Webhooks)
                                    │
                         https://api.yourdomain.com
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│  LAYER 1: CDN Edge Shield & Cache (Cloudflare Free Tier)               │
│  • Every request runs the Worker: 100k/day ceiling on the free plan    │
│  • DDoS mitigation, SSL termination, and IP rate limiting              │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Uncached dynamic & write traffic
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│  LAYER 2: Intelligent Edge Router (Hono on Cloudflare Workers / Deno)  │
│  • 2.5s AbortController timeout per node                               │
│  • Shared health & circuit breaker store (Cloudflare KV / Upstash)     │
│  • Hard latency budget (max 3 attempts, 6s total)                      │
│  • Safe Retries: POST retried ONLY with Idempotency-Key                │
│  • Proactive Quota Routing: diverts traffic before 429 errors          │
└───────────────────┬───────────────────┬───────────────────┬────────────┘
                    │ /auth             │ /api              │ /webhooks
                    ▼                   ▼                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│  LAYER 3: Stateless Multi-Cloud Compute Pools                          │
│  ┌──────────────────────┐ ┌──────────────────────┐ ┌─────────────────┐ │
│  │ Primary: Oracle ARM  │ │ Standby: Koyeb       │ │ Burst: Vercel   │ │
│  │ (24GB RAM, 4 OCPUs)  │ │ (512MB RAM, Eco)     │ │ (Serverless)    │ │
│  └──────────────────────┘ └──────────────────────┘ └─────────────────┘ │
│  ┌──────────────────────┐ ┌──────────────────────┐ ┌─────────────────┐ │
│  │ Backup: Render       │ │ Functions: Netlify   │ │ Edge: Deno      │ │
│  │ (Warm backup / 14m)  │ │ (Async Webhooks)     │ │ (Stateless JWT) │ │
│  └──────────────────────┘ └──────────────────────┘ └─────────────────┘ │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Shared state
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│  LAYER 4: Authoritative Data & Storage Fabric                          │
│  • Primary Database: Neon or Supabase Serverless Postgres              │
│  • Cache & Idempotency: Upstash Serverless Redis (10k cmds/day)        │
│  • Object Storage: Supabase Storage (No-Card) or Cloudflare R2 (Card)  │
│  • Optional Mode B: Oracle Postgres 16 with WAL logical replication   │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 📊 Verified Provider Matrix

Every provider quota is loaded from structured `limits.json` files and verified against current official documentation:

| Provider | Role | Card Needed? | Verified Free Tier Limit | Last Verified | Pricing Source |
| :--- | :--- | :---: | :--- | :---: | :--- |
| **Cloudflare** | Edge Router, CDN, KV | **No** | 100,000 req/day, 10ms CPU, Unlimited CDN | 2026-10-24 | [Official Docs](https://developers.cloudflare.com/workers/platform/pricing/) |
| **Koyeb** | Compute (Hot Standby) | **No** | 1 Eco Web Service, 512 MB RAM, 0.1 vCPU | 2026-10-24 | [Official Docs](https://www.koyeb.com/pricing) |
| **Render** | Compute (Warm Backup) | **No** | 750 free hrs/mo, 512 MB RAM *(Sleeps after 15m idle)* | 2026-10-24 | [Official Docs](https://render.com/docs/free) |
| **Vercel** | Compute (Burst) | **No** | 100 GB bandwidth/mo, 1M edge invocations/mo | 2026-10-24 | [Official Docs](https://vercel.com/pricing) |
| **Netlify** | Compute (Webhooks) | **No** | 125,000 function requests/mo, 100 GB bandwidth | 2026-10-24 | [Official Docs](https://www.netlify.com/pricing/) |
| **Deno Deploy** | Router Mirror, Auth | **No** | 100,000 req/day, 50ms CPU time | 2026-10-24 | [Official Docs](https://deno.com/deploy/pricing) |
| **Neon** | Primary Postgres | **No** | 0.5 GiB storage, connection pooling | 2026-10-24 | [Official Docs](https://neon.tech/pricing) |
| **Supabase** | DB & File Storage | **No** | 500 MB DB, 1 GB storage *(No-card R2 alternative)* | 2026-10-24 | [Official Docs](https://supabase.com/pricing) |
| **Upstash** | Redis Locks & Cache | **No** | 10,000 commands/day, 256 MB memory | 2026-10-24 | [Official Docs](https://upstash.com/pricing) |
| **Oracle Cloud** | Heavy VM & Mode B DB | **Yes** | 4 ARM OCPUs, 24 GB RAM, 200 GB disk, 10 TB egress | 2026-10-24 | [Official Docs](https://www.oracle.com/cloud/free/) |
| **Cloudflare R2** | High-Volume Storage | **Yes** | 10 GB storage, 1M Class A ops, $0 egress | 2026-10-24 | [Official Docs](https://developers.cloudflare.com/r2/pricing/) |

---

## 💳 Zero Credit Card Mode

Don't have a credit or debit card for cloud registrations? **You can still run OmniMesh.**

Run:
```bash
npx omnimesh init --no-card
```
OmniMesh will automatically exclude Oracle and R2, routing all jobs to verified zero-card providers:
* **Router:** Cloudflare Workers Free (No card)
* **Compute:** Koyeb + Render + Vercel + Netlify (No card)
* **Database:** Neon or Supabase Postgres (No card)
* **Cache & Locks:** Upstash Redis (No card)
* **File Storage:** Supabase Storage (No card)

If you get a card later, simply run `npx omnimesh add-provider oracle` to seamlessly upgrade your mesh without downtime.

---

## 📈 Measured Benchmarks

Real, reproducible numbers measured on live federations:

| Benchmark Metric | Measured Result | Reproduction Command |
| :--- | :--- | :--- |
| **Steady-State Edge Proxy Overhead** | **0.84 ms** (Local) / **~18 ms** (Edge) | `k6 run benchmarks/k6/load-test.js` |
| **p95 Request Latency** | **1.26 ms** (Local) / **~28 ms** (Edge) | `k6 run benchmarks/k6/load-test.js` |
| **Failover Detection & Reroute** | **2.48 s** (Timeout) / **3.2 ms** (5xx Error) | `npx tsx benchmarks/chaos/chaos-benchmark.ts` |
| **Circuit Breaker Lookup** | **0.43 ms** (Dead node skipped instantly) | `npx tsx benchmarks/chaos/chaos-benchmark.ts` |

---

## 🎯 Honest Limits & Constraints

Repos that overclaim get torn apart. Here is what OmniMesh can and cannot do:

1. **Not a replacement for AWS at Flipkart or Uber scale:**
   Free tiers have real CPU and RAM caps. OmniMesh merges them to keep your side project, student app, or MVP online when one server dies; it does not turn 512 MB into 512 GB.
2. **Database Failover is Hard:**
   Compute nodes are stateless and easily duplicated. Databases are not. OmniMesh strictly enforces a **Single Writer Rule**:
   * **Mode A (No-Card Default):** One managed Postgres (Neon/Supabase) shared by all nodes. If the DB provider undergoes maintenance, the app operates in cache-first read mode until recovery.
   * **Mode B (Oracle Users):** Self-hosted Postgres on Oracle ARM with real-time logical replication to Neon. Failover to Neon is read-only until an operator runs `omnimesh db promote`.
3. **WebSockets do not fail over mid-stream:**
   If a server hosting an active WebSocket connection dies, the client reconnects and lands on the next healthy node.
4. **The free ceiling is 100,000 requests per day (about 3M per month):**
   Every request to your domain runs the Cloudflare Worker router, and cache hits still count, because [Workers run before the cache](https://developers.cloudflare.com/workers/platform/pricing/). The Workers Free plan allows 100,000 requests/day, resetting at midnight UTC; after that Cloudflare answers with error 1027 until the reset. Adding more compute providers (or Oracle) adds CPU and RAM, not more requests. To go beyond it, move to a paid Workers plan; the code does not change.
5. **Sleeping Containers (Render):**
   Render free tier spins down after 15m of inactivity, taking 30–50s to wake up. OmniMesh handles this by:
   * Placing Render as a warm backup rather than primary hot node.
   * Generating an automated GitHub Actions keep-alive workflow (`.github/workflows/keep-alive.yml`) that pings `/health` every 14 minutes.

---

## 🛡️ Security & Terms of Service Compliance

* **1 Legitimate Account Per Provider:** Never create multiple fake accounts to evade quotas. That rule protects users from bans and the repo from takedowns.
* **Fail-Closed Origin Protection:** Backend nodes only accept traffic with a valid `X-Gateway-Secret` header; direct requests return `403 Forbidden`. Both router and nodes refuse to start without a strong secret (>= 32 chars).
* **Safe Retries Only:** Mutating requests (`POST`/`PATCH`) are only auto-retried if an `Idempotency-Key` header is present and locked in Redis.
* **Private Oracle VM:** Runs behind a Cloudflare Tunnel (`cloudflared`) with zero open public firewall ports.

---

## 📦 Monorepo Structure

```
omnimesh/
├── packages/
│   ├── core/          # Zod schema, shared TypeScript types, errors
│   ├── router/        # Hono edge router (Cloudflare Workers, Deno, Node)
│   ├── node/          # @omnimesh/node middleware (origin secret, JWT, idempotency)
│   ├── cli/           # npx omnimesh CLI suite
│   ├── dashboard/     # Status dashboard (Cloudflare Pages / Vercel SPA)
│   └── providers/     # Modular provider plugins + verified limits.json
├── examples/          # Sample apps (rest-api, auth-service, webhooks)
├── benchmarks/        # k6 load tests and chaos benchmarks
├── docs/              # Documentation site
└── .github/workflows/ # CI, deploy-mesh, keep-alive, release
```

---

## 🤝 Contributing

Want to add a new cloud provider? It takes under an hour!  
Check out our [Provider Template](packages/providers/_template/README.md) and [Contributing Guide](CONTRIBUTING.md).

---

## 📄 License

[MIT](LICENSE) © 2026 OmniMesh Contributors
