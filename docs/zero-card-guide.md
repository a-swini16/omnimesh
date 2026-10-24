# Zero Credit Card Deployment Guide

A developer with **zero credit or debit card** can run a complete, highly available OmniMesh federation.

When you select "No Card" during setup, OmniMesh skips Oracle Cloud and Cloudflare R2 automatically, assigning their responsibilities to generous services that require no card for registration.

---

## 📋 The No-Card Architecture Stack

| Subsystem | No-Card Provider | Verified Free-Tier Quota | Role |
| :--- | :--- | :--- | :--- |
| **Front Door & Router** | **Cloudflare Workers** | 100,000 req/day, Unlimited CDN Egress | Edge Router, SSL, Global DNS |
| **Primary Compute** | **Koyeb** | 1 Eco Web Service (512 MB RAM, 0.1 vCPU) | Hot Standby Compute Node |
| **Warm Backup** | **Render** | 750 free instance hours/month | Warm Backup (Kept awake via GitHub Actions) |
| **Burst & Auth** | **Vercel & Deno Deploy** | 1M edge function invocations/mo | Serverless Burst & Stateless JWT Auth |
| **Async & Webhooks** | **Netlify Functions** | 125,000 function requests/mo | Asynchronous Background Tasks |
| **Database** | **Neon Postgres** | 0.5 GiB Postgres, Connection Pooling | Central Authoritative Single-Writer DB |
| **Cache & Locks** | **Upstash Redis** | 10,000 commands/day | Distributed Idempotency & Rate Limiting |
| **Object Storage** | **Supabase Storage** | 1 GB Free File Storage | User uploads, avatars, static assets |

---

## 🛠️ Step-by-Step Setup (Under 10 Minutes)

### 1. Initialize in No-Card Mode
```bash
npx omnimesh init --no-card
```

### 2. Sign Up & Populate Tokens in `.env`
Sign up using your GitHub or Google account (no card required on any of these platforms):
- **Cloudflare:** Create an API token with Workers permissions.
- **Koyeb:** Copy your API token from Account Profile.
- **Render:** Generate an API Key under Account Settings.
- **Neon:** Create a free project and copy your connection string (`DATABASE_URL`).
- **Upstash:** Create a free Redis database and copy REST URL & Token.
- **Supabase:** Copy Project URL and Anon Key.

### 3. Verify Health & Security
```bash
npx omnimesh doctor
```

### 4. Deploy Across All Providers
```bash
npx omnimesh deploy
```

### 5. Prevent Cold Starts on Render
OmniMesh automatically generated `.github/workflows/keep-alive.yml`. Simply push your repository to GitHub, and GitHub Actions will ping your service every 14 minutes to keep Render awake 24/7!
