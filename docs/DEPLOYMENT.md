# Deployment

Fantom uses Vercel for the frontend and Render for the backend, database, and Redis.

---

## Web → Vercel

1. Push the repo to GitHub (`https://github.com/jotonova/fantom`).
2. In the [Vercel dashboard](https://vercel.com), click **Add New Project** and import the repo.
3. Set the **Root Directory** to `apps/web`.
4. Vercel auto-detects Next.js — no build command override needed.
5. Add the following environment variable under **Settings → Environment Variables**:

   | Key                    | Value                                       |
   |------------------------|---------------------------------------------|
   | `NEXT_PUBLIC_API_URL`  | `https://<your-render-api-service>.onrender.com` |

6. Deploy. Vercel handles preview deployments for every PR automatically.

---

## API → Render (Web Service)

1. In the [Render dashboard](https://render.com), click **New → Web Service**.
2. Connect your GitHub repo and select the `fantom` repository.
3. Configure:

   | Field            | Value                        |
   |------------------|------------------------------|
   | Root Directory   | *(blank — repo root)*        |
   | Build Command    | `pnpm install && pnpm --filter @fantom/shared build && pnpm --filter @fantom/db build && pnpm --filter @fantom/api build` |
   | Start Command    | `node apps/api/dist/index.js` |
   | Runtime          | Node 20                      |

   > **Important (F2 change):** The Root Directory must be blank (repo root) so pnpm can resolve and build workspace packages (`@fantom/shared`, `@fantom/db`) before building the API. If Root Directory was previously set to `apps/api`, update it in Render's Settings → Build & Deploy.

4. Add environment variables:

   | Key            | Value                              |
   |----------------|------------------------------------|
   | `DATABASE_URL` | (copy from Render PostgreSQL below) |
   | `REDIS_URL`    | (copy from Render Redis below)      |
   | `PORT`         | `3001`                             |
   | `NODE_ENV`     | `production`                       |
   | `WEB_URLS`     | `https://<your-vercel-app>.vercel.app` (comma-separate multiple origins) |

   > **Note:** `WEB_URL` (single origin) is still supported as a fallback but deprecated — prefer `WEB_URLS`.

5. **Add a Pre-Deploy Command** (Settings → Deploy → Pre-Deploy Command):
   ```
   pnpm --filter @fantom/db db:migrate
   ```
   This runs Drizzle migrations against the Render Postgres database before each new deploy. Migrations are idempotent — already-applied migrations are skipped automatically.

6. Deploy.

---

## Database → Render PostgreSQL

1. In Render, click **New → PostgreSQL**.
2. Choose a name (e.g., `fantom-db`) and the free plan for F1/F2.
3. After creation, copy the **Internal Database URL**.
4. Paste it as the `DATABASE_URL` environment variable in the API web service.

---

## Redis → Render Redis

1. In Render, click **New → Redis**.
2. Choose a name (e.g., `fantom-redis`) and the free plan for F1/F2.
3. After creation, copy the **Internal Redis URL**.
4. Paste it as the `REDIS_URL` environment variable in the API web service.

---

## Seeding Production (One-Time, After F2 Deploy)

The Novacor tenant must be seeded manually once after the first successful migration. **Run the seed locally with the production DATABASE_URL** — this is safer than a Render Job because you can inspect output and re-run if needed without touching Render's dashboard.

```bash
# From repo root — set DATABASE_URL to the External Database URL from Render
DATABASE_URL="postgres://..." pnpm --filter @fantom/db db:seed
```

> Use the **External** Database URL (not internal) when connecting from your local machine. Find it in the Render PostgreSQL dashboard → "Connections".

The seed is idempotent — running it multiple times is safe.

---

## Environment Summary

| Service | Env Var               | Source                       |
|---------|-----------------------|------------------------------|
| API     | `DATABASE_URL`        | Render PostgreSQL internal URL |
| API     | `REDIS_URL`           | Render Redis internal URL      |
| API     | `PORT`                | `3001`                         |
| API     | `WEB_URLS`            | Vercel deployment URL(s)       |
| Web     | `NEXT_PUBLIC_API_URL` | Render API service URL         |

---

## Vercel — Monorepo Quick Reference

> Captured after the F1 deployment saga (see DECISIONS.md — Decision #002 for full context).

### vercel.json (repo root)

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "buildCommand": "pnpm --filter @fantom/shared build && pnpm --filter @fantom/web build",
  "installCommand": "pnpm install --frozen-lockfile",
  "outputDirectory": "apps/web/.next",
  "framework": "nextjs",
  "ignoreCommand": "git diff --quiet HEAD^ HEAD -- ./apps/web ./packages/shared ./vercel.json || exit 1"
}
```

### Root package.json — phantom dep required

Vercel's framework detector scans the **root** `package.json` for `"next"`. Even though Next.js is installed in `apps/web/`, add it at root too:

```json
"dependencies": {
  "next": "14.2.0"
}
```

### Vercel Project Settings UI (must set manually)

| Setting | Value |
|---|---|
| Root Directory | *(blank — let vercel.json drive)* |
| Framework Preset | Other |
| Node.js Version | **20.x** (do NOT rely on .nvmrc — Vercel ignores it) |
| Environment Variables | `NEXT_PUBLIC_API_URL` → Render API URL |

### Webhook gotcha

After connecting the GitHub repo in Vercel, verify the webhook actually installed at:
`github.com/jotonova/fantom/settings/hooks`

If missing: uninstall the Vercel GitHub App at `github.com/settings/installations`, then reconnect. A **Deploy Hook** (Project Settings → Git) is a reliable manual fallback.

### Force-redeploy when ignoreCommand would skip

1. Deployments tab → latest deployment → **Redeploy**
2. Uncheck **"Use existing Build Cache"**
3. Uncheck **"Use project's Ignore Build Step"**
4. Confirm
