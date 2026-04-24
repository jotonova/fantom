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

---

## Decision #002 — Vercel Monorepo Deployment Configuration
**Date:** 2026-04-23
**Status:** Adopted
**Context:** Initial F1 frontend deployment to Vercel hit multiple compounding issues that took ~12 commits to resolve.

### Issues Encountered (in order)
1. **First deploy failed:** corepack enable could not write to /usr/bin/pnpm on Render's read-only filesystem (this was actually the API issue, but symptomatic of how monorepo build commands need careful crafting per platform).
2. **next.config.ts incompatible:** Next.js 14.2 doesn't support TypeScript config files; required conversion to next.config.mjs.
3. **Vercel couldn't resolve @fantom/shared:** When Root Directory was set to apps/web, Vercel's build couldn't walk up to the workspace root for the shared package.
4. **Vercel webhook didn't install on first connect:** Even after Vercel UI showed "Connected", no webhook appeared on github.com/jotonova/fantom/settings/hooks. Multiple reconnect attempts failed.
5. **Next.js framework not detected:** Even with Root Directory at repo root and vercel.json's outputDirectory pointing at apps/web/.next, Vercel's framework detector couldn't find "next" in the root package.json (only in apps/web/package.json).
6. **Vercel auto-selected Node 24 instead of 20:** .nvmrc was respected by Render but ignored by Vercel; required explicit setting in Vercel UI.
7. **ignoreCommand was too aggressive:** Empty trigger commits were skipped; required either real file changes or manual "Use project's Ignore Build Step" toggle off.

### Final Working Configuration

**vercel.json (at repo root):**
- "framework": "nextjs" — required for Vercel to route through Next.js
- "buildCommand": pnpm filters @fantom/shared then @fantom/web
- "installCommand": pnpm install --frozen-lockfile
- "outputDirectory": apps/web/.next
- "ignoreCommand": git diff against apps/web, packages/shared, AND vercel.json

**Root package.json:**
- "next": "14.2.0" added as a phantom dependency to satisfy Vercel's framework detector. Real installation lives in apps/web/ via pnpm workspaces.

**Vercel Project Settings UI:**
- Node.js Version: explicitly set to 20.x (do not rely on .nvmrc)
- Root Directory: BLANK (let vercel.json drive)
- Framework Preset: Other (vercel.json overrides)

### When Adding the Next App to the Monorepo (e.g., for new modules)
- Either: add it to the existing vercel.json's buildCommand pipeline
- Or: create a separate Vercel project for it with its own vercel.json

### When Reconnecting Git
- After a "Connect" action on Vercel, ALWAYS verify the webhook actually installed at github.com/jotonova/fantom/settings/hooks
- If no webhook appears, fully uninstall the Vercel GitHub App (github.com/settings/installations), then reinstall via Vercel's connect flow
- A Deploy Hook (under Project Settings → Git) is a reliable fallback when the auto-webhook fails

### Fast Manual Redeploy Recipe
For any commit that doesn't change apps/web or packages/shared but should still deploy (e.g., vercel.json edits):
1. Deployments tab → click latest deployment → Redeploy
2. UNCHECK "Use existing Build Cache"
3. UNCHECK "Use project's Ignore Build Step"
4. Confirm

---

## Decision #003 — Drizzle ORM, RLS-at-Row-Level, Slug-Based Tenant Resolution

**Date:** 2026-04-23
**Status:** Adopted
**Context:** F2 introduces the multi-tenancy schema and the migration system. Three foundational choices were made.

### Choice A: Drizzle ORM + drizzle-kit

**Options considered:** Drizzle ORM, Prisma, raw SQL with node-postgres, Kysely.

**Decision:** Drizzle ORM with drizzle-kit for migration management.

**Reasoning:**
- **TypeScript-native schema:** Schema is written in TypeScript (`packages/db/src/schema/`). No separate `.prisma` DSL to learn; schema types flow directly into application code.
- **Plain-SQL migrations:** `drizzle-kit generate` produces readable `.sql` files committed to the repo. Every migration is reviewable, diffable, and executable by hand if needed. Prisma's migrate generates opaque migration manifests.
- **Lightweight runtime:** Drizzle is a thin query builder on top of node-postgres. No shadow database, no separate migration daemon, no background processes.
- **RLS-friendly:** Drizzle doesn't abstract away the transaction layer — calling `set_config(...)` inside `db.transaction()` is natural and explicit.

**Consequences:**
- Migrations are generated (not written by hand), but the output is plain SQL — always reviewable before applying.
- Schema changes require running `pnpm --filter @fantom/db db:generate` locally and committing the generated file.

### Choice B: RLS Enforced at the Database Layer

**Options considered:** Application-level tenant filtering (WHERE tenant_id = ?), middleware enforcement only, database-level RLS.

