# Architecture

## Monorepo Structure

Fantom is a pnpm workspace monorepo with three apps and shared packages.

```
fantom/
├── apps/
│   ├── api/      # Fastify REST API → deployed to Render (Web Service)
│   ├── web/      # Next.js 14 frontend → deployed to Vercel
│   └── worker/   # Render job processor → deployed to Render (Background Worker)
└── packages/
    ├── config/   # Shared TypeScript, ESLint, Prettier configs
    ├── db/       # Drizzle schema, migrations, and singleton client (@fantom/db)
    ├── jobs/     # @fantom/jobs — BullMQ queue + worker factory
    ├── render-bus/ # @fantom/render-bus — strategy pattern for render providers
    ├── shared/   # Shared TypeScript types (HealthResponse, etc.)
    ├── storage/  # @fantom/storage — Cloudflare R2 client (S3-compatible)
    ├── ui/       # @fantom/ui — React component library (Radix UI + Tailwind)
    └── voice/    # @fantom/voice — ElevenLabs client (synthesis + cloning)
```

### Frontend Structure (apps/web)

```
apps/web/
├── app/
│   ├── (authenticated)/      # Route group — all pages require auth
│   │   ├── layout.tsx        # Sidebar + topbar shell; redirects to /login if unauth
│   │   └── dashboard/
│   │       └── page.tsx
│   ├── login/
│   │   └── page.tsx
│   ├── globals.css           # Tailwind directives + fantom CSS custom properties
│   ├── layout.tsx            # Root layout — wraps with <Providers>
│   ├── page.tsx              # Landing page (client component)
│   └── providers.tsx         # Client boundary — mounts AuthProvider
└── src/
    └── lib/
        ├── api-client.ts     # fetch wrapper: auth headers, 401 retry, token management
        └── auth-store.tsx    # AuthProvider + useAuth() React context
```

## Stack

| Layer       | Technology              | Rationale                                                  |
|-------------|-------------------------|------------------------------------------------------------|
| Frontend    | Next.js 14 App Router   | RSC, streaming, excellent DX, first-class Vercel support   |
| UI library  | @fantom/ui (Radix UI)   | WAI-ARIA primitives + Tailwind tokens, shared across apps  |
| Styling     | Tailwind CSS v3         | Utility-first, zero-runtime, consistent design tokens      |
| Auth state  | React context           | Client-side AuthProvider + useAuth(); tokens in localStorage|
| Object store| Cloudflare R2           | Zero egress fees — critical for video/audio delivery       |
| Voice AI    | ElevenLabs              | Best-in-class synthesis + instant voice cloning            |
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
  │  1. auth plugin: Bearer token → request.user + request.tenantId
  │  2. tenant-context plugin: falls back to X-Tenant-Slug if no JWT tenant
  │  3. All tenant-scoped queries: set_config('app.current_tenant_id', ...)
  ├──▶ PostgreSQL   — persistent data (tenants, users, sessions, jobs, assets)
  └──▶ Redis        — job queues (BullMQ) + response caching
```

## Authentication Flow (F3)

```
POST /auth/login { email, password }
  │
  ├── Look up user by email (users table — no RLS)
  ├── bcrypt.compare(password, passwordHash)  [cost 12]
  │
  ├── In transaction:
  │     set_config('app.current_user_id', userId)     ← unlocks tenant_users self-access
  │     SELECT tenant_users JOIN tenants               ← RLS: own memberships policy
  │     set_config('app.current_tenant_id', tenantId) ← unlocks tenants row
  │     SELECT tenants WHERE id = tenantId
  │
  ├── jwt.sign({ sub: userId, tenantId, role }, { expiresIn: '15m' })
  ├── randomBytes(32).toString('hex')                  ← opaque refresh token
  ├── sha256(refreshToken)                             ← stored in sessions table
  │
  └── Response: { accessToken, refreshToken, user, tenant }

