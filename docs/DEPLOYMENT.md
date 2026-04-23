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
   | Root Directory   | `apps/api`                   |
   | Build Command    | `pnpm install && pnpm build` |
   | Start Command    | `node dist/index.js`         |
   | Runtime          | Node 20                      |

4. Add environment variables:

   | Key            | Value                              |
   |----------------|------------------------------------|
   | `DATABASE_URL` | (copy from Render PostgreSQL below) |
   | `REDIS_URL`    | (copy from Render Redis below)      |
   | `PORT`         | `3001`                             |
   | `NODE_ENV`     | `production`                       |
   | `WEB_URL`      | `https://<your-vercel-app>.vercel.app` |

5. Deploy.

---

## Database → Render PostgreSQL

1. In Render, click **New → PostgreSQL**.
2. Choose a name (e.g., `fantom-db`) and the free plan for F1.
3. After creation, copy the **Internal Database URL**.
4. Paste it as the `DATABASE_URL` environment variable in the API web service.

---

## Redis → Render Redis

1. In Render, click **New → Redis**.
2. Choose a name (e.g., `fantom-redis`) and the free plan for F1.
3. After creation, copy the **Internal Redis URL**.
4. Paste it as the `REDIS_URL` environment variable in the API web service.

---

## Environment Summary

| Service | Env Var               | Source                       |
|---------|-----------------------|------------------------------|
| API     | `DATABASE_URL`        | Render PostgreSQL internal URL |
| API     | `REDIS_URL`           | Render Redis internal URL      |
| API     | `PORT`                | `3001`                         |
| API     | `WEB_URL`             | Vercel deployment URL          |
| Web     | `NEXT_PUBLIC_API_URL` | Render API service URL         |
