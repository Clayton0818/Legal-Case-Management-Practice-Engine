// Shared case-management tables (case-management foundation, 2026-09-26).
//
// Every engine (src/engines/<slug>/) may import from this file and from
// src/db/schema.ts; neither file may be edited by an engine. Engine-specific
// tables go in src/db/tables/<slug>.ts.
//
// Engines: see src/engines/README.md for the full layout/import contract.
//
// Conventions, identical to src/db/schema.ts:
//  - every tenant-scoped table has a NOT NULL `tenantId` -> firms.id and gets
//    the standard `tenant_isolation` RLS policy in the generated migration
//    (hand-added, since Drizzle's DSL does not express RLS — see
//    migrations/0000_*.sql for the exact policy text);
//  - status-like columns are text + CHECK constraints (easy to read in SQL);
//  - timestamps are timestamptz.
//
// Migrations are NOT generated here. The integration step runs
// `npm run db:generate` once, after every engine's tables exist, and then
// hand-adds RLS policies and GRANTs. MIGRATION NOTES for that step are at the
// bottom of this file.
//
// Existing tables are reused, not duplicated: firms, users, matters,
// intake_sessions, intake_events, conflict_check_results, scheduled_tasks and
// outbox stay in schema.ts; `parties`, `matter_parties` and `documents` were
// extended in place there (additive columns only).

import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  bigint,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
  pgView,
} from "drizzle-orm/pg-core";
import { firms, users, matters, parties, intakeSessions } from "../schema";
import type {
  WeeklyHours,
  FirmHoliday,
  QuietHours,
  EngineSettings,
} from "../types";

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

/**
 * The contact registry. This is the SAME SQL table as `parties` in
 * schema.ts (extended there with aliases, emails, phones, safe-contact
 * preferences and DV sensitivity) — one registry for every engine, so the
 * conflict-check party index (c56) sees every person any engine records.
 */
export const contacts = parties;

// ---------------------------------------------------------------------------
// Firm settings (one row per firm)
// ---------------------------------------------------------------------------

export const DEFAULT_WEEKLY_HOURS: WeeklyHours = {
  mon: [{ start: "09:00", end: "17:00" }],
  tue: [{ start: "09:00", end: "17:00" }],
  wed: [{ start: "09:00", end: "17:00" }],
  thu: [{ start: "09:00", end: "17:00" }],
  fri: [{ start: "09:00", end: "17:00" }],
};

