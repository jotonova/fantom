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
pnpm --filter @fantom/shared build && pnpm --filter @fantom/db build && pnpm --filter @fantom/ui build
pnpm dev
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
│   └── web/      # Next.js 14 frontend
└── packages/
    ├── config/   # Shared TS/ESLint/Prettier configs
    ├── db/       # Drizzle schema, migrations, singleton client
    ├── shared/   # Shared TypeScript types
    └── ui/       # @fantom/ui — React component library
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

## Documentation

- [Architecture](./ARCHITECTURE.md) — stack overview, data flow, multi-tenancy model
- [Deployment](./DEPLOYMENT.md) — Vercel + Render deployment guide
- [Decisions](./DECISIONS.md) — ADRs for major technical choices

## Repository

`https://github.com/jotonova/fantom`
