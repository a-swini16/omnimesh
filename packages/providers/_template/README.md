# How to Add a Provider to OmniMesh in Under 1 Hour

OmniMesh is built on a modular plugin system where every cloud provider is an independent package implementing the `ProviderAdapter` interface.

## Step-by-Step Guide

### 1. Copy the Template
```bash
cp -r packages/providers/_template packages/providers/myprovider
```

### 2. Verify and Document Current Limits
1. Go to your provider's official pricing page.
2. Edit `limits.json`:
   - Set `providerId` and `displayName`.
   - Set `requiresCard` (`true` or `false`).
   - Fill in actual numerical limits (`requestsPerDay`, `ramMb`, `bandwidthGbPerMonth`).
   - Set `sleepsIfIdle` and `idleSleepMinutes` if the container sleeps when inactive (e.g., Render).
   - Set `lastVerified` to today's date (`YYYY-MM-DD`).
   - Set `sourceUrl` to the exact official documentation/pricing URL.

### 3. Implement the `ProviderAdapter` Interface
Edit `src/index.ts`:
- `validateCredentials(config)`: Make a lightweight ping to the provider's `/me` or account status API using `fetch()`. Return `true` if valid.
- `deploy(appPath, config)`: Call the provider's official API or CLI to deploy the app container/function.
- `healthUrl(deployment)`: Return the endpoint URL where OmniMesh can ping the service `/health`.
- `getUsage(config)`: (Optional) If the provider exposes an account usage API, return current requests and bandwidth so OmniMesh can proactively steer traffic before 429 errors.

### 4. Register the Provider
Add your provider export to `packages/providers/src/index.ts`.

### 5. Add a Vitest Unit Test
Add `packages/providers/test/myprovider.test.ts` verifying that credentials validation and limits parsing succeed.

### 6. Submit a Pull Request
Thank you for helping democratize resilient multi-cloud infrastructure!