export const firmSettings = pgTable("firm_settings", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),

  // --- Business calendar (founder decision: firm timers count BUSINESS hours) ---
  /** IANA time zone, e.g. 'America/Chicago' (Texas pilot default). */
  timeZone: text("time_zone").notNull().default("America/Chicago"),
  businessHours: jsonb("business_hours").$type<WeeklyHours>().notNull().default(DEFAULT_WEEKLY_HOURS),
  holidays: jsonb("holidays").$type<FirmHoliday[]>().notNull().default([]),

  // --- Practice areas (c102). Family Law is the pilot default (c103). ---
  enabledPracticeAreas: text("enabled_practice_areas").array().notNull().default(sql`'{family}'::text[]`),

  // --- Response timers (hours; business hours unless noted) ---
  /** c43: internal target for the firm to reply to a client message. */
  firmReplyHours: integer("firm_reply_hours").notNull().default(24),
  /** c43: the reply time promised to the client. */
  clientPromiseHours: integer("client_promise_hours").notNull().default(48),
  /** c44: internal flag for deadline-related client questions. */
  deadlineQuestionFlagHours: integer("deadline_question_flag_hours").notNull().default(12),
  /** c44: reply promised to the client for deadline-related questions. */
  deadlineQuestionReplyHours: integer("deadline_question_reply_hours").notNull().default(24),
  /** c42: default response window for firm -> client correspondence. */
  clientResponseWindowHours: integer("client_response_window_hours").notNull().default(48),
  /** c45: "due soon" warning before a task's due time (default one business day). */
  dueSoonBusinessHours: integer("due_soon_business_hours").notNull().default(8),
  /** c45: grace before an overdue task escalates to supervisor + admin. */
  overdueGraceBusinessHours: integer("overdue_grace_business_hours").notNull().default(8),
  /** c64: court-notice acknowledgement window, REAL-clock minutes. */
  courtNoticeAckMinutes: integer("court_notice_ack_minutes").notNull().default(120),
  /** c69: speed-to-lead target, business minutes. */
  newInquiryResponseMinutes: integer("new_inquiry_response_minutes").notNull().default(15),

  // --- Money (founder decision: $4,500 retainer floor) ---
  retainerFloorCents: bigint("retainer_floor_cents", { mode: "number" }).notNull().default(450000),
  /** Optional early warning above the floor (c50), e.g. 600000 = $6,000. */
  retainerWarningCents: bigint("retainer_warning_cents", { mode: "number" }),

  // --- Notifications (c51) ---
  /** Quiet hours for non-urgent client messages. Null = none. */
  quietHours: jsonb("quiet_hours").$type<QuietHours | null>(),
  /** Group non-urgent internal flag emails into a daily digest. */
  internalEmailDigest: boolean("internal_email_digest").notNull().default(false),
  /** Sender identity: emails come from the firm's own name/domain. */
  emailFromName: text("email_from_name"),
  emailFromAddress: text("email_from_address"),
  emailReplyTo: text("email_reply_to"),
  /** Base URL of the client portal, used in minimal client emails. */
  clientPortalUrl: text("client_portal_url"),

  // --- Extension point: per-engine settings (keyed by engine slug) ---
  engineSettings: jsonb("engine_settings").$type<EngineSettings>().notNull().default({}),

  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
}, (table) => [
  uniqueIndex("firm_settings_tenant_key").on(table.tenantId),
  check("firm_settings_retainer_floor_check", sql`${table.retainerFloorCents} >= 0`),
  check(
    "firm_settings_hours_positive_check",
    sql`${table.firmReplyHours} > 0 and ${table.clientPromiseHours} > 0 and ${table.deadlineQuestionFlagHours} > 0 and ${table.deadlineQuestionReplyHours} > 0`
  ),
]);

// ---------------------------------------------------------------------------
// Calendar events (c91 is the owning engine; shared because every alert
// engine reads it)
// ---------------------------------------------------------------------------

export const calendarEvents = pgTable("calendar_events", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  /** Null only for firm-wide events (e.g. office closures). */
  matterId: uuid("matter_id").references(() => matters.id),
  /** 'hearing' | 'trial' | 'deposition' | 'mediation' | 'filing_deadline' | 'response_deadline' |
   *  'limitation_date' | 'consultation' | 'client_meeting' | 'internal' | 'other' (free text; engines may add). */
  eventType: text("event_type").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  allDay: boolean("all_day").notNull().default(false),
  location: text("location"),
  courtName: text("court_name"),
  causeNumber: text("cause_number"),
  /** True for deadlines (filing, response, limitation). Deadlines use the REAL clock. */
  isDeadline: boolean("is_deadline").notNull().default(false),
  /** Where the date came from. AI suggestions are never 'confirmed' without a lawyer. */
  source: text("source").notNull().default("lawyer_entry"),
  sourceRef: text("source_ref"),
  /** 'proposed' until a lawyer confirms it (the AI never decides a deadline). */
  status: text("status").notNull().default("proposed"),
  confirmedByUserId: uuid("confirmed_by_user_id").references(() => users.id),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  /** Users attending / responsible. */
  assignedUserIds: uuid("assigned_user_ids").array().notNull().default(sql`'{}'::uuid[]`),
  /** External calendar ids keyed by provider (sync is vendor-gated: 'vendor.calendar_sync'). */
  externalRefs: jsonb("external_refs").$type<Record<string, string>>().notNull().default({}),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancelReason: text("cancel_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("calendar_events_tenant_starts_idx").on(table.tenantId, table.startsAt),
  index("calendar_events_tenant_matter_idx").on(table.tenantId, table.matterId, table.startsAt),
  check(
    "calendar_events_source_check",
    sql`${table.source} in ('lawyer_entry','staff_entry','ai_suggestion','court_notice','deadline_calculator','consult_booking','external_sync','import')`
  ),
  check("calendar_events_status_check", sql`${table.status} in ('proposed','confirmed','cancelled')`),
  // A confirmed event always names the person who confirmed it.
  check(
    "calendar_events_confirmed_by_check",
    sql`${table.status} <> 'confirmed' or (${table.confirmedByUserId} is not null and ${table.confirmedAt} is not null)`
  ),
]);