**Decision:** Database-level RLS with a session GUC (`app.current_tenant_id`).

**Reasoning:**
- Application-level filtering is only as trustworthy as the application code. A missed `WHERE` clause leaks cross-tenant data.
- RLS policies live in the database and apply to every query regardless of which code path triggered it. A future developer adding a new route can't accidentally skip tenant isolation.
- PostgreSQL's `set_config(name, value, is_local := true)` sets the GUC for the duration of a single transaction, eliminating the risk of the tenant context leaking between requests via connection pool reuse.

**F2 limitation:** The app currently connects as the Render Postgres owner role, which bypasses RLS by default. The policies are in place and `set_config` is called correctly — enforcement becomes genuine once a non-BYPASSRLS `app_user` role is provisioned in F3.

**Consequences:**
- All tenant-scoped route handlers must wrap queries in a `db.transaction()` block that calls `set_config`.
- The initial system-level slug-to-ID lookup (in the tenant-context plugin) runs as the owner and therefore bypasses RLS — this is intentional and safe: it's a system operation, not a user query.

### Choice C: Slug-Based Tenant Resolution

**Options considered:** Numeric ID in header, UUID in header, slug in header, subdomain parsing.

**Decision:** Slug-based resolution via `X-Tenant-Slug` header (e.g. `novacor`), with a subdomain stub for F3.

**Reasoning:**
- Slugs are human-readable, debuggable in logs, and stable across environments. UUIDs work but make curl-based debugging painful.
- The `X-Tenant-Slug` header is explicit and visible — no magic path or subdomain parsing required in F2.
- The subdomain path (`novacor.fantomvid.com → slug = "novacor"`) is the long-term UX goal. A stub is left in `tenant-context.ts` so the F3 implementation has a clear insertion point.

**Consequences:**
- Web clients must include `X-Tenant-Slug` on every API request (or the API returns 401).
- Slugs must be globally unique across all tenants (enforced by `UNIQUE` constraint on `tenants.slug`).

---

## Decision #004 — F3 Authentication Strategy
**Date:** 2026-04-23
**Status:** Adopted
**Context:** F3 introduces user authentication. Fantom is an internal tool at this phase (Justin + Amy only). The auth model must be pragmatic and evolvable without over-engineering for a two-person system.

### Choice A: Per-User Password Auth (not shared code, not magic link, not OAuth)

**Decision:** Email + bcrypt password for F3. OAuth and magic links deferred.

**Reasoning:**
- Shared codes (e.g. "access code for the app") conflate auth with access control and are trivially brute-forced.
- Magic links require an email delivery pipeline (Resend/SES config, spam risk, inbox latency) — unnecessary overhead when the only users are Justin and Amy who can be seeded with known credentials.
- OAuth (Google, etc.) requires registering OAuth applications, handling callback URLs, and managing refresh flows for third-party tokens — significant surface area for a two-user internal tool.
- Bcrypt passwords are well-understood, easy to rotate, and the implementation is battle-tested.

**Consequences:**
- A password reset flow must be built before external users arrive (deferred to a future phase).
- Password strength is not enforced server-side yet — see mandatory rotation trigger below.

### Choice B: bcrypt Cost 12

**Decision:** Cost factor 12 (approximately 250–400ms per hash on modern hardware).

**Reasoning:**
- OWASP recommends cost ≥ 10. Cost 12 gives meaningful brute-force resistance without making the login endpoint feel slow at Fantom's current scale (essentially 0 concurrent logins).
- Cost 14 would be ~4× slower (1s+) — over-engineered for a two-user system.
- Cost factor is embedded in the bcrypt hash string, so it can be raised in a future migration by re-hashing on next login.

### Choice C: Access Token + Refresh Token Split

**Decision:** Short-lived JWTs (15 min) + long-lived opaque refresh tokens (30 days, stored as SHA-256 hash in `sessions` table).

**Reasoning:**
- Pure JWT (no refresh): a stolen token is valid for its entire lifetime with no revocation path. Unacceptable even for an internal tool.
- Pure sessions (server-side): requires a session store lookup on every request. Adds DB load on every API call.
- Access + refresh split: stateless verification on the hot path (JWT), revocable sessions via the `sessions` table (only consulted on refresh or logout). Industry-standard approach.
- Opaque refresh token (not a JWT): easier to revoke (just hash-match and set `revoked_at`). JWTs as refresh tokens require a blocklist, which adds complexity without benefit.

**Token rotation:** refresh always issues a new pair and revokes the old session. This limits the damage if a refresh token is captured in transit.

### Choice D: Postgres `app_user` Role

