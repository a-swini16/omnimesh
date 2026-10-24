# OmniMesh Documentation

> **"Your free tiers, merged into one cloud."**

OmniMesh is an open-source distributed system that federates multiple cloud providers' free tiers (Cloudflare, Koyeb, Render, Vercel, Netlify, Deno Deploy, Neon, Supabase, Upstash, and Oracle Cloud) into **one resilient backend behind a single domain**.

If one server goes down, times out, or hits its quota, traffic automatically moves to the next healthy provider within ~2.5 seconds.

---

## 🚀 Quickstart in 3 Commands

```bash
# 1. Initialize OmniMesh (detects no-card or with-card profile)
npx omnimesh init

# 2. Check configuration, credentials, and network reachability
npx omnimesh doctor

# 3. Watch real-time failover live in your terminal
npx omnimesh chaos
```

---

## 💡 Why OmniMesh?

| Traditional Free Tier Setup | OmniMesh Federated Meta-Cloud |
| :--- | :--- |
| Single VM or container outage causes **100% downtime** | **Sub-3s auto-failover** to warm backup providers |
| Hard limit on 100k requests/day | **Pooled capacity** across multiple cloud providers |
| Sleeping containers (e.g. Render 15m idle) cause 30–50s cold delay | Automated **14-minute keep-alive engine** keeps nodes warm |
| Insecure open backend URLs exposed to the web | **Fail-closed origin authentication** via `X-Gateway-Secret` |
| Manual multi-cloud deployments | **One-command parallel deploy** across all platforms |

---

## 🎯 Honest Positioning & Trade-Offs

OmniMesh is engineered for **indie hackers, student developers, early MVPs, and open-source projects** that cannot afford expensive cloud bills yet.

* **Stateless compute and cached reads:** Extremely resilient. Fails over seamlessly in ~2.5s.
* **Database writes:** Compute is duplicated, but database writes must remain strictly centralized (Single Writer) to prevent state divergence.
* **WebSockets:** Active socket connections do not fail over mid-stream; clients simply reconnect and land on the next healthy node.
* **Sleeping providers:** Cold containers take 30–50s to wake; OmniMesh places them in backup pools and keeps them resident in memory via background keep-alive pings.