// ---------------------------------------------------------------------------
// Tasks (one mechanism for every due item: c40–c46, c49, c52, c54, c69 …)
// ---------------------------------------------------------------------------

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").references(() => matters.id),
  intakeSessionId: uuid("intake_session_id").references(() => intakeSessions.id),
  /** Machine key of the task kind, namespaced by engine: e.g. 'calendar.firm_reply_due'. */
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  /** 'user' (a lawyer/staff member), 'client' (a party), or 'firm' (unassigned firm work). */
  ownerType: text("owner_type").notNull(),
  ownerUserId: uuid("owner_user_id").references(() => users.id),
  ownerPartyId: uuid("owner_party_id").references(() => parties.id),
  /** Supervising lawyer to escalate to (c45). */
  supervisorUserId: uuid("supervisor_user_id").references(() => users.id),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  /** True: overdue/grace measured in firm business hours. False: real clock. */
  usesBusinessHours: boolean("uses_business_hours").notNull().default(true),
  /** Tied to a court date, filing deadline or limitation date: flagged immediately,
   *  highest severity, REAL clock, no grace (c45, c44 safety net). */
  deadlineCritical: boolean("deadline_critical").notNull().default(false),
  /** 'open' | 'done' | 'cancelled'. */
  status: text("status").notNull().default("open"),
  /** 'internal' (firm only — c45) or 'client' (shown to the owning client — c46). */
  visibility: text("visibility").notNull().default("internal"),
  /** Board card that created it, e.g. 'c43'. */
  sourceCard: text("source_card"),
  /** Pointer to the engine record behind the task (e.g. 'message:<uuid>'). */
  sourceRef: text("source_ref"),
  relatedCalendarEventId: uuid("related_calendar_event_id").references(() => calendarEvents.id),
  /** Engine-specific extra data. Internal only — never sent to clients. */
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  completedByUserId: uuid("completed_by_user_id").references(() => users.id),
  completedByPartyId: uuid("completed_by_party_id").references(() => parties.id),
  /** Why the task was completed/cancelled/reassigned/re-dated — no silent clearing (c45). */
  lastChangeReason: text("last_change_reason"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("tasks_tenant_status_due_idx").on(table.tenantId, table.status, table.dueAt),
  index("tasks_tenant_matter_idx").on(table.tenantId, table.matterId),
  index("tasks_tenant_owner_user_idx").on(table.tenantId, table.ownerUserId, table.status),
  index("tasks_tenant_owner_party_idx").on(table.tenantId, table.ownerPartyId, table.status),
  check("tasks_owner_type_check", sql`${table.ownerType} in ('user','client','firm')`),
  check(
    "tasks_owner_consistency_check",
    sql`(${table.ownerType} = 'user' and ${table.ownerUserId} is not null and ${table.ownerPartyId} is null)
      or (${table.ownerType} = 'client' and ${table.ownerPartyId} is not null and ${table.ownerUserId} is null)
      or (${table.ownerType} = 'firm' and ${table.ownerUserId} is null and ${table.ownerPartyId} is null)`
  ),
  check("tasks_status_check", sql`${table.status} in ('open','done','cancelled')`),
  check("tasks_visibility_check", sql`${table.visibility} in ('internal','client')`),
  // Only a client's own tasks can be client-visible.
  check("tasks_client_visibility_check", sql`${table.visibility} = 'internal' or ${table.ownerType} = 'client'`),
]);

// ---------------------------------------------------------------------------
// Flags (every alert on the board; audience decides who may ever see it)
// ---------------------------------------------------------------------------

