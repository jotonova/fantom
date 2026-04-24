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
pnpm --filter @fantom/shared build && pnpm --filter @fantom/db build
pnpm dev
```

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
    └── shared/   # Shared TypeScript types
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

| Method | Path            | Description                              |
|--------|-----------------|------------------------------------------|
| GET    | `/health`       | Liveness check                           |
| GET    | `/db/health`    | DB connectivity + latency + migration count |
| GET    | `/tenants/me`   | Current tenant data (requires X-Tenant-Slug header) |

### Example: resolve a tenant

```bash
# With header (all environments)
curl -H "X-Tenant-Slug: novacor" https://fantom-api.onrender.com/tenants/me

# Dev-only: query-param shorthand
curl https://fantom-api.onrender.com/tenants/me?slug=novacor
```

## Documentation

- [Architecture](./ARCHITECTURE.md) — stack overview, data flow, multi-tenancy model
- [Deployment](./DEPLOYMENT.md) — Vercel + Render deployment guide
- [Decisions](./DECISIONS.md) — ADRs for major technical choices

## Repository

`https://github.com/jotonova/fantom`
