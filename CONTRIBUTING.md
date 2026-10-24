# Contributing to OmniMesh

Thank you for your interest in contributing to OmniMesh! We are building the open-source standard for federating multi-cloud free tiers into resilient backends.

---

## ⚖️ Strict Terms of Service & Security Policy (Non-Negotiable)

OmniMesh is built on principles of strict legitimacy and ethical cloud utilization:

1. **One Legitimate Account Per Provider:**
   * OmniMesh federates **one real account per distinct cloud provider** (e.g., 1 Cloudflare + 1 Koyeb + 1 Render + 1 Vercel + 1 Netlify + 1 Neon + 1 Upstash).
   * **STRICT PROHIBITION:** Pull requests that introduce features for spinning up multiple fake accounts, rotating accounts to evade quotas, or violating any provider's Terms of Service will be immediately rejected and reported.
2. **Fail-Closed Security:**
   * Every backend node MUST enforce `X-Gateway-Secret` origin protection.
   * Hardcoded fallback secrets (like `"internal-mesh-key"`) are strictly banned.
3. **No Secret Commits:**
   * Secrets belong solely in `.env` and GitHub Secrets. Never commit API keys or credentials to version control.

---

## 🔌 How to Add a New Provider Adapter (Under 1 Hour)

We welcome new cloud providers!

1. Copy the adapter template:
   ```bash
   cp -r packages/providers/_template packages/providers/src/<provider-name>
   ```
2. Verify the provider's official pricing page and fill in `limits.json` with `lastVerified` and `sourceUrl`.
3. Implement `validateCredentials`, `deploy`, and `healthUrl` in `index.ts`.
4. Export your adapter in `packages/providers/src/index.ts`.
5. Add a unit test in `packages/providers/test/providers.test.ts`.
6. Run `pnpm test` and submit a Pull Request!

---

## 🏷️ Curated "Good First Issue" Opportunities

Looking for ideas to contribute? These provider adapters are ready to be built:

1. **DigitalOcean App Platform:** Add Starter free tier adapter for static assets / functions.
2. **Scaleway Stardust / Serverless:** Add Scaleway serverless container adapter.
3. **Aiven Free Tier:** Add Aiven free PostgreSQL/MySQL managed database adapter.
4. **Wasabi / Backblaze B2:** Add S3-compatible low-cost storage adapter.
5. **Python / FastAPI Middleware:** Create `@omnimesh/fastapi` middleware for Python backends.
6. **Go / Gin Middleware:** Create `omnimesh-go` middleware for Go backends.
7. **Rust / Axum Middleware:** Create `omnimesh-rs` middleware for Rust web services.
8. **Turso / libSQL:** Add Turso distributed SQLite database adapter.
9. **Koyeb CLI Integration:** Enhance native Koyeb CLI subprocess deployer.
10. **Render Blueprint Generator:** Enhance automatic `render.yaml` infrastructure-as-code generation.

---

## 🧪 Development Workflow

```bash
# Install monorepo dependencies
pnpm install

# Run all test suites
pnpm test

# Run tests in watch mode
pnpm test:watch

# Typecheck
pnpm run typecheck
```