export const flags = pgTable("flags", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  /** Namespaced type, e.g. 'task.overdue', 'calendar.client_non_response', 'billing.retainer_below_floor'. */
  type: text("type").notNull(),
  /** 'info' | 'warning' | 'high' | 'critical'. */
  severity: text("severity").notNull(),
  /** 'internal' (firm users only — founder rule for overdue flags), 'client', or 'both'. */
  audience: text("audience").notNull(),
  matterId: uuid("matter_id").references(() => matters.id),
  taskId: uuid("task_id").references(() => tasks.id),
  /** Internal headline. Never shown to a client. */
  title: text("title").notNull(),
  /** Internal detail text. Never shown to a client. */
  summary: text("summary"),
  /** Internal structured detail (why it fired, durations …). Never shown to a client. */
  details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  /** legalCopy() gate key rendered on the client side for client/both flags. */
  clientCopyKey: text("client_copy_key"),
  /** Firm users this flag is for (in-app + email). */
  recipientUserIds: uuid("recipient_user_ids").array().notNull().default(sql`'{}'::uuid[]`),
  /** Client parties this flag is for (only allowed when audience is client/both). */
  recipientPartyIds: uuid("recipient_party_ids").array().notNull().default(sql`'{}'::uuid[]`),
  /** One open flag per dedupe key (e.g. 'task.overdue:<taskId>'). */
  dedupeKey: text("dedupe_key"),
  urgent: boolean("urgent").notNull().default(false),
  /** Sensitive flags are not emailed to parties who opted out of sensitive email (DV-safe, c51). */
  sensitive: boolean("sensitive").notNull().default(false),
  escalationLevel: integer("escalation_level").notNull().default(0),
  lastEscalatedAt: timestamp("last_escalated_at", { withTimezone: true }),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  acknowledgedByUserId: uuid("acknowledged_by_user_id").references(() => users.id),
  raisedByType: text("raised_by_type").notNull().default("system"),
  raisedByUserId: uuid("raised_by_user_id").references(() => users.id),
  sourceCard: text("source_card"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedByUserId: uuid("resolved_by_user_id").references(() => users.id),
  resolutionReason: text("resolution_reason"),
  /** c47: "waiting on the court until Oct 10" — a check-back date recorded with the reason. */
  checkBackAt: timestamp("check_back_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("flags_tenant_open_idx").on(table.tenantId, table.resolvedAt, table.severity),
  index("flags_tenant_matter_idx").on(table.tenantId, table.matterId),
  index("flags_tenant_task_idx").on(table.tenantId, table.taskId),
  uniqueIndex("flags_open_dedupe_key")
    .on(table.tenantId, table.dedupeKey)
    .where(sql`${table.resolvedAt} is null and ${table.dedupeKey} is not null`),
  check("flags_severity_check", sql`${table.severity} in ('info','warning','high','critical')`),
  check("flags_audience_check", sql`${table.audience} in ('internal','client','both')`),
  // Internal flags can never be addressed to a client (founder rule, c45).
  check(
    "flags_internal_no_party_recipients_check",
    sql`${table.audience} <> 'internal' or cardinality(${table.recipientPartyIds}) = 0`
  ),
  // No silent clearing: a resolved flag always carries a reason.
  check(
    "flags_resolution_reason_check",
    sql`${table.resolvedAt} is null or (${table.resolutionReason} is not null and length(${table.resolutionReason}) > 0)`
  ),
  check("flags_raised_by_type_check", sql`${table.raisedByType} in ('system','user','client','ai')`),
]);

// ---------------------------------------------------------------------------
// Notification outbox (in-app, email, SMS). Separate from schema.ts's
// `outbox`, which is for practice-management-tool integrations (c5).
// ---------------------------------------------------------------------------

export const notificationOutbox = pgTable("notification_outbox", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  /** 'in_app' | 'email' | 'sms'. Each channel is its own row, so one failing never blocks another (c51). */
  channel: text("channel").notNull(),
  /** 'user' (firm staff) or 'party' (client / other contact). */
  recipientType: text("recipient_type").notNull(),
  recipientUserId: uuid("recipient_user_id").references(() => users.id),
  recipientPartyId: uuid("recipient_party_id").references(() => parties.id),
  /** Resolved destination (safe email / consented phone). Null for in_app. */
  recipientAddress: text("recipient_address"),
  /** For party recipients: a legalCopy() gate key. For users: a free internal template key. */
  templateKey: text("template_key").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  matterId: uuid("matter_id").references(() => matters.id),
  flagId: uuid("flag_id").references(() => flags.id),
  urgent: boolean("urgent").notNull().default(false),
  /**
   * 'pending'    queued for the worker
   * 'held'       blocked by a pending approval gate (vendor DPA / copy review) or the stub provider — nothing sent
   * 'sent'       handed to the provider
   * 'delivered'  provider confirmed (in_app rows are delivered on insert)
   * 'bounced' | 'failed'
   * 'suppressed' deliberately not sent (no safe address, no SMS consent, opted out) — reason in last_error
   * 'cancelled'
   */
  status: text("status").notNull().default("pending"),
  /** Do not send before this instant (quiet hours, digests). */
  notBefore: timestamp("not_before", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  provider: text("provider"),
  providerMessageId: text("provider_message_id"),
  dedupeKey: text("dedupe_key"),
  readAt: timestamp("read_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("notification_outbox_tenant_status_idx").on(table.tenantId, table.status, table.notBefore),
  index("notification_outbox_tenant_user_idx").on(table.tenantId, table.recipientUserId, table.channel),
  index("notification_outbox_tenant_party_idx").on(table.tenantId, table.recipientPartyId, table.channel),
  uniqueIndex("notification_outbox_dedupe_key")
    .on(table.tenantId, table.dedupeKey)
    .where(sql`${table.dedupeKey} is not null`),
  check("notification_outbox_channel_check", sql`${table.channel} in ('in_app','email','sms')`),
  check("notification_outbox_recipient_type_check", sql`${table.recipientType} in ('user','party')`),
  check(
    "notification_outbox_recipient_consistency_check",
    sql`(${table.recipientType} = 'user' and ${table.recipientUserId} is not null and ${table.recipientPartyId} is null)
      or (${table.recipientType} = 'party' and ${table.recipientPartyId} is not null and ${table.recipientUserId} is null)`
  ),
  check(
    "notification_outbox_status_check",
    sql`${table.status} in ('pending','held','sent','delivered','bounced','failed','suppressed','cancelled')`
  ),
]);

// ---------------------------------------------------------------------------
// Audit events for every engine. `intake_events` (schema.ts) stays the audit
// log for intake sessions; it requires an intake_session_id, so matter-level
// actions from the other engines land here. Append-only (see notes below).
// ---------------------------------------------------------------------------

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  /** Engine slug that wrote the event: 'intake', 'conflict-check', 'document', 'calendar-alerts', … or 'core'. */
  engine: text("engine").notNull(),
  /** Dotted action name, e.g. 'task.completed', 'flag.raised', 'approval.blocked'. */
  action: text("action").notNull(),
  entityType: text("entity_type"),
  entityId: uuid("entity_id"),
  matterId: uuid("matter_id").references(() => matters.id),
  intakeSessionId: uuid("intake_session_id").references(() => intakeSessions.id),
  actorType: text("actor_type").notNull(),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  actorPartyId: uuid("actor_party_id").references(() => parties.id),
  /** Human reason where one is required (clearing flags, changing dates …). */
  reason: text("reason"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("audit_events_tenant_matter_idx").on(table.tenantId, table.matterId, table.occurredAt),
  index("audit_events_tenant_entity_idx").on(table.tenantId, table.entityType, table.entityId),
  index("audit_events_tenant_occurred_idx").on(table.tenantId, table.occurredAt),
  check("audit_events_actor_type_check", sql`${table.actorType} in ('system','user','client','ai')`),
]);

// ---------------------------------------------------------------------------
// Compliance approvals (platform-level — NOT tenant-scoped)
// ---------------------------------------------------------------------------

/**
 * One row per reviewer sign-off on an approval gate defined in
 * src/compliance/approvals.ts. Platform-level, like `firms`: the approvals
 * are about the product's wording, rules and vendors, not one firm's data.
 * The app role may only SELECT this table; sign-offs are recorded by an
 * operator with the elevated migrations role (see src/compliance/cli.ts).
 */
export const complianceApprovals = pgTable("compliance_approvals", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  gateKey: text("gate_key").notNull(),
  /** 'attorney' | 'cpa' | 'vendor_dpa' | 'founder_decision'. */
  reviewerKind: text("reviewer_kind").notNull(),
  approvedByName: text("approved_by_name").notNull(),
  approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
  notes: text("notes"),
  /** The exact approved wording (copy gates). Overrides the gate's draft. */
  approvedText: text("approved_text"),
  /** Hash of the gate draft that was reviewed; a changed draft invalidates the approval. */
  draftHash: text("draft_hash"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedReason: text("revoked_reason"),
}, (table) => [
  index("compliance_approvals_gate_idx").on(table.gateKey, table.reviewerKind),
  check(
    "compliance_approvals_reviewer_kind_check",
    sql`${table.reviewerKind} in ('attorney','cpa','vendor_dpa','founder_decision')`
  ),
]);

// ---------------------------------------------------------------------------
// Roles and capabilities (wave 3: moved here from tables/platform.ts and
// tables/all-engines.ts, unchanged, so src/core/permissionActor.ts can resolve
// an actor's roles without importing an engine's table file. Same SQL tables;
// no schema change.)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// c34 — capabilities layered on top of users.role
// ---------------------------------------------------------------------------

/**
 * Extra capabilities granted to a user on top of their role (see
 * src/auth/rbac.ts). History is kept: a revoke sets revokedAt + reason, and a
 * fresh grant inserts a new row.
 */
export const userCapabilities = pgTable("user_capabilities", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  /** 'conflicts_attorney' | 'bookkeeper'. */
  capability: text("capability").notNull(),
  grantedByUserId: uuid("granted_by_user_id").references(() => users.id),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  grantReason: text("grant_reason").notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedByUserId: uuid("revoked_by_user_id").references(() => users.id),
  revokeReason: text("revoke_reason"),
}, (table) => [
  index("user_capabilities_tenant_user_idx").on(table.tenantId, table.userId),
  uniqueIndex("user_capabilities_active_key")
    .on(table.tenantId, table.userId, table.capability)
    .where(sql`${table.revokedAt} is null`),
  check("user_capabilities_capability_check", sql`${table.capability} in ('conflicts_attorney','bookkeeper')`),
  check(
    "user_capabilities_revoke_reason_check",
    sql`${table.revokedAt} is null or ${table.revokeReason} is not null`
  ),
]);

