# OmniMesh Easy Mode — build plan

> **Owner:** a-swini16 · **Repo:** https://github.com/a-swini16/omnimesh · **Written:** 2026-10-25
> Status of each phase is tracked in [docs/audit/AUDIT_REPORT.md](docs/audit/AUDIT_REPORT.md) and the git log.

## North star

> **You built a backend. Give OmniMesh the GitHub link. Connect 2–3 free clouds by pasting one key each. Click Deploy. Get one URL that stays online even when a cloud goes down.**

| The user does | OmniMesh does |
|---|---|
| Gives a GitHub repo link (or runs the command inside their project folder) | Reads the code: language, framework, port, start command, needed env vars, risky local storage |
| Creates a free account on each cloud and pastes one API key per cloud | Checks each key live and shows "Connected as …" |
| Fills in their own app's settings once | Generates every OmniMesh secret; sends the same settings to every cloud |
| Optionally clicks "Create a free database for me" | Creates a Neon Postgres (and Upstash Redis if needed) through their APIs |
| Clicks **Deploy** | Deploys the app to every compatible cloud, waits, checks it answers, deploys the router to Cloudflare, sends test requests through it |
| Copies their one URL | Opens the dashboard already signed in, with real data |

Honest limit: OmniMesh cannot create cloud accounts for the user (provider terms, and the project's one-real-account rule). One key per cloud is the minimum.

## Rules

1. **Production only. No demo mode, no fake servers, no mock data, no fake success** anywhere a user can see. If a provider API cannot do something, show an honest manual step. (Mock providers exist only inside the automated test suite and `benchmarks/`.)
2. **Never invent an API endpoint.** Confirm every provider call against official docs or the provider's published API spec and cite it in a comment.
3. Keep every security rule: gateway secret ≥ 32 chars, `https://` only for remote upstreams, strict CSP, operator endpoints 404 without the status token, no backend URLs in responses.
4. Every sentence a user sees is plain English that says **what happened and what to do next**.
5. Mock `fetch` in tests; never call real provider APIs from tests. Never print, log or commit provider keys (redact to the last 4 characters).
6. After each phase: `pnpm test` and `pnpm typecheck` green.

## Phases

- **Phase 0 — First impression and honesty:** remove the fake local cluster, its dashboard panel and every `dev-token` (no demo mode exists); plain login text, `#token=` auto sign-in, `omnimesh open`, `omnimesh token [--rotate]`; first-run card and plain labels; README "Works today / Coming next"; `omnimesh deploy` output no longer claims to deploy what it only checks.
- **Phase 1 — Works with any backend, unchanged:** `healthPath` and "below 500 = online"; active probes from the router cron; drain endpoint, "Pause for 60 s", "Test failover safely" (and `omnimesh chaos` becomes this real test on the user's own deployment); lock level (Open / Locked) detection.
- **Phase 2 — Analyzer and wizard:** `packages/analyzer` with fixture tests; compatibility matrix; wizard screens (Your app → Clouds → Settings → Deploy) with live key checks; wizard security tests; "Lock it for me" patch for Node frameworks.
- **Phase 3 — Real automated deploy:** Cloudflare router through the API; `deployFromSource` for Koyeb, Render, Vercel; Neon and Upstash creation; deploy screen with live progress, Retry/Skip, end-to-end test; `state.json`, update flow, `omnimesh destroy`; real `omnimesh deploy`; fix `deploy-mesh.yml`. **Oracle Always Free** automated as well.
- **Phase 4 — Publish and polish:** npm publishing (owner's account), redeploy-on-push GitHub Action, "From zero to live" guide.

## Owner test

Give a friend who built a small backend only the README. Don't help. Every place they stop becomes a `ux` issue. The goal: **they get a live URL without asking you anything.**
