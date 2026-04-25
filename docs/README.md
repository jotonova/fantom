# Fantom

**The multi-tenant video automation platform.**

Fantom is a pnpm workspace monorepo containing the web frontend, REST API, and shared TypeScript packages for the Fantom video-at-scale platform.

---

## Quick Start

### Prerequisites

- Node 20+
- pnpm 9+
- PostgreSQL 15+ (or Docker)
- Redis 7+ (or Docker)

### Install dependencies

```bash
pnpm install
```

### Set up environment variables

```bash
# Root
cp .env.example .env

# API
cp apps/api/.env.example apps/api/.env
# Edit apps/api/.env with your local Postgres and Redis URLs

# DB package (for running migrations and seed locally)
cp packages/db/.env.example packages/db/.env
# Edit packages/db/.env with your local Postgres URL
```

### Run database migrations

```bash
pnpm --filter @fantom/db db:migrate
```

### Seed the database (first-time only)

```bash
pnpm --filter @fantom/db db:seed
```

### Start all services in development

```bash
# Build shared packages first, then start apps
pnpm --filter @fantom/shared build && pnpm --filter @fantom/db build && pnpm --filter @fantom/ui build && pnpm --filter @fantom/storage build && pnpm --filter @fantom/voice build && pnpm --filter @fantom/jobs build && pnpm --filter @fantom/render-bus build && pnpm --filter @fantom/distribution-bus build
pnpm dev
# Worker dev (in a separate terminal, requires local Redis)
pnpm --filter @fantom/worker dev
```

### Dev login credentials

| Email | Password | Tenant |
|-------|----------|--------|
| novacor.icaz@gmail.com | 061284 | novacor |

> **Note:** These are seeded credentials for local and internal development only.
> See `docs/DECISIONS.md → MANDATORY ROTATION TRIGGER` for the gate that must be cleared before any external user is added.

This starts `next dev` (port 3000) and `tsx watch` (port 3001) in parallel.

---

## Project Structure

```
fantom/
├── apps/
│   ├── api/      # Fastify REST API
│   ├── web/      # Next.js 14 frontend
│   └── worker/   # BullMQ render worker (Render Background Worker)
└── packages/
    ├── config/   # Shared TS/ESLint/Prettier configs
    ├── db/       # Drizzle schema, migrations, singleton client
    ├── jobs/     # @fantom/jobs — BullMQ queue + worker factory
    ├── distribution-bus/ # @fantom/distribution-bus — strategy pattern for destination providers
    ├── render-bus/ # @fantom/render-bus — strategy pattern for render providers
    ├── shared/   # Shared TypeScript types
    ├── storage/  # @fantom/storage — Cloudflare R2 client
    ├── ui/       # @fantom/ui — React component library
    └── voice/    # @fantom/voice — ElevenLabs client
```

## Common Commands

| Command                                        | Description                          |
|------------------------------------------------|--------------------------------------|
| `pnpm dev`                                     | Start all apps in watch mode         |
| `pnpm build`                                   | Build packages then apps             |
| `pnpm typecheck`                               | Run `tsc --noEmit` across workspace  |
| `pnpm lint`                                    | Run ESLint across workspace          |
| `pnpm test`                                    | Run Vitest across workspace          |
| `pnpm --filter @fantom/db db:generate`         | Generate SQL migrations from schema  |
| `pnpm --filter @fantom/db db:migrate`          | Apply pending migrations to DB       |
| `pnpm --filter @fantom/db db:seed`             | Seed Novacor as tenant #1            |
| `pnpm --filter @fantom/db db:studio`           | Open Drizzle Studio (visual DB UI)   |

## API Endpoints

