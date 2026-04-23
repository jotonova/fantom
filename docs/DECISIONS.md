# Architecture Decision Records

---

## ADR-001: pnpm Workspaces over Turborepo

**Status:** Accepted
**Date:** 2026-04-22

### Context
A monorepo build orchestrator is needed to manage two apps and two packages. Options considered: Turborepo, Nx, and raw pnpm workspaces.

### Decision
Use pnpm workspaces with no additional orchestration layer for F1.

### Reasoning
- Turborepo adds meaningful value (remote caching, fine-grained task graphs) at medium-to-large team scale, but introduces ~30 minutes of configuration overhead for a single-developer F1 build.
- pnpm's `--filter`, `--recursive`, and `--parallel` flags cover every workflow needed at this stage.
- Migration to Turborepo is straightforward — add `turbo.json` and the `turbo` dev dependency when caching becomes valuable.

### Consequences
- No remote caching on CI for F1. Full typecheck and lint on every push (~30s with the current surface area — acceptable).
- Zero lock-in: any future pipeline tool can layer on top of the existing workspace topology.

---

## ADR-002: Next.js 14 App Router

**Status:** Accepted
**Date:** 2026-04-22

### Context
The frontend needs SSR/SSG capabilities and will eventually serve data-heavy video metadata pages.

### Decision
Use Next.js 14 with the App Router (not Pages Router).

### Reasoning
- React Server Components eliminate unnecessary client-side data fetches for read-heavy pages.
- Streaming enables progressive loading of video asset lists without blocking the full page.
- The App Router is the strategic direction for Next.js; Pages Router is in maintenance mode.
- First-class Vercel integration with zero-config deployment.

### Consequences
- RSC mental model has a steeper learning curve for contributors unfamiliar with the App Router.
- Some third-party libraries require `"use client"` wrappers — manageable with a clear boundary convention.

---

## ADR-003: Fastify over Express

**Status:** Accepted
**Date:** 2026-04-22

### Context
The API needs to handle concurrent webhook ingestion from video platforms and serve metadata to the frontend.

### Decision
Use Fastify 4 as the HTTP framework.

### Reasoning
- Fastify benchmarks at ~40% higher throughput than Express on equivalent hardware.
- Built-in JSON schema validation (via Ajv) catches malformed payloads before they reach business logic.
- TypeScript-first design with full type inference on request/reply shapes.
- Plugin architecture (CORS, auth, rate limiting) mirrors Express middleware but with lifecycle hooks that avoid ordering bugs.

### Consequences
- Smaller ecosystem than Express, but all critical plugins (CORS, JWT, multipart) exist as first-party Fastify plugins.
- Schema-first route definitions require slightly more upfront code than Express handlers.

---

## ADR-004: PostgreSQL as Primary Store, Redis for Queues and Cache

**Status:** Accepted
**Date:** 2026-04-22

### Context
Fantom is a multi-tenant platform. Data integrity, tenant isolation, and async job processing are all requirements.

### Decision
Use PostgreSQL as the primary persistent store and Redis as the queue backend and hot-path cache.

### Reasoning
**PostgreSQL:**
- ACID compliance is non-negotiable for billing, tenant, and job records.
- Row-level security (RLS) provides a database-enforced tenant isolation layer.
- `jsonb` columns handle variable video metadata schemas without sacrificing queryability.

**Redis:**
- BullMQ (built on Redis) is the standard queue for Node.js async job processing.
- Sub-millisecond reads for session data and API response caching avoid unnecessary Postgres load.
- Render's managed Redis is available on the free tier, matching the Postgres offering.

### Consequences
- Two managed data services to operate. At F1 scale this is straightforward on Render's free tier.
- Redis data is volatile by default — only non-durable data (cache, ephemeral queue state) should live there. Durable job records are checkpointed to Postgres.
