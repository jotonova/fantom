-- F3: Auth schema additions.
-- Adds password columns to users and creates the sessions table.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_updated_at" timestamp with time zone;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"user_agent" text,
	"ip_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_user_id_idx" ON "sessions"("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_token_hash_idx" ON "sessions"("token_hash");--> statement-breakpoint

-- RLS is intentionally NOT enabled on sessions.
-- Rationale: sessions are security tokens, not tenant-scoped data.
-- The login flow is a chicken-and-egg: we need to read the session to establish
-- tenant context, so we cannot require tenant context to read the session.
-- Security is provided by: (1) token_hash — raw token never stored, (2) expiry
-- and revocation checks in application code, (3) app_user role grants (migration 0003).

-- Additional RLS policy on tenant_users: allow a user to read their own memberships
-- before tenant context is established (needed for the login endpoint to discover
-- which tenants a user belongs to). The existing tenant_users_isolation policy
-- handles all other access; this policy is additive (PERMISSIVE = OR logic).
CREATE POLICY "tenant_users_own_memberships" ON "tenant_users"
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING ("user_id"::text = current_setting('app.current_user_id', true));
