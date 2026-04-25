-- F9a: Add platform_admin to tenant_user_role enum.
-- Must be a standalone migration — PostgreSQL does not allow using a newly added
-- enum value in the same transaction that added it. The UPDATE that seeds Justin's
-- role to 'platform_admin' lives in 0009_observability.sql, which runs in a
-- separate committed transaction after this one.
ALTER TYPE "tenant_user_role" ADD VALUE IF NOT EXISTS 'platform_admin';