Subsequent requests (protected routes):
  Authorization: Bearer <accessToken>
  │
  ├── auth plugin (onRequest): jwt.verify(token) → request.user + request.tenantId
  ├── tenant-context plugin: tenantId already set — skips X-Tenant-Slug lookup
  └── route handler: db.transaction → set_config → RLS-enforced queries

POST /auth/refresh { refreshToken }
  │
  ├── sha256(refreshToken) → look up session
  ├── Check: expires_at > now AND revoked_at IS NULL
  ├── Revoke old session (set revoked_at)
  ├── Insert new session with new token pair
  └── Response: { accessToken, refreshToken }  ← rotated pair
```

## Asset Upload Flow (F5)

```
Browser
  │
  │  1. POST /assets/upload-url  {filename, mimeType, kind}
  ▼
Fastify API (Render)
  │  - Validates MIME type + kind
  │  - Looks up tenant slug
  │  - Calls generateUploadUrl() → S3 PutObjectCommand presigned URL
  │  - Returns {uploadUrl, key, expiresAt}
  │
  │  2. Browser PUTs file directly to R2
  ▼
Cloudflare R2 (fantom-assets bucket)
  │  - Receives raw file via presigned PUT
  │  - No bandwidth through Render
  │
  │  3. POST /assets  {key, filename, kind, mimeType, sizeBytes}
  ▼
Fastify API (Render)
  │  - Validates key starts with tenant slug (anti-spoofing)
  │  - Calls getObjectMetadata() to verify file landed in R2
  │  - Inserts into assets table (tenant-scoped via RLS)
  │  - Returns asset record + publicUrl
  │
  ▼
Browser renders the asset from publicUrl (direct R2 CDN — no API proxy)
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

| Table             | RLS | Purpose                                              |
|-------------------|-----|------------------------------------------------------|
| `tenants`         | ✅  | Top-level tenant entities (slug, name, status)       |
| `users`           | ❌  | Individual user identities (cross-tenant)            |
| `tenant_users`    | ✅  | N:N membership with role (owner / editor / viewer)   |
| `tenant_settings` | ✅  | Per-tenant key-value config store (jsonb values)     |
| `sessions`        | ❌  | Refresh token tracking + revocation (F3)             |
| `assets`          | ✅  | File library — images, audio, video (R2-backed) (F5) |
| `voice_clones`    | ✅  | ElevenLabs voice library (F5)                        |
| `jobs`            | ✅  | Render pipeline job queue — status, progress, I/O (F6)|

`users` and `sessions` are intentionally NOT RLS-restricted. Users are cross-tenant identities; sessions are auth tokens that establish the context RLS depends on (chicken-and-egg).

`users` is intentionally NOT RLS-restricted — a user identity exists independently of any single tenant and can be linked to multiple tenants via `tenant_users`.

### Request Lifecycle

1. **Auth plugin** (`onRequest`, runs first): parses `Authorization: Bearer <token>`, verifies JWT, sets `request.user = {id, tenantId, role}` and `request.tenantId`.
2. **Tenant-context plugin** (`onRequest`, runs second): if `request.tenantId` is already set (from JWT), skips header lookup. Otherwise reads `X-Tenant-Slug` header and resolves slug → tenantId.
3. **Route handler**: wraps tenant-scoped queries in a Drizzle transaction with `set_config`:
   ```typescript
   await db.transaction(async (tx) => {
     await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
     // ... tenant-scoped queries here — RLS enforced at DB level
   })
   ```
4. `set_config(..., true)` = LOCAL scope — the GUC resets automatically when the transaction ends.

### RLS Policies

RLS is enabled on `tenants`, `tenant_users`, and `tenant_settings`. Each table has a `USING` policy:

```sql
USING (id::text = current_setting('app.current_tenant_id', true))
-- or for FK tables:
USING (tenant_id::text = current_setting('app.current_tenant_id', true))
```

`current_setting('app.current_tenant_id', true)` returns `NULL` if the GUC is not set (the `true` = missing_ok). A `NULL` comparison always evaluates to false, so rows are invisible when no tenant is active.

### Database Role Hardening (F3)