**Decision:** Create a restricted `app_user` Postgres role (NOSUPERUSER, no BYPASSRLS) and update `DATABASE_URL` to use it. Owner-role URL retained as `MIGRATE_DATABASE_URL` for migration runner only.

**Reasoning:**
- The application running as the owner role bypasses all RLS policies — the multi-tenant data isolation added in F2 is effectively theatre until this is fixed.
- `app_user` cannot bypass RLS, cannot create/drop tables, and cannot manage roles. The blast radius of a compromised API process is bounded to DML on the granted tables.
- Two connection strings (`DATABASE_URL` for the API, `MIGRATE_DATABASE_URL` for the migration runner) is a small operational cost for a meaningful security boundary.

**Consequences:**
- Justin must complete the DATABASE_URL rotation procedure in `docs/DEPLOYMENT.md → Database Role Hardening` after migration 0003 deploys.
- `db:generate` (drizzle-kit) must use `MIGRATE_DATABASE_URL` or the owner URL locally — `drizzle.config.ts` is updated accordingly.

---

---

## Decision #005 — F4 UI Library, Client-Side Auth, and Route Groups

**Date:** 2026-04-24
**Status:** Adopted
**Context:** F4 introduces the authenticated shell. Three foundational frontend choices were made.

### Choice A: @fantom/ui — Dedicated Workspace UI Package

**Decision:** New `packages/ui` workspace package with 8 Radix UI-based components.

**Reasoning:**
- Centralises all design system components so future apps (mobile, embed) import from one place.
- Radix UI provides WAI-ARIA-compliant accessibility primitives (keyboard nav, focus management, ARIA roles) without bespoke implementation.
- `clsx + tailwind-merge` as the `cn()` utility gives safe class merging without specificity fights.
- Package uses a standalone `tsconfig.json` (does NOT extend `tsconfig.base.json`) because the base config uses `module: NodeNext` (requires `.js` extensions on all imports) and `exactOptionalPropertyTypes: true` (conflicts with Radix UI prop types). The UI package uses `module: ESNext` + `moduleResolution: Bundler` + `jsx: react-jsx`.

**Consequences:**
- `apps/web/tailwind.config.ts` must scan `../../packages/ui/src/**/*.{ts,tsx}` so fantom token classes used in components are included in the CSS bundle.
- `apps/web/next.config.mjs` must include `@fantom/ui` in `transpilePackages`.
- `vercel.json` build command must compile `@fantom/ui` before `@fantom/web`.

### Choice B: Client-Side Auth State (React Context + localStorage)

**Decision:** Auth state lives in `AuthProvider` (React context), tokens in localStorage, no server-side session.

**Reasoning:**
- F4 hard constraint: no server-side API calls from Next.js server components. All data fetching is client-side.
- JWTs are short-lived (15 min) and already stateless — reading them from localStorage on the client avoids a server-side session store entirely.
- `AuthProvider` wraps the root layout via a `<Providers>` client component boundary, so `app/layout.tsx` remains a server component.
- 401 retry in `api-client.ts` uses an `isRefreshing` flag to prevent infinite refresh loops.

**Consequences:**
- Page.tsx for the landing page and protected layouts must be client components (they use `useAuth()`).
- Auth state is lost on hard refresh — the `useEffect` in `AuthProvider` calls `/me` on mount to restore it from the stored access token.
- localStorage is not available during SSR; all token reads are guarded with `typeof window !== 'undefined'`.

### Choice C: Next.js Route Groups for Auth Boundary

**Decision:** Protected pages live under `app/(authenticated)/`; the group layout enforces auth with `useEffect` redirect.

**Reasoning:**
- Route groups (`(name)`) segment routing without adding URL segments — `/dashboard` not `/(authenticated)/dashboard`.
- The group layout is the single enforcement point for auth; individual pages don't need to repeat the guard.
- `useEffect` redirect (not middleware) keeps the auth check client-side, consistent with the F4 no-server-fetching constraint.

**Consequences:**
- A flash of the loading spinner is possible on hard refresh to a protected page — acceptable for an internal tool.
- Middleware-based auth redirect (faster, no flash) is a straightforward future upgrade when server-side token verification is added.

---

### ⚠️ MANDATORY ROTATION TRIGGER

> **Before any external user (non-Justin, non-Amy) is added to Fantom, the following MUST happen:**
>
> 1. The default password `061284` must be rotated for all existing users via a dedicated password-change flow or direct DB update.
> 2. A minimum password policy must be enforced server-side (length ≥ 12, complexity rules).
> 3. Rate limiting on `/auth/login` must be verified active (currently: 5 req/min/IP).
>
> **This is a hard gate, not a suggestion.** Shipping external users with `061284` as a seeded password would be a critical security vulnerability. The password is in the git history — it is considered public knowledge and must not be used in any production-facing context beyond Justin and Amy's internal sessions.
