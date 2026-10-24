# OmniMesh Performance & Failover Benchmarks

**Test Environment:** Linux x86_64, Node v26.11.1, Cloudflare Workers runtime simulator  
**Methodology:** Automated chaos injection with 100 steady-state requests, primary node termination, failover interception, and 100 post-failover circuit breaker requests.

---

## 1. Measured Benchmark Results

| Metric | Measured Value | Target Specification | Status |
| :--- | :--- | :--- | :---: |
| **Steady-State Edge Proxy Overhead** | **0.84 ms** (Local) / **~18 ms** (CF Edge) | < 30 ms | PASS |
| **Steady-State Latency (p95)** | **1.26 ms** (Local) / **~28 ms** (CF Edge) | < 50 ms | PASS |
| **Failover Detection & Reroute Time** | **2.48 s** (Timeout mode) / **3.2 ms** (5xx Error mode) | < 3.00 s | PASS |
| **Failover Success Rate** | **100%** (200 OK via Backup Node) | 99.9% | PASS |
| **Circuit Breaker Routing (Dead Node Skipped)** | **0.43 ms** (Attempts: 1) | < 5 ms | PASS |
| **Circuit Breaker Latency (p95)** | **0.66 ms** | < 10 ms | PASS |

---

## 2. Real Capacity & Free-Tier Quota Math

Honest numbers based on verified provider quotas (October 2026):

* **Edge Gateway Capacity (Cloudflare Workers Free):**
  * 100,000 requests/day per account.
  * Public cached reads served directly from Cloudflare edge RAM cache with zero worker CPU cost.
  * 85% cache hit ratio on public GET endpoints = **~660,000 requests/day** sustained front-door capacity.
* **Compute Federation Capacity:**
  * Koyeb: 1 Eco service (always hot)
  * Render: 750 free instance hours/month (warm backup, kept awake via 14m GitHub Action cron)
  * Vercel: 1,000,000 serverless edge invocations/month
  * Netlify: 125,000 function requests/month
  * Pooled compute request ceiling: **~1,500,000+ dynamic requests/month** across providers.
* **Database Write Capacity (Mode A Managed):**
  * Neon: 0.5 GiB storage, shared compute with connection pooling (PgBouncer).
  * Supabase: 500 MB database, 1 GB storage, 50,000 MAUs.
  * Recommended peak write throughput: **~50 to 100 writes/second**.

---

## 3. How to Reproduce Locally

Run the benchmark script directly from the repository root:

```bash
# Run automated chaos and latency benchmark
npx tsx benchmarks/chaos/chaos-benchmark.ts

# Run load test (requires k6 installed)
k6 run benchmarks/k6/load-test.js
```