| Method | Path              | Auth     | Description                                  |
|--------|-------------------|----------|----------------------------------------------|
| GET    | `/health`         | None     | Liveness check                               |
| GET    | `/db/health`      | None     | DB connectivity + latency + migration count  |
| POST   | `/auth/login`     | None     | Exchange credentials for token pair          |
| POST   | `/auth/refresh`   | None     | Rotate refresh token, get new access token   |
| POST   | `/auth/logout`    | None     | Revoke a refresh token / session             |
| GET    | `/me`             | Bearer   | Current user + tenant data                   |
| GET    | `/tenants/me`     | Bearer   | Current tenant details                       |
| GET    | `/auth/debug`     | None     | Echo request.user + tenantId (dev only)      |
| POST   | `/jobs`           | Bearer   | Create and enqueue a render job              |
| GET    | `/jobs`           | Bearer   | List tenant jobs (cursor pagination)         |
| GET    | `/jobs/:id`       | Bearer   | Get single job with output asset URL         |
| POST   | `/jobs/:id/cancel`| Bearer   | Cancel pending/queued job                    |
| POST   | `/jobs/:id/retry` | Bearer   | Retry a failed job                           |
| POST   | `/distributions`  | Bearer   | Create and enqueue a distribution            |
| GET    | `/distributions`  | Bearer   | List tenant distributions (cursor pagination)|
| GET    | `/distributions/:id` | Bearer| Get single distribution record               |
| POST   | `/distributions/:id/retry` | Bearer | Retry a failed distribution         |
| POST   | `/distributions/:id/cancel` | Bearer | Cancel a pending/queued distribution |
| DELETE | `/distributions/:id` | Bearer | Delete a terminal distribution record     |
| GET    | `/tenant-settings/distribution` | Bearer | Get auto-publish config        |
| PUT    | `/tenant-settings/distribution` | Bearer | Set auto-publish config        |

### Smoke test — login → verify → me

```bash
API=https://fantom-api.onrender.com

# 1. Login — returns accessToken and refreshToken
LOGIN=$(curl -s -X POST "$API/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"novacor.icaz@gmail.com","password":"061284"}')

echo $LOGIN | python3 -m json.tool

ACCESS=$(echo $LOGIN | python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken'])")
REFRESH=$(echo $LOGIN | python3 -c "import sys,json; print(json.load(sys.stdin)['refreshToken'])")

# 2. GET /me with the access token
curl -s "$API/me" -H "Authorization: Bearer $ACCESS" | python3 -m json.tool

# 3. Refresh the token pair
curl -s -X POST "$API/auth/refresh" \
  -H "Content-Type: application/json" \
  -d "{\"refreshToken\":\"$REFRESH\"}" | python3 -m json.tool

# 4. Logout (revoke the refresh token)
curl -s -X POST "$API/auth/logout" \
  -H "Content-Type: application/json" \
  -d "{\"refreshToken\":\"$REFRESH\"}"
# → 204 No Content
```

## Infrastructure Cost

~$70/mo in production (as of F6):

| Service | Plan | Cost |
|---------|------|------|
| Render API (`fantom-api`) | Starter | $7/mo |
| Render Worker (`fantom-worker`) | **Standard** (2 GB RAM, 1 CPU) | $25/mo |
| Render PostgreSQL | Basic-256MB | $7/mo |
| Render Redis | Free | $0 |
| Vercel (Next.js frontend) | Hobby | $0 |
| ElevenLabs | Creator (100k chars/mo) | ~$22/mo |
| Cloudflare R2 | Free tier (10 GB) | $0 |

> The worker runs on Standard tier (up from Starter at F6) to support 1080p ffmpeg encoding without OOM.
> Next upgrade trigger: Pro tier ($85/mo, 4 GB RAM) if we ever add 4K output or multi-stream rendering.

## Documentation

- [Architecture](./ARCHITECTURE.md) — stack overview, data flow, multi-tenancy model
- [Deployment](./DEPLOYMENT.md) — Vercel + Render deployment guide
- [Decisions](./DECISIONS.md) — ADRs for major technical choices

## Repository

`https://github.com/jotonova/fantom`
