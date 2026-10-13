CREATE TABLE "demo_tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"label" text NOT NULL,
	"status" text DEFAULT 'seeding' NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"seed_version" text NOT NULL,
	"seed_report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seeded_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"retired_reason" text,
	"replaced_by_tenant_id" uuid,
	CONSTRAINT "demo_tenants_status_check" CHECK ("demo_tenants"."status" in ('seeding','active','retired')),
	CONSTRAINT "demo_tenants_label_check" CHECK (position('DEMO' in upper("demo_tenants"."label")) > 0),
	CONSTRAINT "demo_tenants_generation_check" CHECK ("demo_tenants"."generation" >= 1),
	CONSTRAINT "demo_tenants_retired_check" CHECK (("demo_tenants"."status" = 'retired') = ("demo_tenants"."retired_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "demo_tenants" ADD CONSTRAINT "demo_tenants_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "demo_tenants_tenant_key" ON "demo_tenants" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "demo_tenants_tenant_status_idx" ON "demo_tenants" USING btree ("tenant_id","status");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Hand-added (Drizzle's DSL does not express RLS, GRANTs or triggers).
-- Implements the MIGRATION NOTES in src/db/tables/demo.ts (c106).
-- Staging's default privileges grant app_runtime SELECT/INSERT/UPDATE/DELETE
-- on new tables, so every restriction below is an explicit REVOKE.
-- ---------------------------------------------------------------------------

ALTER TABLE "demo_tenants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "demo_tenants" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
REVOKE ALL ON "demo_tenants" FROM anon, authenticated;--> statement-breakpoint
-- The demo flag is history and must never vanish.
REVOKE DELETE, TRUNCATE ON "demo_tenants" FROM app_runtime;--> statement-breakpoint

-- The flag can only be planted on a brand-new, non-production firm created in
-- the same transaction (firms.created_at = now()), and a retired demo firm is
-- never revived. Runs as the caller (not SECURITY DEFINER), so RLS applies.
CREATE FUNCTION demo_tenants_guard() RETURNS trigger LANGUAGE plpgsql
  SET search_path = public, pg_temp AS $$
DECLARE f record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT is_production, created_at INTO f FROM firms WHERE id = NEW.tenant_id;
    IF NOT FOUND OR f.is_production OR f.created_at <> now() THEN
      RAISE EXCEPTION 'demo_tenants: only a brand-new, non-production firm can be flagged as the demo firm';
    END IF;
    IF NEW.status = 'retired' THEN
      RAISE EXCEPTION 'demo_tenants: cannot insert a retired row';
    END IF;
  ELSE
    IF NEW.tenant_id <> OLD.tenant_id OR NEW.generation <> OLD.generation OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'demo_tenants: tenant_id, generation and created_at are immutable';
    END IF;
    IF OLD.status = 'retired' AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'demo_tenants: a retired demo firm is never revived or edited';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER demo_tenants_guard BEFORE INSERT OR UPDATE ON "demo_tenants"
  FOR EACH ROW EXECUTE FUNCTION demo_tenants_guard();--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION demo_tenants_guard() FROM PUBLIC, anon, authenticated;