Migration `0003_app_user_role.sql` creates a restricted `app_user` Postgres role with `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION` — no `BYPASSRLS`. Once `DATABASE_URL` is updated to use `app_user` credentials, RLS becomes genuinely enforced at the database level for all application queries.

The owner-role URL is retained as `MIGRATE_DATABASE_URL`, used only by `db:migrate` (which requires DDL privileges). See `docs/DEPLOYMENT.md → Database Role Hardening` for the full rotation procedure.

### Tenant Resolution

Tenants are resolved by `slug` (e.g. `novacor`). In F2, the slug is provided via the `X-Tenant-Slug` request header. In F3+, it will also be parseable from a subdomain (e.g. `novacor.fantomvid.com`). The stub is in `apps/api/src/plugins/tenant-context.ts`.

## Job Lifecycle (F6)

```
Browser
  │
  │  POST /jobs { kind: 'render_test_video', input: {...} }
  ▼
Fastify API
  │  1. Validate input (voiceCloneId, text, imageAssetId tenant-scoped)
  │  2. INSERT jobs (status='pending')
  │  3. BullMQ queue.add() → status='queued'
  │
  ▼
Redis (BullMQ queue: 'fantom-render')
  │
  ▼
Worker (apps/worker — Render Background Worker)
  │  1. Read job row from DB (kind, input, maxRetries)
  │  2. status='processing', startedAt=now()
  │  3. getPreferredProvider(tenantId) → reads tenant_settings 'render.preferred_provider'
  │  4. RenderBus.resolve(kind, preferred?) → picks provider (FfmpegProvider for all current kinds)
  │
  ▼
FfmpegProvider (apps/worker/src/providers/ffmpegProvider.ts)
  │  1. DB read: voice_clone.providerVoiceId, image asset r2Key + tenant slug
  │  2. ElevenLabs synthesize(text, voiceId) → write to /tmp       (progress: 10→30)
  │  3. putObjectFromFile(audioKey) stream to R2 + DB asset record
  │  4. getObjectToFile(imageKey) stream from R2 to /tmp            (progress: 30→40)
  │  5. ffmpeg -loop 1 -i image -i audio → MP4 (1920×1080, 30fps)  (progress: 40→90)
  │  6. putObjectFromFile(videoKey) stream to R2                    (progress: 90)
  │  7. returns RenderResult { r2Key, mimeType, sizeBytes, durationSeconds, width, height }
  │
  ▼
Worker dispatcher
  │  8. createAssetRecord(videoAsset) in DB
  │  9. jobs.output_asset_id = videoAsset.id
  │  10. status='completed', progress=100, completedAt=now()
  │
  ▼
Browser polls GET /jobs every 3s → sees status transition
  └── completed? → "View video" → opens R2 public URL (direct CDN, no API proxy)

On failure:
  Worker catch block → retries < max_retries (2) → status='queued', BullMQ retries
                     → retries >= max_retries     → status='failed', errorMessage set
```

### Job Status Transitions

```
pending → queued → processing → completed
                              → failed (retry → queued)
         → cancelled (from pending or queued only)
```

### Process Boundary

- **API process**: HTTP handler — validates, inserts to DB, enqueues to Redis. Returns immediately.
- **Worker process**: Long-running — reads from Redis, runs ffmpeg, writes assets. No HTTP.
- **Redis**: Queue transport only. Not the source of truth — all durable state is in Postgres.
- **DB (Postgres)**: Single source of truth for job state, progress, inputs, outputs.

## Key Design Decisions

See [DECISIONS.md](./DECISIONS.md) for full ADRs.

- **pnpm workspaces** (not Turborepo) — sufficient for F1/F2 complexity; avoids Turborepo overhead.
- **App Router** — enables React Server Components and streaming for future video metadata pages.
- **Fastify** — ~40% faster than Express in benchmarks; JSON schema validation built in.
- **Drizzle ORM** — TypeScript-native, generates plain-SQL migration files, co-located schema.
- **Postgres as primary store** — relational integrity + RLS for multi-tenant data model.
- **Redis for queues** — BullMQ-ready for async video processing jobs.
