# No-card setup guide

You can run a full OmniMesh without any credit or debit card. `init --no-card` leaves out Oracle Cloud and Cloudflare R2 (the only two that need a card) and uses providers that sign you up with GitHub or Google.

## Who does what

| You do this once | OmniMesh does this for you |
| :--- | :--- |
| Create one free account per provider (no card) | Writes `omnimesh.config.yaml` with every pool ready |
| Deploy your app on each provider by connecting your GitHub repo in its dashboard | Generates every secret in `.env` (`GATEWAY_SECRET`, `JWT_SECRET`, `OMNIMESH_STATUS_TOKEN`) |
| Paste each app's address into the config, replacing the `replace-me.invalid` placeholders | `omnimesh doctor` lists anything still missing |
| Put your domain on Cloudflare | Routes every request, fails over in one timeout, switches before free quotas run out |
| | Live dashboard at `/_omnimesh/dashboard` |

OmniMesh never creates accounts or uploads your code: providers require you to do that yourself, and the project allows only one real account per provider.

## The no-card stack

| Job | Provider | Free tier (check `lastVerified` in each `limits.json`) |
| :--- | :--- | :--- |
| Router and domain | Cloudflare Workers | 100,000 requests/day (this is the mesh's free ceiling) |
| Main compute | Koyeb | 1 small always-on service |
| Backup compute | Render | 750 hours/month; sleeps after 15 min idle |
| Burst and auth | Vercel, Deno Deploy | Serverless functions (Vercel Hobby is non-commercial only) |
| Webhooks | Netlify | 125,000 function requests/month |
| Database | Neon or Supabase | One shared Postgres (the single writer) |
| Idempotency keys | Upstash Redis | 10,000 commands/day |
| File storage | Supabase Storage | 1 GB |

## Steps

The `omnimesh` package is not on npm yet, so run the CLI from a clone:

```bash
git clone https://github.com/a-swini16/omnimesh.git && cd omnimesh && pnpm install
alias omnimesh="node $PWD/packages/cli/bin/omnimesh.js"
```

1. **Create the config** in your app's folder:
   ```bash
   omnimesh init --no-card --domain api.yourapp.com
   ```
2. **Deploy your app** on Koyeb, Render, Vercel, Netlify and Deno Deploy (each dashboard has "deploy from GitHub"). Use the `@omnimesh/node` middleware so every node checks `GATEWAY_SECRET` and serves `/health`.
3. **Set secrets.** Put `GATEWAY_SECRET` (and `JWT_SECRET` if you use the auth helpers) on every node. Put `GATEWAY_SECRET` and `OMNIMESH_STATUS_TOKEN` on the router. For idempotent writes, add `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` to every node.
4. **Paste your app URLs** into `omnimesh.config.yaml`, or build the file in the dashboard's Setup page and copy it.
5. **Check everything:**
   ```bash
   omnimesh doctor
   ```
6. **Deploy the router** from `packages/router` (copy `wrangler.toml.example` to `wrangler.toml` first):
   ```bash
   npx wrangler deploy
   ```
7. **Verify** that every pool has a healthy node, then open `https://api.yourapp.com/_omnimesh/dashboard`:
   ```bash
   omnimesh deploy
   ```

## Sleeping servers

Render's free services sleep after 15 minutes idle and take 30–50 s to wake. Keep Render as a backup, not your main node. Keep-alive pings are off by default because some providers' terms forbid them; if yours allow it, re-run `omnimesh init --force --keep-alive`.
