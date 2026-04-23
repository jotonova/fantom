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
```

### Start all services in development

```bash
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
    └── shared/   # Shared TypeScript types
```

## Common Commands

| Command            | Description                          |
|--------------------|--------------------------------------|
| `pnpm dev`         | Start all apps in watch mode         |
| `pnpm build`       | Build packages then apps             |
| `pnpm typecheck`   | Run `tsc --noEmit` across workspace  |
| `pnpm lint`        | Run ESLint across workspace          |
| `pnpm test`        | Run Vitest across workspace          |

## API Endpoints

| Method | Path         | Description               |
|--------|--------------|---------------------------|
| GET    | `/health`    | Liveness check            |
| GET    | `/db/health` | DB connectivity + latency |

## Documentation

- [Architecture](./ARCHITECTURE.md) — stack overview and data flow
- [Deployment](./DEPLOYMENT.md) — Vercel + Render deployment guide
- [Decisions](./DECISIONS.md) — ADRs for major technical choices

## Repository

`https://github.com/jotonova/fantom`
