# Changelog

All notable changes to OmniMesh. The format follows [Keep a Changelog](https://keepachangelog.com/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Health checks:** the router asks every server's health path every 5 minutes (a Worker Cron Trigger that `omnimesh up` turns on) and when you press **Check now**. Results are shared through KV, one write per run. Free servers that sleep when idle (Render) are only checked on demand, because a timer would keep them awake.
- **Lock level:** each check also learns whether a server refuses requests that skip the router (Locked) or accepts them from anyone (Not locked).
- **Pause and resume a server** (10–300 s) from the dashboard or `POST /_omnimesh/actions/pause`. A pause is refused when it would leave a route without a working server, and a paused server still answers as a last resort.
- **Real failover test:** `omnimesh chaos` and the dashboard's **Test failover** pause the answering server on your deployment, send real requests, report which cloud took over, and resume it.
- The dashboard leads with one plain answer ("Your app is up", "…but render is not answering", "Your app is down"), a list of what needs your attention, server cards, and your repo, branch and deploy time (from `omnimesh up`).

### Removed
- The old `omnimesh chaos` simulation with local stand-in servers.

## [1.1.0] - 2026-10-25

### Added
- **Live operator dashboard** at `/_omnimesh/dashboard`: overview with mesh map, routing, free-tier quotas, health, activity, a provider catalog with connection guides, a setup checklist and a config builder.
- **Quota-aware switching:** traffic moves to the next free tier at 95% of a provider's request quota.
- Weighted load balancing and backup-only nodes; a single-probe half-open circuit breaker.
- Gateway secret rotation (`GATEWAY_SECRET_PREVIOUS`); JWT `iss`/`aud` checks with bounded clock skew.
- `omniErrorHandler` for nodes (malformed JSON → 400, internal errors hidden).
- Shared rate limiting per IP and per caller through the Cloudflare rate-limit binding (`wrangler.toml.example`).
- Local mock mesh and k6 load and chaos scenarios (`benchmarks/mock-mesh`).

### Changed
- Only timeouts, connection errors, `429` and `502`–`504` open a circuit; app-level `5xx` never take a node out of rotation.
- `init` refuses to overwrite an existing config without `--force`; keep-alive is opt-in (`--keep-alive`).
- Generated example URLs use the unresolvable `.replace-me.invalid` domain.
- Signed JWTs expire after 15 minutes by default, and tokens without `exp` are rejected.

### Fixed
- Router failover could charge twice: idempotency now requires a shared store in production.
- Secrets could leak into git (`omnimesh.config.yaml`, `.env.example`) or reach third-party placeholder hosts.
- Backend URLs leaked through response headers, errors and redirects.
- Responses to logged-in users could be stored by a shared cache.
- Binary uploads were corrupted when sent with an `Idempotency-Key`.
- The CLI crashed from a clean clone; `deploy` reported success it never verified.

See [docs/audit/AUDIT_REPORT.md](docs/audit/AUDIT_REPORT.md) for every finding, its test and its fix.

## [1.0.0] - 2026-10-24

- Initial release: edge router with failover, node middleware, CLI, provider adapters.
