CREATE VIEW "public"."active_ethical_screens" WITH (security_invoker = true) AS (
    select cs.tenant_id, cs.screened_user_id as user_id, cs.matter_id, cs.intake_session_id,
           'conflict_screen'::text as source, cs.id as source_id, cs.status, cs.created_at as since
      from conflict_screens cs
     where cs.status in ('requested', 'active')
    union all
    select b.tenant_id, b.user_id, b.matter_id, null::uuid as intake_session_id,
           'document_access_block'::text as source, b.id as source_id, 'active'::text as status, b.created_at as since
      from document_access_blocks b
     where b.ended_at is null and b.reason = 'ethical_screen'
  );--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Hand-added (Drizzle's DSL does not express GRANTs or triggers).
--
-- NOTE: the public schema has ALTER DEFAULT PRIVILEGES granting app_runtime
-- (and, on Supabase, anon/authenticated) SELECT/INSERT/UPDATE/DELETE on every
-- new relation, views included, so every restriction below is an explicit
-- REVOKE.
--
-- No new tables. firm_role_assignments, permission_overrides and
-- user_capabilities only moved between Drizzle files (tables/all-engines.ts,
-- tables/platform.ts -> tables/foundation.ts); their SQL is unchanged.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. active_ethical_screens (src/core/screens.ts). A view, so it has no RLS
--    of its own: security_invoker = true (above) makes Postgres check the
--    CALLER's privileges and RLS on conflict_screens and
--    document_access_blocks, which both carry the tenant_isolation policy.
--    Read-only for the app; never exposed to the REST roles.
-- ---------------------------------------------------------------------------
REVOKE ALL ON "active_ethical_screens" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "active_ethical_screens" FROM app_runtime;--> statement-breakpoint
GRANT SELECT ON "active_ethical_screens" TO app_runtime;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. documents: a stored version's bytes can never be swapped in place
--    (c84: every upload is a NEW row; tables/document.ts MIGRATION NOTES 3).
--    Identity columns are frozen once set: storage_key, sha256, size_bytes,
--    mime_type (the bytes), version, version_group_id (which version of
--    which document), matter_id and tenant_id (whose document). A nullable
--    one may go from NULL to a value once (e.g. a checksum backfilled), never
--    change after that and never go back to NULL. Status, privilege tag,
--    client visibility, name and updated_at stay editable.
--    Plain (not SECURITY DEFINER) trigger function, search_path pinned.
-- ---------------------------------------------------------------------------
CREATE FUNCTION documents_version_content_frozen() RETURNS trigger LANGUAGE plpgsql
  SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.storage_key IS DISTINCT FROM OLD.storage_key
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.matter_id IS DISTINCT FROM OLD.matter_id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR (OLD.sha256 IS NOT NULL AND NEW.sha256 IS DISTINCT FROM OLD.sha256)
     OR (OLD.size_bytes IS NOT NULL AND NEW.size_bytes IS DISTINCT FROM OLD.size_bytes)
     OR (OLD.mime_type IS NOT NULL AND NEW.mime_type IS DISTINCT FROM OLD.mime_type)
     OR (OLD.version_group_id IS NOT NULL AND NEW.version_group_id IS DISTINCT FROM OLD.version_group_id)
  THEN
    RAISE EXCEPTION 'documents: a stored version''s content cannot change (document %); upload a new version instead', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER documents_version_content_frozen BEFORE UPDATE ON "documents"
  FOR EACH ROW EXECUTE FUNCTION documents_version_content_frozen();--> statement-breakpoint
-- Same hardening as 0006: never callable over Supabase's REST RPC endpoint.
REVOKE EXECUTE ON FUNCTION documents_version_content_frozen() FROM PUBLIC, anon, authenticated;--> statement-breakpoint

-- Version history never loses rows (c84). Destruction after the retention
-- clock (c90) runs under a separate, elevated purge role after a lawyer's
-- approval, not as app_runtime.
REVOKE DELETE, TRUNCATE ON "documents" FROM app_runtime;