/** Staff roles a row may name (client is never stored: portal access comes from the matter). Keep in sync with FIRM_ROLES in src/core/permissions.ts. */
const STAFF_ROLE_SQL = sql.raw(
  "('owner','admin','lawyer','paralegal','intake_staff','bookkeeper','conflicts_attorney','read_only')"
);

// ---------------------------------------------------------------------------
// c99 — per-firm overrides of the role × right matrix
// ---------------------------------------------------------------------------

/**
 * One row per (role, right) the firm changed from the product default. Only
 * real differences are stored (setting a cell back to its default deletes
 * the row). Every change is written to access_change_log first.
 */
export const permissionOverrides = pgTable("permission_overrides", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  role: text("role").notNull(),
  /** A right key from RIGHTS (src/core/permissions.ts), e.g. 'conflicts.party_index'. */
  right: text("right").notNull(),
  /** 'grant' | 'deny'. */
  effect: text("effect").notNull(),
  reason: text("reason").notNull(),
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("permission_overrides_role_right_key").on(t.tenantId, t.role, t.right),
  check("permission_overrides_effect_check", sql`${t.effect} in ('grant','deny')`),
  check("permission_overrides_role_check", sql`${t.role} in ${STAFF_ROLE_SQL}`),
]);

// ---------------------------------------------------------------------------
// c99 — product roles assigned on top of the c34 account role
// ---------------------------------------------------------------------------

