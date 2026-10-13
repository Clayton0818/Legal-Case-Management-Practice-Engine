// Demo engine tables (board card c106). Same conventions as ./foundation.ts:
// NOT NULL tenantId -> firms.id, text + CHECK for statuses, timestamptz.
//
// `demo_tenants` is THE flag that marks a firm as the fictional sales-demo
// firm. The demo reset (src/engines/demo/reset.ts) refuses to touch any firm
// that has no row here — the firm's name or slug alone never qualifies it.
//
// Reset never deletes: append-only tables (trust journal, access logs, audit)
// cannot be emptied by design, so a reset seeds a FRESH demo firm and marks
// the old one 'retired' here (and the firm row 'offboarded', so the worker
// stops ticking it).

import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, timestamp, jsonb, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { firms } from "../schema";

export const DEMO_TENANT_STATUSES = ["seeding", "active", "retired"] as const;
export type DemoTenantStatus = (typeof DEMO_TENANT_STATUSES)[number];

export const demoTenants = pgTable("demo_tenants", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  /** The demo firm. One row per firm, ever. */
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  /** Human label shown on the walkthrough, always containing "DEMO". */
  label: text("label").notNull(),
  status: text("status").notNull().default("seeding"),
  /** 1 for the first demo firm, +1 on every reset. */
  generation: integer("generation").notNull().default(1),
  /** Version of the seed module that filled this firm (src/engines/demo/fixtures.ts). */
  seedVersion: text("seed_version").notNull(),
  /** Per-step outcome of the seed: ok / blocked (pending approval) / failed. */
  seedReport: jsonb("seed_report").notNull().default({}),
  /** Who asked for it (free text: an operator name or "user:<id>@<tenant>"). */
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  seededAt: timestamp("seeded_at", { withTimezone: true }),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  retiredReason: text("retired_reason"),
  /** The fresh demo firm that replaced this one (no FK: cross-tenant pointer, informational). */
  replacedByTenantId: uuid("replaced_by_tenant_id"),
}, (t) => [
  uniqueIndex("demo_tenants_tenant_key").on(t.tenantId),
  index("demo_tenants_tenant_status_idx").on(t.tenantId, t.status),
  check("demo_tenants_status_check", sql`${t.status} in ('seeding','active','retired')`),
  check("demo_tenants_label_check", sql`position('DEMO' in upper(${t.label})) > 0`),
  check("demo_tenants_generation_check", sql`${t.generation} >= 1`),
  check(
    "demo_tenants_retired_check",
    sql`(${t.status} = 'retired') = (${t.retiredAt} is not null)`
  ),
]);

// ---------------------------------------------------------------------------
// MIGRATION NOTES for the integration step (hand-add to the generated SQL):
//
// 1. RLS + the standard tenant_isolation policy (same text as migrations/0000):
//      ALTER TABLE "demo_tenants" ENABLE ROW LEVEL SECURITY;
//      CREATE POLICY tenant_isolation ON "demo_tenants"
//        USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
//        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
//      REVOKE ALL ON "demo_tenants" FROM anon, authenticated;
//
// 2. Staging grants app_runtime SELECT/INSERT/UPDATE/DELETE by default.
//    The demo flag is history and must never vanish:
//      REVOKE DELETE ON "demo_tenants" FROM app_runtime;
//
// 3. The flag must be impossible to plant on an existing (real) firm. A demo
//    row may only be inserted in the SAME transaction that created the firm
//    (firms.created_at defaults to now(), which is constant per transaction),
//    and only for a non-production firm:
//
//      CREATE FUNCTION demo_tenants_guard() RETURNS trigger LANGUAGE plpgsql AS $$
//      DECLARE f record;
//      BEGIN
//        IF TG_OP = 'INSERT' THEN
//          SELECT is_production, created_at INTO f FROM firms WHERE id = NEW.tenant_id;
//          IF NOT FOUND OR f.is_production OR f.created_at <> now() THEN
//            RAISE EXCEPTION 'demo_tenants: only a brand-new, non-production firm can be flagged as the demo firm';
//          END IF;
//          IF NEW.status = 'retired' THEN RAISE EXCEPTION 'demo_tenants: cannot insert a retired row'; END IF;
//        ELSE -- UPDATE
//          IF NEW.tenant_id <> OLD.tenant_id OR NEW.generation <> OLD.generation OR NEW.created_at <> OLD.created_at THEN
//            RAISE EXCEPTION 'demo_tenants: tenant_id, generation and created_at are immutable';
//          END IF;
//          IF OLD.status = 'retired' AND NEW IS DISTINCT FROM OLD THEN
//            RAISE EXCEPTION 'demo_tenants: a retired demo firm is never revived or edited';
//          END IF;
//        END IF;
//        RETURN NEW;
//      END $$;
//      CREATE TRIGGER demo_tenants_guard BEFORE INSERT OR UPDATE ON "demo_tenants"
//        FOR EACH ROW EXECUTE FUNCTION demo_tenants_guard();
//      REVOKE EXECUTE ON FUNCTION demo_tenants_guard() FROM PUBLIC, anon, authenticated;
//
//    (Not SECURITY DEFINER: app_runtime can already read `firms`.)
//
// 4. No change to any other table. The demo writes its fictional data through
//    the engines' own services, so their tables' policies/grants apply as-is.
// ---------------------------------------------------------------------------
