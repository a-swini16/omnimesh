# OmniMesh — System Architecture v2

> Text extracted automatically from [`architecture-v2.pdf`](architecture-v2.pdf) (Oct 24, 2026). That PDF is the source of truth. Diagrams were images in the PDF and are not included here; see the PDF.

> **Audit errata (owner-approved, see [`audit/AUDIT_REPORT.md`](audit/AUDIT_REPORT.md) H-8):** §2–3 assume a Cloudflare cache in front of the Worker, so cached reads would not invoke it. On Cloudflare, Workers run *before* the cache and cache hits still count as Worker requests. With one Worker route, the real free ceiling is **100,000 requests/day for all traffic, cached or not**.

```text

  OmniMesh — System Architecture v2
    Oct 24, 2026        · ​@Suvam

  1. Vision
  OmniMesh merges the free tiers of many cloud providers into one backend behind one
  domain, and moves traffic to a healthy server within about 3 seconds when any server
  fails. It does for servers what OmniRouter does for AI providers: one entry point, many
  interchangeable backends, automatic failover.

  Who it is for: students, indie developers, early startups and open-source maintainers who
  need a backend that stays up but cannot pay for AWS yet.

  What the developer does:

   1. Runs npx omnimesh init and ticks the accounts they already have (Cloudflare,
       Koyeb, Render, Vercel, Oracle and so on).
   2. Pastes one API token per provider. No credit card? Oracle and R2 are simply skipped.
   3. Runs omnimesh deploy . The same app is deployed to every provider, and one domain
      routes to all of them.
   4. Runs omnimesh chaos (or presses Test failover in the dashboard): one server is paused
      for a moment and the owner sees another cloud answer real requests.

  Positioning (what the README says): "Your free tiers, merged into one cloud." It is a
  resilient multi-cloud backend for modern apps, startups and production systems. It is not marketed
  as unlimited, and not as a replacement for AWS at Flipkart scale.

  2. Will it work?
  Yes, for stateless compute failover and cached reads. It is harder for the database, and it
  will not reach Flipkart scale on free tiers. Being clear about this is what makes the repo
  trusted.

    Claim                               Realistic?      Why

    If one server dies, another         Yes             A timeout plus retry at the edge
    answers within ~3 s                                 router is simple and proven

OmniMesh — System Architecture v2

    Claim                           Realistic?     Why

    One domain in front of 6 to 8   Yes            Cloudflare DNS, CDN and Workers do
    providers                                      this on the free plan

    High read traffic at $0         Yes, if        Public GET responses are served from
                                    cacheable      the Cloudflare cache, not your servers

    Database survives any single    Partly         Compute is easy to duplicate; one
    failure                                        database is still the weak point
                                                   (section 7)

    Unlimited servers               No             Each provider caps requests, RAM
                                                   and bandwidth; the mesh adds them
                                                   up, it does not remove limits

    Flipkart-scale backend          No             That needs paid infrastructure, many
                                                   database replicas and a team;
                                                   OmniMesh is a starting point that can
                                                   later move to paid tiers

  The honest promise: a backend that does not go down when one free server does, and
  costs $0 until you outgrow it.

OmniMesh — System Architecture v2

  3. Architecture at a glance

  OmniMesh architecture · 4 layers + control plane

  Every request enters through one Cloudflare domain; cached reads stop at the CDN,
  everything else goes to the edge router, which sends it to a healthy compute node that
  reads and writes one shared data layer.

  4. Components
  OmniMesh has eight components; only the edge router sits in the request path,
  everything else supports it.

OmniMesh — System Architecture v2

    Component                       Runs on                            Job

    Edge router                     Cloudflare Workers (primary),      Receives every request, picks a
                                    Deno or Bun mirror                 healthy node, enforces timeout,
                                                                       retries, returns the answer

    Health and quota                Cloudflare KV or a Durable         Shared list of which nodes are
    store                           Object                             down and how much of each quota
                                                                       is used, so every router instance
                                                                       agrees

    Health checker                  Cron in the router (every 1 min)   Calls /health on each node and
                                                                       updates the store before users hit
                                                                       a dead server

    Compute nodes                   Oracle, Koyeb, Render, Vercel,     Run the same app image;
                                    Netlify                            stateless; verify the gateway
                                                                       secret and JWT

    Data layer                      Neon or Supabase Postgres,         The single source of truth for data,
                                    Upstash Redis, optional Postgres   plus idempotency keys and rate
                                    on Oracle                          limits

    Object storage                  Cloudflare R2 (card) or Supabase   User uploads, media, static files
                                    Storage (no card)

    Control plane                   omnimesh CLI + GitHub Actions      Validates tokens, deploys to every
                                                                       provider, writes router config, runs
                                                                       chaos tests

    Dashboard                       Cloudflare Pages                   Live node status, failovers, quota
                                                                       bars, latency

  Key design rules

       Compute nodes hold no state. Any node can answer any request.
       The router never guesses: every routing decision reads the shared health and quota
       store.
       Limits live in config files, not code, because free tiers change.

OmniMesh — System Architecture v2

  5. Request lifecycle and failover
  When a node fails, the user waits one timeout (about 2.5 s) and then gets a normal answer
  from the next node; later requests skip the dead node for 30 seconds.

  router failover loop · 2 decisions, 1 retry loop

  Changes from the original PDF design

       Health is shared across all router instances (section 4), not kept in one isolate's
       memory.
       At most 3 attempts and 6 seconds in total, so a full outage fails fast instead of hanging.
       Writes are retried only with an Idempotency-Key ; without one the router returns the
       error rather than risk running the action twice.
       Large uploads (over 1 MB by default) are streamed and not retried.

OmniMesh — System Architecture v2

       WebSockets do not fail over mid-connection; the client reconnects and lands on a
       healthy node.

  6. Provider adapters
  Every provider is a plugin with the same interface, so the community can add new ones in
  under an hour. This is the main way the repo grows.

     interface ProviderAdapter {
       id: string;                     // "render", "koyeb", "oracle"
       requiresCard: boolean;
       tier: "free" | "trial-credit" | "paid";
       roles: ("edge-router" | "compute" | "database" | "cache" | "storage")[];
       limits: ProviderLimits;         // from limits.json, with lastVerified +
     sourceUrl
       validateCredentials(cfg): Promise<boolean>;
       deploy(app, cfg): Promise<DeployResult>;
       healthUrl(deployment): string;
       getUsage?(cfg): Promise<UsageSnapshot>;
       destroy(deployment, cfg): Promise<void>;
     }

  Starting catalog. Limits are left out on purpose: they must be checked against each
  provider's official pricing page when the adapter is written, and stored with a
   lastVerified date.

    Provider                        Role                  Card      Note
                                                          needed

    Cloudflare (DNS,                Edge router, cache,   No        The backbone; required
    CDN, Workers, KV)               health store

    Koyeb                           Compute (hot          Check     Always-on free service if
                                    standby)              current   still offered
                                                          policy

    Render                          Compute (warm or      No        Free services sleep when
                                    cold backup)                    idle

    Vercel                          Compute (serverless   No        Hobby plan is for non-
                                    burst)                          commercial use

OmniMesh — System Architecture v2

    Provider                        Role                    Card            Note
                                                            needed

    Netlify                         Compute (webhooks,      No              Good for async jobs
                                    functions)

    Deno Deploy                     Router mirror, light    No              Platform changed recently;
                                    compute                                 verify

    Oracle Cloud                    Big compute, optional   Yes             Most power; one account
    Always Free                     self-hosted Postgres                    per person

    Neon or Supabase                Postgres                No              Shared primary database
                                                                            in Mode A

    Upstash                         Redis                   No              Idempotency keys, rate
                                                                            limits

    Cloudflare R2                   Object storage          Yes             No egress fees

    Supabase Storage                Object storage          No              No-card alternative to R2

    Railway, Fly.io                 Compute                 Trial or paid   No permanent free tier;
                                                                            supported as paid
                                                                            adapters

  No-card path: Cloudflare + Koyeb + Render + Vercel + Netlify + Neon + Upstash +
  Supabase Storage. That is a full working mesh without any card.

  6.1 No-card mode (automatic)
  If the user has no credit or debit card, OmniMesh skips Oracle and R2 automatically and
  gives their jobs to free services that need no card, so the whole mesh still runs.

  How it works

   1. omnimesh init asks: "Do you have a card for cloud sign-ups?"
   2. No → providers that need a card are hidden, and the no-card profile is loaded.
   3. The router runs on Cloudflare Workers (no card needed) and routes to the no-card
      nodes below.
   4. If the user gets a card later, omnimesh add-provider oracle makes Oracle the
       primary node and moves the others to backup. No rebuild needed.

OmniMesh — System Architecture v2

    Job                             With a card                Without a card (auto-replacement)

    Edge router                     Cloudflare Workers         Cloudflare Workers

    Router mirror                   Deno Deploy                Deno Deploy

    Health and quota                Cloudflare KV              Cloudflare KV
    store

    Primary compute                 Oracle ARM VM              Koyeb (Render if Koyeb asks for a
                                                               card)

    Backup compute                  Koyeb, Render              Render, Vercel

    Auth service                    Deno, Vercel, Oracle       Deno, Vercel, Netlify

    Heavy jobs                      Oracle                     Queued in Upstash, processed by
                                                               Koyeb or Render

    Webhooks                        Netlify, Oracle            Netlify, Vercel

    Database                        Oracle Postgres (Mode B)   Neon or Supabase (Mode A)
                                    or Neon

    Cache and                       Upstash or Redis on        Upstash
    idempotency                     Oracle

    File storage                    Cloudflare R2              Supabase Storage

  Config the wizard writes

     profile: no-card                        # set automatically by omnimesh init
     pools:
       /auth:                [deno, vercel, netlify]
        /api:                [koyeb, render, vercel]
        /heavy:              [koyeb, render]   # long jobs go through an Upstash queue
       /webhooks: [netlify, vercel]
     database:
        mode: managed
        primary: neon
     storage: supabase

  Trade-off: without Oracle each node has much less RAM and CPU and the database has
  less storage, so no-card mode suits lighter apps. Heavy CPU work should go through the
  queue. Card rules can change, so each adapter's requiresCard flag is checked when its

OmniMesh — System Architecture v2

  limits are verified.

  7. Data and database failover
  There is always exactly one database that accepts writes; OmniMesh never lets two
  databases accept writes at once, because they would drift apart and lose orders or
  payments.

    Mode                   Who it is for   Primary database    Backup                If the primary
                                                                                     fails

    A:                     Everyone, no    Neon or             Provider's own        App goes read-
    Managed                card            Supabase            backups + nightly     only from cache
    (default)                              Postgres, pooled    dump to R2 or         until the provider
                                           connection          Supabase Storage      recovers

    B: Self-               Oracle users    Postgres on         Logical replication   Router switches
    hosted                 needing more    Oracle VM via       to Neon (seconds      reads to Neon;
                           storage         Cloudflare Tunnel   behind, not 5         writes wait until
                                                               minutes)              an omnimesh db
                                                                                     promote decision

  Rules every node follows

       Idempotency: every POST or PATCH that must be retried carries an Idempotency-Key .
       The node stores the key and the result in Upstash Redis before running the action, so a
       retry returns the stored result instead of charging twice.
       Sessions: stateless JWTs signed with keys shared by all nodes, so a user stays logged
       in whichever node answers.
       Cache: shared Redis, never in-process memory, so every node sees the same values.
       Promotion is a human decision by default. Automatic promotion can be turned on, but
       the docs explain the risk of losing the last few seconds of writes.

  8. Security, ToS and abuse protection
  OmniMesh uses one legitimate account per provider and never helps anyone create extra
  accounts to dodge limits; that rule protects users from bans and the repo from
  takedowns.

OmniMesh — System Architecture v2

    Threat                                      Protection

    Someone finds a raw backend URL and         Router adds X-Gateway-Secret ; nodes
    bypasses the router                         return 403 without it; Oracle has no public
                                                ports (Cloudflare Tunnel only)

    Weak or default secret                      Router and nodes refuse to start without a
                                                real secret (fail closed)

    A bot burns your free quota                 Rate limits per IP and per user at the edge;
                                                Cloudflare bot protection; quota-aware
                                                routing stops before limits

    Double payment on retry                     POST and PATCH retried only with an
                                                Idempotency-Key (section 7)

    Leaked tokens                               Tokens only in .env and GitHub secrets;
                                                never logged; secret scanning in CI

    Provider ToS violation                      One account per provider; keep-alive pings
                                                off by default with a warning; PRs that add
                                                multi-account or quota-evasion features are
                                                rejected (stated in CONTRIBUTING.md )

    Vulnerable dependencies                     Dependency audit and CodeQL in CI

  9. Developer experience
  A new user should go from zero to a live multi-cloud backend in under 10 minutes with one
  config file and five commands.

    Command                          What it does

     npx omnimesh init               Wizard: pick providers (card badge shown), paste
                                     tokens, validate them, write
                                      omnimesh.config.yaml and .env

     omnimesh deploy                 Builds once, deploys to every provider in parallel,
                                     deploys the router last, rolls back if health checks
                                     fail

     omnimesh status                 Live table of nodes, health, latency, quota used

OmniMesh — System Architecture v2

    Command                                What it does

     omnimesh chaos                        Pauses the answering server on the real
                                           deployment, shows which cloud took over and
                                           how fast, then resumes it

     omnimesh doctor                       Checks config, tokens, secrets and quotas, and
                                           explains how to fix each problem

     omnimesh add-provider <name>          Adds one provider to an existing mesh

     omnimesh db promote                   Makes the backup database the primary after a
                                           failure (Mode B)

  Example config

     domain: api.myapp.com
     router:
        timeoutMs: 2500
        maxAttempts: 3
        totalBudgetMs: 6000
        circuitTtlMs: 30000
     pools:
       /auth: [deno, vercel, oracle]
        /api: [oracle, koyeb, render, vercel]
        /webhooks: [netlify, oracle]
     database:
       mode: managed                # managed | self-hosted
       primary: neon
     cache: upstash
     storage: r2                    # r2 | supabase
     keepAlive: false               # off by default; check each provider's terms

  CI/CD: one GitHub Actions workflow runs tests on every push to main , then calls
  omnimesh deploy .

  10. Repo, stack and roadmap
  Build it as a TypeScript monorepo and ship a working failover demo first; everything else
  follows.

  Stack: TypeScript, pnpm + Turborepo, Hono (one router codebase for Workers, Deno, Bun
  and Node), Zod for config, Vitest for tests, k6 for load tests, Starlight or VitePress for
  docs. License: MIT.

OmniMesh — System Architecture v2

     omnimesh/
     ├── packages/
     │   ├── router/                # edge router (Hono)
     │      ├── node/               # @omnimesh/node middleware for compute nodes
     │      ├── core/               # config schema, shared types
     │      ├── cli/                # npx omnimesh
     │      ├── dashboard/          # status dashboard
     │   └── providers/             # one folder per provider + _template
     ├── examples/                  # rest-api, auth, webhooks, uploads
     ├── benchmarks/                # load + chaos tests and published results
     ├── docs/
     ├── .github/workflows/ # ci.yml, deploy-mesh.yml, release.yml
     ├── README.md CONTRIBUTING.md SECURITY.md LICENSE

  Build order

   1. Router core: failover, timeouts, circuit breaker, retry rules, tests against 3 local mock
         servers. Gate: kill one mock, every request still succeeds.
   2. Node middleware: gateway secret, JWT, idempotency, /health .
   3. No-card adapters: Cloudflare, Koyeb, Render, Vercel, Netlify, Neon, Upstash.
   4. CLI: init , deploy , status , doctor , chaos . Gate: a fresh user deploys in under 10
         minutes.
   5. Shared health store and quota-aware routing.
   6. Card adapters: Oracle (with Mode B database), R2.
   7. Dashboard and benchmarks: publish measured failover time and p95 latency.
   8. Launch: README, docs, demo GIF, v1.0 release.

  Launch checklist (how it goes viral)

         README opens with a 10-second GIF: a server is killed, traffic moves, the request still
         succeeds
         3-command quickstart and a "Deploy with zero credit card" section
         Provider table with card badge and lastVerified dates
         Honest "Limits" section (section 2 of this doc)
         Real benchmark numbers, with the script to reproduce them
         10+ "good first issue" tickets, each a new provider adapter
         Launch posts: Show HN, r/selfhosted, r/webdev, dev.to, X, LinkedIn, Indian dev
         communities

```
