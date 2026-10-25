# Changelog

All notable changes to OmniMesh. The format follows [Keep a Changelog](https://keepachangelog.com/), and versions follow [Semantic Versioning](https://semver.org/).

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