/**
 * Roles beyond what users.role (+ c34 capabilities) implies: owner,
 * paralegal, extra bookkeeper / conflicts-attorney designations. History is
 * kept: revoking sets revokedAt + reason, a new grant inserts a new row.
 */
export const firmRoleAssignments = pgTable("firm_role_assignments", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  role: text("role").notNull(),
  grantedByUserId: uuid("granted_by_user_id").references(() => users.id),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  grantReason: text("grant_reason").notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedByUserId: uuid("revoked_by_user_id").references(() => users.id),
  revokeReason: text("revoke_reason"),
}, (t) => [
  index("firm_role_assignments_tenant_user_idx").on(t.tenantId, t.userId),
  uniqueIndex("firm_role_assignments_active_key").on(t.tenantId, t.userId, t.role).where(sql`${t.revokedAt} is null`),
  check("firm_role_assignments_role_check", sql`${t.role} in ${STAFF_ROLE_SQL}`),
  check("firm_role_assignments_revoke_reason_check", sql`${t.revokedAt} is null or ${t.revokeReason} is not null`),
]);


// ---------------------------------------------------------------------------
// Ethical screens, shared read model (wave 3)
// ---------------------------------------------------------------------------

/**
 * Every ethical screen in force, whichever engine recorded it: a VIEW (not a
 * table) over the two places screens are written today, so there is nothing
 * to keep in sync and no second copy to drift:
 *   - conflict_screens (conflict-check, c60) with status 'requested' or
 *     'active'. A requested screen already screens: conflict-check's own
 *     reader treats anything not 'lifted' as screened (fail closed);
 *   - document_access_blocks (document, c84) that are open (ended_at null)
 *     and have reason 'ethical_screen'. 'restricted'/'other' blocks only
 *     hide documents and stay local to the document engine.
 * Intake-session screens (matter_id null) are included; matter readers
 * filter on matter_id.
 *
 * security_invoker = true, so the caller's RLS on both base tables applies
 * (tenant isolation comes from the base tables, not the view). Read it only
 * through src/core/screens.ts. SELECT-only for app_runtime (see 0007).
 */
