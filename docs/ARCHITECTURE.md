# Architecture

## Monorepo Structure

Fantom is a pnpm workspace monorepo with two apps and two shared packages.

```
fantom/
├── apps/
│   ├── api/      # Fastify REST API → deployed to Render
│   └── web/      # Next.js 14 frontend → deployed to Vercel
└── packages/
    ├── config/   # Shared TypeScript, ESLint, Prettier configs
    └── shared/   # Shared TypeScript types (HealthResponse, etc.)
```

## Stack

| Layer       | Technology              | Rationale                                                  |
|-------------|-------------------------|------------------------------------------------------------|
| Frontend    | Next.js 14 App Router   | RSC, streaming, excellent DX, first-class Vercel support   |
| Styling     | Tailwind CSS v3         | Utility-first, zero-runtime, consistent design tokens      |
| Backend     | Fastify 4               | High-throughput, TypeScript-native, schema validation      |
| Database    | PostgreSQL (Render)     | ACID-compliant, relational, mature ecosystem               |
| Queue/Cache | Redis (Render)          | Fast in-memory store for job queues and hot-path caching   |
| Language    | TypeScript 5            | End-to-end type safety via @fantom/shared                  |
| Pkg manager | pnpm workspaces         | Efficient installs, strict dependency isolation            |

## Data Flow

```
Browser
  │
  ▼
Next.js (Vercel)
  │  Server Components fetch directly from API at build/request time
  │  Client Components call API via NEXT_PUBLIC_API_URL
  ▼
Fastify API (Render)
  ├──▶ PostgreSQL   — persistent data (users, jobs, assets)
  └──▶ Redis        — job queues (BullMQ) + response caching
```

## Shared Types

`packages/shared` is the single source of truth for types that cross the API/web boundary. Both apps declare it as a `workspace:*` dependency. The package is compiled to `dist/` with declaration maps for accurate go-to-definition in editors.

## Key Design Decisions

See [DECISIONS.md](./DECISIONS.md) for full ADRs.

- **pnpm workspaces** (not Turborepo) — sufficient for F1 complexity; avoids Turborepo overhead.
- **App Router** — enables React Server Components and streaming for future video metadata pages.
- **Fastify** — ~40% faster than Express in benchmarks; JSON schema validation built in.
- **Postgres as primary store** — relational integrity for multi-tenant data model.
- **Redis for queues** — BullMQ-ready for async video processing jobs.
