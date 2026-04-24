# Architecture

## Monorepo Structure

Fantom is a pnpm workspace monorepo with two apps and three shared packages.

```
fantom/
├── apps/
│   ├── api/      # Fastify REST API → deployed to Render
│   └── web/      # Next.js 14 frontend → deployed to Vercel
└── packages/
    ├── config/   # Shared TypeScript, ESLint, Prettier configs
    ├── db/       # Drizzle schema, migrations, and singleton client (@fantom/db)
    └── shared/   # Shared TypeScript types (HealthResponse, etc.)
```

## Stack

| Layer       | Technology              | Rationale                                                  |
|-------------|-------------------------|------------------------------------------------------------|
| Frontend    | Next.js 14 App Router   | RSC, streaming, excellent DX, first-class Vercel support   |
| Styling     | Tailwind CSS v3         | Utility-first, zero-runtime, consistent design tokens      |
| Backend     | Fastify 4               | High-throughput, TypeScript-native, schema validation      |
| Database    | PostgreSQL (Render)     | ACID-compliant, relational, RLS for tenant isolation       |
| ORM         | Drizzle ORM             | TypeScript-native, plain-SQL migrations, Postgres RLS-aware|
| Queue/Cache | Redis (Render)          | Fast in-memory store for job queues and hot-path caching   |
| Language    | TypeScript 5            | End-to-end type safety via @fantom/shared and @fantom/db   |
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
  │  tenant-context plugin resolves X-Tenant-Slug → tenantId
  │  All tenant-scoped queries run with set_config('app.current_tenant_id', ...)
  ├──▶ PostgreSQL   — persistent data (tenants, users, jobs, assets)
  └──▶ Redis        — job queues (BullMQ) + response caching
```

## Shared Types

`packages/shared` is the single source of truth for types that cross the API/web boundary. Both apps declare it as a `workspace:*` dependency. The package is compiled to `dist/` with declaration maps for accurate go-to-definition in editors.

`packages/db` exports the Drizzle schema types and the singleton `db` client. Only `apps/api` imports from it directly. Web components never touch the DB layer.

## Multi-Tenancy

### Model

Fantom uses a **shared database, schema-per-tenant-via-RLS** architecture:

- All tenants share the same tables.
- Row-level security (RLS) policies on tenant-scoped tables restrict each database session to one tenant's rows.
- Tenant context is conveyed via a session-level GUC (Grand Unified Configuration): `app.current_tenant_id`.

### Tables

| Table             | Purpose                                           |
|-------------------|---------------------------------------------------|
| `tenants`         | Top-level tenant entities (slug, name, status)    |
| `users`           | Individual user identities (cross-tenant)         |
| `tenant_users`    | N:N membership with role (owner / editor / viewer)|
| `tenant_settings` | Per-tenant key-value config store (jsonb values)  |

`users` is intentionally NOT RLS-restricted — a user identity exists independently of any single tenant and can be linked to multiple tenants via `tenant_users`.

### Request Lifecycle

1. Fastify `onRequest` hook (tenant-context plugin) reads `X-Tenant-Slug` from the request header.
2. Plugin looks up the tenant by slug (owner-role connection — bypasses RLS for this system lookup).
3. `request.tenantId` is set on the Fastify request object.
4. Route handlers that touch tenant-scoped data wrap queries in a Drizzle transaction:
   ```typescript
   await db.transaction(async (tx) => {
     await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
     // ... tenant-scoped queries here — RLS enforced at DB level
   })
   ```
5. `set_config(..., true)` = LOCAL scope — the GUC resets automatically when the transaction ends.

### RLS Policies

RLS is enabled on `tenants`, `tenant_users`, and `tenant_settings`. Each table has a `USING` policy:

```sql
USING (id::text = current_setting('app.current_tenant_id', true))
-- or for FK tables:
USING (tenant_id::text = current_setting('app.current_tenant_id', true))
```

`current_setting('app.current_tenant_id', true)` returns `NULL` if the GUC is not set (the `true` = missing_ok). A `NULL` comparison always evaluates to false, so rows are invisible when no tenant is active.

### F2 Limitation — Owner Role Bypasses RLS

The application currently connects as the Render Postgres owner role, which **bypasses RLS by default**. RLS policies are in place and `set_config` is called correctly on every tenant-scoped transaction, but enforcement only activates if the role does NOT have the `BYPASSRLS` attribute.

**F3 action item:** Provision a dedicated `app_user` role without `BYPASSRLS`, grant it table-level privileges, and update `DATABASE_URL` to use that role. This makes RLS genuinely enforced at the DB level for all application queries.

### Tenant Resolution

Tenants are resolved by `slug` (e.g. `novacor`). In F2, the slug is provided via the `X-Tenant-Slug` request header. In F3+, it will also be parseable from a subdomain (e.g. `novacor.fantomvid.com`). The stub is in `apps/api/src/plugins/tenant-context.ts`.

## Key Design Decisions

See [DECISIONS.md](./DECISIONS.md) for full ADRs.

- **pnpm workspaces** (not Turborepo) — sufficient for F1/F2 complexity; avoids Turborepo overhead.
- **App Router** — enables React Server Components and streaming for future video metadata pages.
- **Fastify** — ~40% faster than Express in benchmarks; JSON schema validation built in.
- **Drizzle ORM** — TypeScript-native, generates plain-SQL migration files, co-located schema.
- **Postgres as primary store** — relational integrity + RLS for multi-tenant data model.
- **Redis for queues** — BullMQ-ready for async video processing jobs.
