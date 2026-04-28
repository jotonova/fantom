# Fantom Scripts

Utility scripts for interacting with the Fantom API from the command line.
All scripts run with `tsx` (already a dev dependency in the monorepo).

## Setup

Set the required environment variables (add to your shell profile or a local `.env`):

```sh
export FANTOM_API_BASE=https://fantom-api.onrender.com   # or http://localhost:3000 for local
export FANTOM_USER_EMAIL=you@example.com
export FANTOM_USER_PASSWORD=yourpassword
```

## auth-login.ts

Authenticates and writes the JWT to `.fantom-token` in the repo root.

```sh
tsx scripts/auth-login.ts
```

Output (stdout + `.fantom-token`):
```json
{
  "accessToken": "eyJ...",
  "refreshToken": "...",
  "user": { "id": "...", "email": "...", "name": "..." },
  "tenant": { "id": "...", "slug": "...", "name": "...", "role": "..." }
}
```

## api.ts

Importable fetch wrapper — use it in other scripts:

```ts
import { api } from './api.js'

const shorts = await api.get('/shorts')
const job    = await api.post('/shorts', { photoAssetIds: [...], voiceCloneId: '...', ... })
await api.patch('/shorts/123', { script: 'Hello world' })
```

- Reads the token from `.fantom-token` automatically
- On `401`, re-runs auth-login and retries once
- Throws `ApiError` on non-2xx with `status` and `body` fields

## Example: full short creation flow

```sh
# 1. Authenticate
tsx scripts/auth-login.ts

# 2. Generate a script (pipe the result)
FANTOM_API_BASE=https://fantom-api.onrender.com tsx -e "
  import { api } from './scripts/api.js'
  const r = await api.post('/shorts/generate-script', {
    vibe: 'calm_walkthrough',
    brandKitName: 'Novacor Default',
    photoCount: 1,
    targetDurationSeconds: 30
  })
  console.log(JSON.stringify(r, null, 2))
"

# 3. Create a draft short
# 4. Patch script onto it
# 5. POST /shorts/:id/render
# 6. Poll jobs table for status
```

## Notes

- `.fantom-token` is gitignored — never commit it
- Token TTL is 30 days (refresh token) / short-lived access token; auto-refresh
  kicks in on 401
- Rate limit on `/auth/login` is 5 req/min in production
