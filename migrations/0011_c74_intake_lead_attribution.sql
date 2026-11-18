-- 0011: c74 lead-source attribution (PR #94).
-- Creates intake_lead_attribution, the one table c74 adds
-- (src/db/tables/intake.ts). Written to match what drizzle-kit emits for
-- that table definition, plus the hand-written RLS/GRANT section at the end,
-- per MIGRATION NOTES #1, #2 and #7 at the bottom of src/db/tables/intake.ts.
-- Safe to land before PR #94: the table is simply unused until that code merges.
CREATE TABLE "intake_lead_attribution" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"intake_session_id" uuid NOT NULL,
	"landing_page" text,
	"campaign_tag" text,
	"is_google_ads" boolean DEFAULT false NOT NULL,
	"directory_name" text,
	"referral_source" text,
	"phone_tracking_number" text,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "intake_lead_attribution" ADD CONSTRAINT "intake_lead_attribution_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_lead_attribution" ADD CONSTRAINT "intake_lead_attribution_intake_session_id_intake_sessions_id_fk" FOREIGN KEY ("intake_session_id") REFERENCES "public"."intake_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "intake_lead_attribution_session_key" ON "intake_lead_attribution" USING btree ("tenant_id","intake_session_id");--> statement-breakpoint
CREATE INDEX "intake_lead_attribution_google_ads_idx" ON "intake_lead_attribution" USING btree ("tenant_id","is_google_ads");--> statement-breakpoint
CREATE INDEX "intake_lead_attribution_phone_tracking_idx" ON "intake_lead_attribution" USING btree ("tenant_id","phone_tracking_number");
--> statement-breakpoint
-- Hand-written: RLS, tenant isolation, grants (see the c74 MIGRATION NOTE).
-- Not append-only: staff correct attribution after the fact, so app_runtime
-- keeps UPDATE and DELETE like the other non-history intake tables.
ALTER TABLE "intake_lead_attribution" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake_lead_attribution" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "intake_lead_attribution" TO app_runtime;
--> statement-breakpoint
REVOKE ALL ON "intake_lead_attribution" FROM anon, authenticated;
