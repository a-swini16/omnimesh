# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |

---

## 🔒 OmniMesh Security Model

OmniMesh is engineered with a strict **fail-closed** security architecture:

1. **Origin Gateway Secret (`X-Gateway-Secret`):**
   * Backend compute nodes only accept traffic originating from the authenticated OmniMesh Edge Router.
   * If a direct external request bypasses the Edge Router and arrives at a backend container URL without a valid `X-Gateway-Secret`, the backend returns `403 Forbidden`.
   * Both the Edge Router and `@omnimesh/node` refuse to start if `GATEWAY_SECRET` is missing or under 32 characters.
2. **Oracle ARM VM Isolation:**
   * In Mode B, Oracle Cloud ARM instances run strictly behind a private **Cloudflare Tunnel (`cloudflared`)**.
   * Zero inbound public ports (80 or 443) are opened on the host firewall.
3. **Write Idempotency & Safe Retries:**
   * The Edge Router strictly refuses to auto-retry mutating requests (`POST` / `PATCH`) after upstream timeouts unless the request presents an `Idempotency-Key` header.
   * Distributed locks backed by Upstash Redis prevent duplicate financial transactions or orders during transient failover windows.
4. **Secret Protection:**
   * Secrets and tokens are never logged or exposed in telemetry.
   * Automated `.gitignore` inspection protects `.env` files from accidental commits.

---

## 🚨 Reporting a Vulnerability

If you discover a security vulnerability in OmniMesh, please do not open a public issue. Instead, report it privately to:

**Email:** `security@omnimesh.dev` (or open a confidential GitHub Security Advisory).

We will acknowledge receipt within 48 hours and provide a timeline for patch release and disclosure.