export const activeEthicalScreens = pgView("active_ethical_screens", {
  tenantId: uuid("tenant_id").notNull(),
  userId: uuid("user_id").notNull(),
  matterId: uuid("matter_id"),
  intakeSessionId: uuid("intake_session_id"),
  /** 'conflict_screen' | 'document_access_block'. */
  source: text("source").notNull(),
  /** conflict_screens.id or document_access_blocks.id. */
  sourceId: uuid("source_id").notNull(),
  /** conflict_screens.status ('requested' | 'active'), or 'active' for a block. */
  status: text("status").notNull(),
  since: timestamp("since", { withTimezone: true }).notNull(),
})
  .with({ securityInvoker: true })
  .as(sql`
    select cs.tenant_id, cs.screened_user_id as user_id, cs.matter_id, cs.intake_session_id,
           'conflict_screen'::text as source, cs.id as source_id, cs.status, cs.created_at as since
      from conflict_screens cs
     where cs.status in ('requested', 'active')
    union all
    select b.tenant_id, b.user_id, b.matter_id, null::uuid as intake_session_id,
           'document_access_block'::text as source, b.id as source_id, 'active'::text as status, b.created_at as since
      from document_access_blocks b
     where b.ended_at is null and b.reason = 'ethical_screen'
  `);

// ---------------------------------------------------------------------------
// MIGRATION NOTES for the integration step (hand-add to the generated SQL):
//
// 1. RLS + tenant_isolation policy (same text as migrations/0000) on:
//    firm_settings, calendar_events, tasks, flags, notification_outbox, audit_events.
// 2. GRANT SELECT, INSERT, UPDATE, DELETE ON firm_settings, calendar_events,
//    tasks, flags, notification_outbox TO app_runtime;
// 3. audit_events is append-only (c6 §3):
//    GRANT SELECT, INSERT ON audit_events TO app_runtime;
//    REVOKE UPDATE, DELETE ON audit_events FROM app_runtime;
// 4. compliance_approvals is platform-level: ENABLE RLS, then
//    CREATE POLICY app_runtime_read ON compliance_approvals FOR SELECT TO app_runtime USING (true);
//    GRANT SELECT ON compliance_approvals TO app_runtime;
//    REVOKE ALL ON compliance_approvals FROM anon, authenticated;
// 5. `ALTER TYPE party_role ADD VALUE …` statements cannot be used in the same
//    transaction that adds them — drizzle-kit emits them as separate
//    statements; keep them first in the file.
// ---------------------------------------------------------------------------
