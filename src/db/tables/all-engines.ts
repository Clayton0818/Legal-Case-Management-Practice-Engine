// Tables owned by the All-engines / cross-cutting items (c98–c105).
//
// Engine-specific tables go here. Shared tables live in ./foundation.ts and
// ../schema.ts (import from those; never redefine or edit them). Follow the
// conventions documented at the top of ./foundation.ts: NOT NULL tenantId ->
// firms.id on every tenant-scoped table, text + CHECK for statuses,
// timestamptz everywhere. Add any hand-written RLS/GRANT needs as a
// "MIGRATION NOTES" comment at the bottom of this file; migrations are
// generated once at integration time.
//
// c99  permissions: matter_access_settings, matter_team_members, access_change_log
//      (permission_overrides and firm_role_assignments moved to ./foundation.ts
//      in wave 3 so core can resolve roles; same SQL tables)
// c102 practice areas: practice_area_pack_adoptions (+ access_change_log)

import { sql } from "drizzle-orm";
import { pgTable, uuid, text, boolean, timestamp, jsonb, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { firms, users, matters } from "../schema";

// ---------------------------------------------------------------------------
// c99 — matter-level access on top of roles
// ---------------------------------------------------------------------------

/** A restricted matter is visible to its team only, whatever the role (e.g. a staff member's own case). */
export const matterAccessSettings = pgTable("matter_access_settings", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  restricted: boolean("restricted").notNull().default(false),
  reason: text("reason"),
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("matter_access_settings_matter_key").on(t.tenantId, t.matterId),
  check("matter_access_settings_reason_check", sql`not ${t.restricted} or ${t.reason} is not null`),
]);

/** Who is on a matter's team (besides matters.assigned_user_id). Removing someone sets removedAt. */
export const matterTeamMembers = pgTable("matter_team_members", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  /** Free label: 'responsible_lawyer', 'paralegal', 'bookkeeper', … */
  roleOnMatter: text("role_on_matter").notNull().default("member"),
  addedByUserId: uuid("added_by_user_id").references(() => users.id),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  removedAt: timestamp("removed_at", { withTimezone: true }),
  removedByUserId: uuid("removed_by_user_id").references(() => users.id),
}, (t) => [
  index("matter_team_members_tenant_matter_idx").on(t.tenantId, t.matterId),
  index("matter_team_members_tenant_user_idx").on(t.tenantId, t.userId),
  uniqueIndex("matter_team_members_active_key").on(t.tenantId, t.matterId, t.userId).where(sql`${t.removedAt} is null`),
]);

// ---------------------------------------------------------------------------
// c99 / c102 — append-only trail of every access and practice-area change
// ---------------------------------------------------------------------------

/**
 * Every permission, role, matter-access and practice-area change, with the
 * state before and after. APPEND-ONLY (no UPDATE/DELETE grant). The same
 * events are also written to the shared audit_events (c6).
 */
export const accessChangeLog = pgTable("access_change_log", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  /** 'permissions' | 'roles' | 'matter_access' | 'practice_areas' | 'packs'. */
  area: text("area").notNull(),
  /** Dotted action, e.g. 'override.set', 'role.granted', 'practice_area.enabled', 'pack.accepted'. */
  action: text("action").notNull(),
  actorType: text("actor_type").notNull(),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  targetUserId: uuid("target_user_id").references(() => users.id),
  matterId: uuid("matter_id").references(() => matters.id),
  role: text("role"),
  right: text("right"),
  practiceArea: text("practice_area"),
  before: jsonb("before").$type<Record<string, unknown> | null>(),
  after: jsonb("after").$type<Record<string, unknown> | null>(),
  reason: text("reason"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("access_change_log_tenant_occurred_idx").on(t.tenantId, t.occurredAt),
  index("access_change_log_tenant_area_idx").on(t.tenantId, t.area, t.occurredAt),
  index("access_change_log_tenant_target_idx").on(t.tenantId, t.targetUserId),
  check("access_change_log_area_check", sql`${t.area} in ('permissions','roles','matter_access','practice_areas','packs')`),
  check("access_change_log_actor_type_check", sql`${t.actorType} in ('system','user')`),
]);

// ---------------------------------------------------------------------------
// c102 — which version of each practice-area pack a firm has accepted
// ---------------------------------------------------------------------------

/**
 * A firm's accepted pack versions. The accepted row carries a snapshot of
 * the pack content, so a product update never changes what a firm uses
 * until the firm reviews and accepts it. Older acceptances are kept as
 * 'superseded' (history; no DELETE).
 */
export const practiceAreaPackAdoptions = pgTable("practice_area_pack_adoptions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  practiceArea: text("practice_area").notNull(),
  version: text("version").notNull(),
  contentHash: text("content_hash").notNull(),
  content: jsonb("content").$type<Record<string, unknown>>().notNull(),
  /** 'accepted' | 'superseded'. */
  status: text("status").notNull().default("accepted"),
  acceptedByUserId: uuid("accepted_by_user_id").references(() => users.id),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
  notes: text("notes"),
}, (t) => [
  index("practice_area_pack_adoptions_tenant_area_idx").on(t.tenantId, t.practiceArea, t.acceptedAt),
  uniqueIndex("practice_area_pack_adoptions_current_key").on(t.tenantId, t.practiceArea).where(sql`${t.status} = 'accepted'`),
  check("practice_area_pack_adoptions_status_check", sql`${t.status} in ('accepted','superseded')`),
  check("practice_area_pack_adoptions_area_check", sql`${t.practiceArea} in ('family','immigration','personal_injury')`),
]);

// ---------------------------------------------------------------------------
// MIGRATION NOTES for the integration step (hand-add to the generated SQL):
//
// 1. RLS + the standard tenant_isolation policy (same text as migrations/0000)
//    on every table in this file:
//    permission_overrides, firm_role_assignments, matter_access_settings,
//    matter_team_members, access_change_log, practice_area_pack_adoptions.
// 2. Staging grants app_runtime SELECT/INSERT/UPDATE/DELETE by default. Then:
//    - access_change_log is APPEND-ONLY (c6 / c99 "every permission change logged"):
//        REVOKE UPDATE, DELETE ON access_change_log FROM app_runtime;
//    - history tables keep every row (revoke/remove/supersede instead of delete):
//        REVOKE DELETE ON firm_role_assignments FROM app_runtime;
//        REVOKE DELETE ON matter_team_members FROM app_runtime;
//        REVOKE DELETE ON practice_area_pack_adoptions FROM app_runtime;
//        REVOKE DELETE ON matter_access_settings FROM app_runtime;
//    - permission_overrides KEEPS DELETE (clearing a cell back to its default
//      deletes the row; the change itself is in access_change_log).
//    - REVOKE ALL ON all six tables FROM anon, authenticated; (as migration 0004)
// 3. The role CHECK lists (now in ./foundation.ts) mirror FIRM_ROLES in
//    src/core/permissions.ts minus 'client'; keep them in sync.
// 4. Later (c99 follow-up): role-based RLS policies for party-index and
//    trust-reconciliation tables can call a SQL function that evaluates the
//    same matrix; until then the policy is enforced in code (can()).
// ---------------------------------------------------------------------------
