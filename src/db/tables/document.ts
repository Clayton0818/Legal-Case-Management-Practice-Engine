// Tables owned by the Document engine (c39–c41, c49, c84–c90, c4).
//
// c84 — the per-matter document store. Builds ON the shared `documents` table
// (schema.ts): one `documents` row is one immutable VERSION of a file
// (version, versionGroupId, status, privilegeTag, clientVisible, mimeType,
// sizeBytes, sha256 all live there). This file only adds what the shared
// table does not have:
//
//   document_folder_templates  firm-set folder layout per practice area (versioned)
//   document_folders           the folder tree of one matter
//   document_groups            one row per logical file (version group): folder, current version, legal hold
//   document_version_files     storage + checksum + malware-scan facts for each version's bytes
//   document_text              extracted / OCR text and the full-text search vector
//   document_access_log        append-only log of every view, download, search and denial
//   document_access_blocks     local mirror of ethical screens (c60) until a shared screens table exists
//   document_retention_rules   firm-entered retention periods (gated config; applied only via rules.retention_periods)
//   document_checklist_templates  firm-set required-documents checklist per practice area (c49)
//   document_checklist_items      one matter's required-documents checklist (c49)
//   document_templates            firm template library: letters, pleadings, forms, agreements (c85)
//   document_template_versions    versioned template bodies; only 'approved' ones generate (c85)
//   generated_document_sources    which template version + field values produced a document version (c85)
//   signature_envelopes           c4 — one e-signature request: signers, signing order, expiry, the document version it is locked to
//   signature_signers             c4 — one signer on one envelope, in order
//   court_filings                  c86 — one e-filing submission of an approved document version, and its status
//   filing_service_records         c86 — service of a filing on one other party (opposing party, opposing counsel, …)
//   document_share_links           c89 — outbound sharing: an expiring, access-logged, revocable link to one
//                                   pinned document version, for a client, opposing counsel, an expert or
//                                   anyone else outside the firm. The INBOUND side (clients uploading through
//                                   the portal) is c49/c11 and lives in document_checklist_items + the shared
//                                   documents table, not here.
//
// Conventions (./foundation.ts): NOT NULL tenantId -> firms.id on every
// table, text + CHECK for statuses, timestamptz, indexes leading with
// tenant_id (except the GIN search index — see MIGRATION NOTES).

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
  customType,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { firms, users, matters, parties, documents } from "../schema";
import { tasks } from "./foundation";

/** Postgres `tsvector`. Read as text if ever selected; normally only used in WHERE / ORDER BY. */
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

// ---------------------------------------------------------------------------
// Folder templates (firm-set, per practice area)
// ---------------------------------------------------------------------------

/**
 * Shape of `document_folder_templates.folders`: a small tree. `key` is a
 * stable machine name other engines use to find a folder ("email" for c87,
 * "client_uploads" for c49, "agreements" for c4/c39) whatever the firm calls
 * it. Validated by src/engines/document/folders/template.ts.
 */
export interface FolderTemplateNode {
  key: string;
  name: string;
  /** Default privilege tag for new uploads into this folder (c88). Defaults to 'none'. */
  defaultPrivilegeTag?: string;
  children?: FolderTemplateNode[];
}

export const documentFolderTemplates = pgTable("document_folder_templates", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  name: text("name").notNull(),
  /** PracticeAreaId ('family', …) or null for the firm-wide fallback template. */
  practiceArea: text("practice_area"),
  /** Increments per (tenant, practice area) each time a new template is saved. */
  version: integer("version").notNull().default(1),
  /** 'draft' | 'active' | 'retired'. At most one 'active' per (tenant, practice area). */
  status: text("status").notNull().default("draft"),
  folders: jsonb("folders").$type<FolderTemplateNode[]>().notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  activatedByUserId: uuid("activated_by_user_id").references(() => users.id),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
}, (t) => [
  index("document_folder_templates_tenant_area_idx").on(t.tenantId, t.practiceArea, t.status),
  // One active template per practice area; COALESCE so the null (firm-wide) area is unique too.
  uniqueIndex("document_folder_templates_one_active_key")
    .on(t.tenantId, sql`coalesce(${t.practiceArea}, '')`)
    .where(sql`${t.status} = 'active'`),
  check("document_folder_templates_status_check", sql`${t.status} in ('draft','active','retired')`),
  check("document_folder_templates_version_check", sql`${t.version} >= 1`),
]);

// ---------------------------------------------------------------------------
// Folders of one matter
// ---------------------------------------------------------------------------

export const documentFolders = pgTable("document_folders", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  /** Null = top level of the matter. */
  parentId: uuid("parent_id").references((): AnyPgColumn => documentFolders.id),
  name: text("name").notNull(),
  /** Lower-cased, whitespace-collapsed name, for sibling uniqueness. */
  normalizedName: text("normalized_name").notNull(),
  /** Template key when created from a template ('email', 'client_uploads' …); null for ad-hoc folders. */
  templateKey: text("template_key"),
  templateId: uuid("template_id").references(() => documentFolderTemplates.id),
  defaultPrivilegeTag: text("default_privilege_tag").notNull().default("none"),
  position: integer("position").notNull().default(0),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** Folders are archived, never deleted (they may hold version history). */
  archivedAt: timestamp("archived_at", { withTimezone: true }),
}, (t) => [
  index("document_folders_tenant_matter_idx").on(t.tenantId, t.matterId, t.parentId),
  // Sibling names unique among live folders; COALESCE makes top-level siblings unique too.
  uniqueIndex("document_folders_sibling_name_key")
    .on(t.tenantId, t.matterId, sql`coalesce(${t.parentId}, '00000000-0000-0000-0000-000000000000'::uuid)`, t.normalizedName)
    .where(sql`${t.archivedAt} is null`),
  // A template key appears once per matter (engines look folders up by key).
  uniqueIndex("document_folders_template_key_key")
    .on(t.tenantId, t.matterId, t.templateKey)
    .where(sql`${t.templateKey} is not null and ${t.archivedAt} is null`),
  check(
    "document_folders_privilege_tag_check",
    sql`${t.defaultPrivilegeTag} in ('none','privileged','work_product','confidential','sealed')`
  ),
]);

// ---------------------------------------------------------------------------
// Version groups (one logical file)
// ---------------------------------------------------------------------------

/**
 * One row per logical file. `groupDocumentId` is the `documents.id` of
 * version 1 (the shared table's version-group convention); every later
 * version is a NEW `documents` row with versionGroupId = groupDocumentId.
 * Bytes are never overwritten.
 *
 * `delivery*` columns (c40): whether THIS logical file has gone out to the
 * client outside the platform's own e-signature/delivery flow (c4). A
 * document delivered through that flow is marked 'sent' / 'platform'
 * automatically by the code that drives it; everything else needs a human
 * answer, which is what c40 asks for and records here.
 */
export const documentGroups = pgTable("document_groups", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  groupDocumentId: uuid("group_document_id").notNull().references(() => documents.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  folderId: uuid("folder_id").references(() => documentFolders.id),
  title: text("title").notNull(),
  currentDocumentId: uuid("current_document_id").notNull().references(() => documents.id),
  latestVersion: integer("latest_version").notNull().default(1),
  /** Legal hold (c2 §6 / c90): blocks any destruction review from approving. */
  legalHold: boolean("legal_hold").notNull().default(false),
  legalHoldReason: text("legal_hold_reason"),
  /** c90: an original paper document is held by the firm. */
  originalHeld: boolean("original_held").notNull().default(false),
  /** c40. 'sent' | 'not_yet' | 'not_needed'. Starts 'not_yet' for every new file. */
  deliveryStatus: text("delivery_status").notNull().default("not_yet"),
  /** c40. How it went out once 'sent': 'platform' | 'email' | 'mail' | 'hand_delivery' | 'other'. Null until then. */
  deliveryMethod: text("delivery_method"),
  deliveryConfirmedAt: timestamp("delivery_confirmed_at", { withTimezone: true }),
  deliveryConfirmedByUserId: uuid("delivery_confirmed_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("document_groups_group_document_key").on(t.tenantId, t.groupDocumentId),
  index("document_groups_tenant_matter_idx").on(t.tenantId, t.matterId, t.folderId),
  index("document_groups_tenant_delivery_idx").on(t.tenantId, t.matterId, t.deliveryStatus),
  check("document_groups_latest_version_check", sql`${t.latestVersion} >= 1`),
  check("document_groups_hold_reason_check", sql`not ${t.legalHold} or ${t.legalHoldReason} is not null`),
  check("document_groups_delivery_status_check", sql`${t.deliveryStatus} in ('sent','not_yet','not_needed')`),
  check(
    "document_groups_delivery_method_check",
    sql`${t.deliveryMethod} is null or ${t.deliveryMethod} in ('platform','email','mail','hand_delivery','other')`
  ),
  check("document_groups_delivery_confirmed_check", sql`${t.deliveryStatus} = 'not_yet' or ${t.deliveryConfirmedAt} is not null`),
]);

// ---------------------------------------------------------------------------
// Bytes of each version: storage, checksum, malware scan
// ---------------------------------------------------------------------------

export const documentVersionFiles = pgTable("document_version_files", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  /** The `documents` row (one version). One file per version. */
  documentId: uuid("document_id").notNull().references(() => documents.id),
  /** StorageAdapter.name that holds the bytes: 'memory' | 'local' | a vendor adapter. */
  storageAdapter: text("storage_adapter").notNull(),
  storageKey: text("storage_key").notNull(),
  /** Hex SHA-256 of the plaintext bytes, computed server-side at upload. */
  sha256: text("sha256").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  /** MIME type detected from the bytes (may differ from the declared one). */
  detectedMimeType: text("detected_mime_type"),
  declaredMimeType: text("declared_mime_type"),
  originalFilename: text("original_filename"),
  /** Encryption scheme applied by the adapter, e.g. 'aes-256-gcm' or 'vendor-sse'. Never the key. */
  encryption: text("encryption").notNull(),
  /** 'pending' | 'clean' | 'infected' | 'error' | 'not_scanned' (no approved scanner yet). */
  scanStatus: text("scan_status").notNull().default("pending"),
  scanDetail: text("scan_detail"),
  scannedAt: timestamp("scanned_at", { withTimezone: true }),
  quarantinedAt: timestamp("quarantined_at", { withTimezone: true }),
  lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("document_version_files_document_key").on(t.tenantId, t.documentId),
  index("document_version_files_tenant_sha_idx").on(t.tenantId, t.sha256),
  index("document_version_files_tenant_scan_idx").on(t.tenantId, t.scanStatus),
  check(
    "document_version_files_scan_status_check",
    sql`${t.scanStatus} in ('pending','clean','infected','error','not_scanned')`
  ),
  check("document_version_files_sha_check", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
  check("document_version_files_size_check", sql`${t.sizeBytes} >= 0`),
  check("document_version_files_quarantine_check", sql`${t.scanStatus} <> 'infected' or ${t.quarantinedAt} is not null`),
]);

// ---------------------------------------------------------------------------
// Extracted text + full-text search
// ---------------------------------------------------------------------------

export const documentText = pgTable("document_text", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  documentId: uuid("document_id").notNull().references(() => documents.id),
  /** Denormalised for search filters (same as documents.matter_id / document_groups.id). */
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  groupId: uuid("group_id").notNull().references(() => documentGroups.id),
  /** Copied from the group title so a title match ranks highest. */
  title: text("title").notNull().default(""),
  /**
   * 'pending' (not processed yet) | 'extracted' | 'ocr_pending' (scanned; waiting for an
   * approved OCR vendor) | 'unsupported' | 'failed' | 'blocked' (quarantined file).
   */
  status: text("status").notNull().default("pending"),
  /** 'native' (text layer / text file) | 'ocr' | null while pending. */
  method: text("method"),
  content: text("content").notNull().default(""),
  /** True when content was cut at the firm's maxIndexedChars setting. */
  truncated: boolean("truncated").notNull().default(false),
  pageCount: integer("page_count"),
  detail: text("detail"),
  attempts: integer("attempts").notNull().default(0),
  extractedAt: timestamp("extracted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /**
   * Generated search vector (title weighted A, body B). 'english' is a
   * constant regconfig, so to_tsvector/setweight are IMMUTABLE and allowed in
   * a STORED generated column. See MIGRATION NOTES 4.
   */
  searchVector: tsvector("search_vector").generatedAlwaysAs(
    sql`setweight(to_tsvector('english'::regconfig, coalesce(title, '')), 'A') || setweight(to_tsvector('english'::regconfig, coalesce(content, '')), 'B')`
  ),
}, (t) => [
  uniqueIndex("document_text_document_key").on(t.tenantId, t.documentId),
  index("document_text_tenant_matter_idx").on(t.tenantId, t.matterId),
  index("document_text_tenant_status_idx").on(t.tenantId, t.status),
  index("document_text_search_idx").using("gin", t.searchVector),
  check(
    "document_text_status_check",
    sql`${t.status} in ('pending','extracted','ocr_pending','unsupported','failed','blocked')`
  ),
  check("document_text_method_check", sql`${t.method} is null or ${t.method} in ('native','ocr')`),
]);

// ---------------------------------------------------------------------------
// Access log (append-only)
// ---------------------------------------------------------------------------

export const documentAccessLog = pgTable("document_access_log", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  /** The version viewed/downloaded; null for a search or a matter-level listing. */
  documentId: uuid("document_id").references(() => documents.id),
  groupId: uuid("group_id").references(() => documentGroups.id),
  matterId: uuid("matter_id").references(() => matters.id),
  /** 'user' | 'client' | 'system' | 'external_recipient' (c89: a share-link token, never a platform account). */
  actorType: text("actor_type").notNull(),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  actorPartyId: uuid("actor_party_id").references(() => parties.id),
  /** 'view' | 'download' | 'list' | 'search' | 'version_history'. */
  action: text("action").notNull(),
  /** 'allowed' | 'denied'. Denials are logged too. */
  outcome: text("outcome").notNull(),
  /** Machine reason for a denial ('screened', 'no_permission', 'restricted_tag', 'quarantined' …). */
  reason: text("reason"),
  /** Search text (internal log only), result count, byte count, request id … */
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("document_access_log_tenant_document_idx").on(t.tenantId, t.documentId, t.occurredAt),
  index("document_access_log_tenant_matter_idx").on(t.tenantId, t.matterId, t.occurredAt),
  index("document_access_log_tenant_user_idx").on(t.tenantId, t.actorUserId, t.occurredAt),
  check("document_access_log_actor_type_check", sql`${t.actorType} in ('user','client','system','external_recipient')`),
  check(
    "document_access_log_action_check",
    sql`${t.action} in ('view','download','list','search','version_history')`
  ),
  check("document_access_log_outcome_check", sql`${t.outcome} in ('allowed','denied')`),
  check("document_access_log_denied_reason_check", sql`${t.outcome} <> 'denied' or ${t.reason} is not null`),
]);

// ---------------------------------------------------------------------------
// Screens mirror (c60) — LOCAL ADAPTER
// ---------------------------------------------------------------------------

/**
 * "This user must not see this matter's documents." Mirrors ethical screens
 * (c60), which the conflict-check engine owns in its own tables; an engine
 * cannot import those, so until a SHARED screens table exists (foundation
 * request) screens are recorded here by staff or a sync job. Access checks
 * also accept an injected ScreenSource (src/engines/document/access/policy.ts),
 * so the shared table can be plugged in without changing callers.
 */
export const documentAccessBlocks = pgTable("document_access_blocks", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  /** 'ethical_screen' (c60) | 'restricted' | 'other'. */
  reason: text("reason").notNull(),
  note: text("note"),
  /** 'manual' | 'sync' (copied from the conflict-check engine's screens by a job). */
  source: text("source").notNull().default("manual"),
  /** e.g. the conflict screen id this row mirrors. */
  sourceRef: text("source_ref"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  endedByUserId: uuid("ended_by_user_id").references(() => users.id),
  endedReason: text("ended_reason"),
}, (t) => [
  index("document_access_blocks_tenant_user_idx").on(t.tenantId, t.userId, t.endedAt),
  index("document_access_blocks_tenant_matter_idx").on(t.tenantId, t.matterId),
  uniqueIndex("document_access_blocks_active_key")
    .on(t.tenantId, t.userId, t.matterId)
    .where(sql`${t.endedAt} is null`),
  check("document_access_blocks_reason_check", sql`${t.reason} in ('ethical_screen','restricted','other')`),
  check("document_access_blocks_source_check", sql`${t.source} in ('manual','sync')`),
  check("document_access_blocks_ended_check", sql`${t.endedAt} is null or ${t.endedReason} is not null`),
]);

// ---------------------------------------------------------------------------
// Retention periods (gated config)
// ---------------------------------------------------------------------------

/**
 * Firm-entered retention periods. The product ships NO default values
 * (c90 open question 18). Storing a rule is configuration; APPLYING one
 * (proposing a destruction-eligibility date) requires the shared
 * `rules.retention_periods` gate, and destruction itself always needs a
 * lawyer's approval (c90). Rows are superseded, never edited.
 */
export const documentRetentionRules = pgTable("document_retention_rules", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  /** PracticeAreaId or null for every practice area. */
  practiceArea: text("practice_area"),
  /** documents.document_type or null for every type. */
  documentType: text("document_type"),
  /** Years after the matter closes. */
  retainYearsAfterClose: integer("retain_years_after_close").notNull(),
  /** Where the firm got this number (its policy, an ethics opinion, its insurer). Required. */
  basis: text("basis").notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
  supersededByUserId: uuid("superseded_by_user_id").references(() => users.id),
}, (t) => [
  index("document_retention_rules_tenant_idx").on(t.tenantId, t.practiceArea, t.documentType),
  uniqueIndex("document_retention_rules_live_key")
    .on(t.tenantId, sql`coalesce(${t.practiceArea}, '')`, sql`coalesce(${t.documentType}, '')`)
    .where(sql`${t.supersededAt} is null`),
  check("document_retention_rules_years_check", sql`${t.retainYearsAfterClose} between 0 and 100`),
]);

// ---------------------------------------------------------------------------
// Required-documents checklist (c49)
// ---------------------------------------------------------------------------

/**
 * Shape of `document_checklist_templates.items`. `key` is a stable machine
 * name (e.g. 'marriage_certificate') so a matter's checklist can be extended
 * when a firm edits its template without disturbing items already in
 * progress. Validated by src/engines/document/checklist/template.ts.
 */
export interface ChecklistTemplateItem {
  key: string;
  label: string;
  /** Plain-language description shown to a client who is responsible for it. */
  description: string;
  responsibleParty: "client" | "firm" | "third_party";
  /** Suggested documents.document_type for whatever gets uploaded against this item. */
  documentType?: string;
}

export const documentChecklistTemplates = pgTable("document_checklist_templates", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  name: text("name").notNull(),
  /** PracticeAreaId ('family', …) or null for the firm-wide fallback template. */
  practiceArea: text("practice_area"),
  /** Increments per (tenant, practice area) each time a new template is saved. */
  version: integer("version").notNull().default(1),
  /** 'draft' | 'active' | 'retired'. At most one 'active' per (tenant, practice area). */
  status: text("status").notNull().default("draft"),
  items: jsonb("items").$type<ChecklistTemplateItem[]>().notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  activatedByUserId: uuid("activated_by_user_id").references(() => users.id),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
}, (t) => [
  index("document_checklist_templates_tenant_area_idx").on(t.tenantId, t.practiceArea, t.status),
  uniqueIndex("document_checklist_templates_one_active_key")
    .on(t.tenantId, sql`coalesce(${t.practiceArea}, '')`)
    .where(sql`${t.status} = 'active'`),
  check("document_checklist_templates_status_check", sql`${t.status} in ('draft','active','retired')`),
  check("document_checklist_templates_version_check", sql`${t.version} >= 1`),
]);

/**
 * One matter's required-documents checklist (c49). A row exists whether or
 * not anything has been uploaded yet — 'missing' is the normal starting
 * state, so this cannot simply be a view over `document_groups`.
 *
 * Visibility boundary (same rule as c45/c46): the client portal (c11) may
 * only ever be shown rows with responsibleParty = 'client'; internal notes
 * and third-party items are firm-side only. Enforced in
 * src/engines/document/checklist/service.ts, not just in the UI.
 */
export const documentChecklistItems = pgTable("document_checklist_items", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  templateId: uuid("template_id").references(() => documentChecklistTemplates.id),
  /** Template item key when seeded from a template; null for an item a lawyer added by hand. */
  templateItemKey: text("template_item_key"),
  label: text("label").notNull(),
  description: text("description").notNull().default(""),
  /** 'client' | 'firm' | 'third_party' — who provides it (c49). */
  responsibleParty: text("responsible_party").notNull(),
  /** 'missing' | 'requested' | 'received' | 'accepted' | 'not_applicable'. */
  status: text("status").notNull().default("missing"),
  /** Required (and logged) when status = 'not_applicable' (c49: "with a logged reason"). */
  notApplicableReason: text("not_applicable_reason"),
  /** Set once a file has been uploaded against this item ('received'); the current version is at groups.currentDocumentId. */
  groupId: uuid("group_id").references(() => documentGroups.id),
  /** The task (core/tasks.ts) tracking this item while it is outstanding, for the shared overdue/flag mechanism (c44/c45/c46). */
  taskId: uuid("task_id").references(() => tasks.id),
  /**
   * 'not_checked' | 'passed' | 'flagged' — the AI's basic upload sanity check
   * (readable, right type, pages present, looks like the requested kind).
   * Never a judgment of legal sufficiency: only a lawyer sets status = 'accepted'.
   */
  aiCheckStatus: text("ai_check_status").notNull().default("not_checked"),
  aiCheckDetail: jsonb("ai_check_detail").$type<Record<string, unknown>>().notNull().default({}),
  requestedAt: timestamp("requested_at", { withTimezone: true }),
  receivedAt: timestamp("received_at", { withTimezone: true }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  acceptedByUserId: uuid("accepted_by_user_id").references(() => users.id),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  /** Items are archived, never deleted — a lawyer removing one is still a logged status change (c49). */
  archivedAt: timestamp("archived_at", { withTimezone: true }),
}, (t) => [
  index("document_checklist_items_tenant_matter_idx").on(t.tenantId, t.matterId, t.status),
  index("document_checklist_items_tenant_responsible_idx").on(t.tenantId, t.responsibleParty, t.status),
  uniqueIndex("document_checklist_items_template_key_key")
    .on(t.tenantId, t.matterId, t.templateItemKey)
    .where(sql`${t.templateItemKey} is not null and ${t.archivedAt} is null`),
  check(
    "document_checklist_items_responsible_party_check",
    sql`${t.responsibleParty} in ('client','firm','third_party')`
  ),
  check(
    "document_checklist_items_status_check",
    sql`${t.status} in ('missing','requested','received','accepted','not_applicable')`
  ),
  check(
    "document_checklist_items_not_applicable_reason_check",
    sql`${t.status} <> 'not_applicable' or ${t.notApplicableReason} is not null`
  ),
  check(
    "document_checklist_items_ai_check_status_check",
    sql`${t.aiCheckStatus} in ('not_checked','passed','flagged')`
  ),
]);

// ---------------------------------------------------------------------------
// Templates that fill themselves from matter data (c85)
// ---------------------------------------------------------------------------

/**
 * The firm's template library (c85). Metadata only; the body lives on each
 * version. Retiring stops new use; documents already generated keep their
 * link to the version they came from.
 */
export const documentTemplates = pgTable("document_templates", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  name: text("name").notNull(),
  /** 'letter' | 'pleading' | 'form' | 'agreement'. */
  category: text("category").notNull(),
  /** PracticeAreaId or null for every practice area. */
  practiceArea: text("practice_area"),
  /** Matter type (e.g. 'uncontested_divorce') or null for every type. */
  matterType: text("matter_type"),
  /** 'en' | 'es' | … (c36). */
  language: text("language").notNull().default("en"),
  /** 'active' | 'retired'. */
  status: text("status").notNull().default("active"),
  /** True for a product-shipped starter template (c85 rule 9: arrives as draft, firm lawyer approves). */
  isStarter: boolean("is_starter").notNull().default(false),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  retiredByUserId: uuid("retired_by_user_id").references(() => users.id),
}, (t) => [
  index("document_templates_tenant_area_idx").on(t.tenantId, t.practiceArea, t.status),
  check("document_templates_category_check", sql`${t.category} in ('letter','pleading','form','agreement')`),
  check("document_templates_status_check", sql`${t.status} in ('active','retired')`),
]);

/**
 * One version of a template body (c85). Bodies use the restricted syntax in
 * src/engines/document/templates/syntax.ts and are validated against the
 * field catalogue before insert. A version's body is never edited: editing an
 * approved template creates a new draft version.
 */
export const documentTemplateVersions = pgTable("document_template_versions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  templateId: uuid("template_id").notNull().references(() => documentTemplates.id),
  versionNo: integer("version_no").notNull(),
  body: text("body").notNull(),
  sha256: text("sha256").notNull(),
  /** Catalogue keys the body uses (from parseTemplate), for the editor and impact checks. */
  fieldKeys: jsonb("field_keys").$type<string[]>().notNull().default([]),
  /** 'draft' | 'approved' | 'superseded'. At most one 'approved' per template. */
  status: text("status").notNull().default("draft"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  approvedByUserId: uuid("approved_by_user_id").references(() => users.id),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("document_template_versions_no_key").on(t.tenantId, t.templateId, t.versionNo),
  uniqueIndex("document_template_versions_one_approved_key")
    .on(t.tenantId, t.templateId)
    .where(sql`${t.status} = 'approved'`),
  check("document_template_versions_status_check", sql`${t.status} in ('draft','approved','superseded')`),
  check("document_template_versions_version_check", sql`${t.versionNo} >= 1`),
  check(
    "document_template_versions_approved_by_check",
    sql`${t.status} = 'draft' or (${t.approvedByUserId} is not null and ${t.approvedAt} is not null)`
  ),
]);

/**
 * Provenance of a generated draft (c85 rule 7): the template version and a
 * snapshot of the field values used, plus the placeholders left open and any
 * lawyer clearances. Contains client data, so it follows the matter's
 * retention (c2, c90).
 */
export const generatedDocumentSources = pgTable("generated_document_sources", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  documentId: uuid("document_id").notNull().references(() => documents.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  templateVersionId: uuid("template_version_id").notNull().references(() => documentTemplateVersions.id),
  fieldValues: jsonb("field_values").$type<Record<string, unknown>>().notNull().default({}),
  /** Placeholder[] from renderTemplate(). */
  placeholders: jsonb("placeholders").$type<{ key: string; label: string; reason: string }[]>().notNull().default([]),
  /** PlaceholderClearance[] — each with the clearing lawyer and reason (also audited). */
  clearances: jsonb("clearances").$type<{ key: string; reason: string; clearedByUserId: string }[]>().notNull().default([]),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("generated_document_sources_document_key").on(t.tenantId, t.documentId),
  index("generated_document_sources_tenant_template_idx").on(t.tenantId, t.templateVersionId),
]);

// ---------------------------------------------------------------------------
// E-signature envelopes (c4 — the build; c39/c41/c59/c52 reuse it)
// ---------------------------------------------------------------------------

/**
 * One e-signature request against ONE document version. `documentSha256` is
 * copied from `documents.sha256` at creation and never changes: if the
 * document gets a new version the envelope cannot complete against it (spec
 * §5 rule 1, acceptance criterion 3 — the caller must void and send a new
 * envelope). `documentId` points at that exact `documents` row (one version),
 * not at the logical `document_groups` row.
 *
 * No vendor is wired yet (src/engines/document/gates.ts:
 * VENDOR_GATES.esignature) — `vendor`/`vendorEnvelopeId` stay null until one
 * is. Sending always goes through the gate in signature/service.ts, which
 * fails closed with a pending placeholder exactly like c39's own
 * SignatureRequestAdapter seam.
 */
export const signatureEnvelopes = pgTable("signature_envelopes", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  documentId: uuid("document_id").notNull().references(() => documents.id),
  documentSha256: text("document_sha256").notNull(),
  /** 'engagement' | 'waiver' | 'pre_filing' | 'fee_change' | 'other'. */
  purpose: text("purpose").notNull(),
  /** 'draft' | 'sent' | 'completed' | 'declined' | 'expired' | 'voided'. */
  status: text("status").notNull().default("draft"),
  /** Adapter name once a real vendor is wired (c4 open question 1); null = no vendor configured. */
  vendor: text("vendor"),
  vendorEnvelopeId: text("vendor_envelope_id"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  /** Firm-set expiry (default 10 business days after sentAt — spec §5 rule 6). */
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  declinedAt: timestamp("declined_at", { withTimezone: true }),
  expiredAt: timestamp("expired_at", { withTimezone: true }),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidReason: text("void_reason"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("signature_envelopes_tenant_matter_idx").on(t.tenantId, t.matterId, t.status),
  index("signature_envelopes_tenant_document_idx").on(t.tenantId, t.documentId),
  index("signature_envelopes_expiry_idx").on(t.status, t.expiresAt),
  check(
    "signature_envelopes_purpose_check",
    sql`${t.purpose} in ('engagement','waiver','pre_filing','fee_change','other')`
  ),
  check(
    "signature_envelopes_status_check",
    sql`${t.status} in ('draft','sent','completed','declined','expired','voided')`
  ),
  check("signature_envelopes_void_reason_check", sql`${t.status} <> 'voided' or ${t.voidReason} is not null`),
]);

/**
 * One signer on one envelope, in signing order (`orderNo`, 0-based). Exactly
 * one of `partyId` / `userId` is set: a client or other outside party signs
 * as a `parties` row, a firm user (the countersigning attorney) as a `users`
 * row (spec §6).
 */
export const signatureSigners = pgTable("signature_signers", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  envelopeId: uuid("envelope_id").notNull().references(() => signatureEnvelopes.id),
  orderNo: integer("order_no").notNull(),
  /** 'client' | 'firm_user' | 'other'. */
  signerType: text("signer_type").notNull(),
  partyId: uuid("party_id").references(() => parties.id),
  userId: uuid("user_id").references(() => users.id),
  /** 'portal_login' | 'one_time_code' | 'email_link_only' (spec §5 rule 8; firm setting). */
  identityMethod: text("identity_method").notNull().default("portal_login"),
  /** 'pending' | 'sent' | 'viewed' | 'signed' | 'declined'. Starts 'pending' until it is this signer's turn. */
  status: text("status").notNull().default("pending"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  viewedAt: timestamp("viewed_at", { withTimezone: true }),
  signedAt: timestamp("signed_at", { withTimezone: true }),
  declinedAt: timestamp("declined_at", { withTimezone: true }),
  declineReason: text("decline_reason"),
}, (t) => [
  uniqueIndex("signature_signers_envelope_order_key").on(t.envelopeId, t.orderNo),
  index("signature_signers_tenant_envelope_idx").on(t.tenantId, t.envelopeId),
  check("signature_signers_order_check", sql`${t.orderNo} >= 0`),
  check("signature_signers_signer_type_check", sql`${t.signerType} in ('client','firm_user','other')`),
  check(
    "signature_signers_identity_method_check",
    sql`${t.identityMethod} in ('portal_login','one_time_code','email_link_only')`
  ),
  check("signature_signers_status_check", sql`${t.status} in ('pending','sent','viewed','signed','declined')`),
  check("signature_signers_party_or_user_check", sql`(${t.partyId} is not null) <> (${t.userId} is not null)`),
  check("signature_signers_decline_reason_check", sql`${t.status} <> 'declined' or ${t.declineReason} is not null`),
]);

// ---------------------------------------------------------------------------
// Court filings (c86) — submit, track status and service
// ---------------------------------------------------------------------------

/**
 * One e-filing submission of an approved document version (c86). Only a
 * lawyer may create one (service.ts), and only against a document the
 * lawyer has already approved — pre-filing client sign-off where c41
 * requires it happens before the document reaches that status, so this
 * table never re-checks it. Never corrected in place: a rejected filing is
 * not resubmitted — the lawyer files a new version as a new row, the same
 * way a signature envelope is voided rather than edited (c4).
 */
export const courtFilings = pgTable("court_filings", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  /** The approved document version being filed. Never changes once set. */
  documentId: uuid("document_id").notNull().references(() => documents.id),
  /** 'petition' | 'motion' | 'response' | 'notice' | 'other'. */
  filingType: text("filing_type").notNull(),
  /** Staff-facing name of the court (e.g. "Travis County District Court"). A fact staff enter, not a venue decision (that's c73/family residencyVenue). */
  court: text("court").notNull(),
  /** 'draft' | 'submitted' | 'accepted' | 'rejected'. */
  status: text("status").notNull().default("draft"),
  /** Adapter name once a real e-filing vendor is wired (vendor.efiling); null = no vendor configured. */
  vendor: text("vendor"),
  vendorFilingId: text("vendor_filing_id"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  rejectionReason: text("rejection_reason"),
  /** The court-stamped copy, once staff upload it back to the matter (c84) and link it here. */
  stampedDocumentId: uuid("stamped_document_id").references(() => documents.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("court_filings_tenant_matter_idx").on(t.tenantId, t.matterId, t.status),
  index("court_filings_tenant_document_idx").on(t.tenantId, t.documentId),
  check("court_filings_filing_type_check", sql`${t.filingType} in ('petition','motion','response','notice','other')`),
  check("court_filings_status_check", sql`${t.status} in ('draft','submitted','accepted','rejected')`),
  check("court_filings_rejection_reason_check", sql`${t.status} <> 'rejected' or ${t.rejectionReason} is not null`),
]);

/**
 * Service of a filing on one other party (c86). A filing may need service
 * on several parties (opposing party, opposing counsel, …), so each gets its
 * own row — partial service stays visible instead of one flag for the whole
 * filing.
 */
export const filingServiceRecords = pgTable("filing_service_records", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  filingId: uuid("filing_id").notNull().references(() => courtFilings.id),
  /** Who was served. A matter party when there is one; free text otherwise (e.g. a third-party agency). */
  partyId: uuid("party_id").references(() => parties.id),
  servedOnName: text("served_on_name"),
  /** 'efiling' | 'mail' | 'certified_mail' | 'personal' | 'other'. */
  method: text("method").notNull(),
  /** 'pending' | 'completed' | 'failed'. */
  status: text("status").notNull().default("pending"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  failureReason: text("failure_reason"),
  /** Proof of service, once uploaded back to the matter (c84) and linked here. */
  proofDocumentId: uuid("proof_document_id").references(() => documents.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("filing_service_records_tenant_filing_idx").on(t.tenantId, t.filingId),
  check("filing_service_records_method_check", sql`${t.method} in ('efiling','mail','certified_mail','personal','other')`),
  check("filing_service_records_status_check", sql`${t.status} in ('pending','completed','failed')`),
  check("filing_service_records_failure_reason_check", sql`${t.status} <> 'failed' or ${t.failureReason} is not null`),
  check("filing_service_records_served_on_check", sql`${t.partyId} is not null or ${t.servedOnName} is not null`),
]);

// ---------------------------------------------------------------------------
// Outbound document sharing (c89) — expiring, access-logged, revocable links
// ---------------------------------------------------------------------------

/**
 * One outbound share: a single, pinned document VERSION (never "whatever is
 * current later") made reachable by anyone who holds the link, for a limited
 * time, with every view/download going through document_access_log the same
 * way a signed-in user's or client's does (actorType 'external_recipient').
 *
 * `tokenHash` is the ONLY thing ever stored for the access token — a
 * SHA-256 of a 32-byte random secret minted by
 * src/engines/document/exchange/crypto.ts. The raw token (which also carries
 * the tenant id, so the public endpoint can find the right tenant without a
 * cross-tenant lookup — see that file's header comment) is returned once, to
 * the creating request, and never written anywhere.
 *
 * Privilege is enforced at creation, not just at read time: sharing a
 * privileged/work-product/sealed document, or sharing ANY document with a
 * 'client' recipient that is not already clientVisible, needs an explicit,
 * separate confirmation + reason (service.ts createShareLink) — recorded
 * here so the override decision is itself auditable, not just logged once
 * and forgotten.
 */
export const documentShareLinks = pgTable("document_share_links", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  groupId: uuid("group_id").notNull().references(() => documentGroups.id),
  /** The exact version pinned at creation — what is actually served, whatever happens to the group later. */
  documentId: uuid("document_id").notNull().references(() => documents.id),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  /** 'client' | 'opposing_counsel' | 'expert' | 'other'. */
  recipientType: text("recipient_type").notNull(),
  /** Name/org only — whatever the firm needs to tell links apart. Never an address or other contact detail. */
  recipientLabel: text("recipient_label"),
  /** SHA-256 hex of the random secret. The plaintext token is never stored. */
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  /** Null = unlimited. */
  maxDownloads: integer("max_downloads"),
  downloadCount: integer("download_count").notNull().default(0),
  lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedByUserId: uuid("revoked_by_user_id").references(() => users.id),
  revokedReason: text("revoked_reason"),
  /** True only when the document's privilege tag (or client-visibility) required an explicit override to share it anyway. */
  privilegedOverrideConfirmed: boolean("privileged_override_confirmed").notNull().default(false),
  privilegedOverrideConfirmedByUserId: uuid("privileged_override_confirmed_by_user_id").references(() => users.id),
  privilegedOverrideReason: text("privileged_override_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("document_share_links_token_key").on(t.tenantId, t.tokenHash),
  index("document_share_links_tenant_matter_idx").on(t.tenantId, t.matterId),
  index("document_share_links_tenant_group_idx").on(t.tenantId, t.groupId),
  index("document_share_links_tenant_expiry_idx").on(t.tenantId, t.expiresAt),
  check(
    "document_share_links_recipient_type_check",
    sql`${t.recipientType} in ('client','opposing_counsel','expert','other')`
  ),
  check("document_share_links_max_downloads_check", sql`${t.maxDownloads} is null or ${t.maxDownloads} >= 1`),
  check("document_share_links_download_count_check", sql`${t.downloadCount} >= 0`),
  check("document_share_links_revoked_reason_check", sql`${t.revokedAt} is null or ${t.revokedReason} is not null`),
  check(
    "document_share_links_override_check",
    sql`not ${t.privilegedOverrideConfirmed} or (${t.privilegedOverrideConfirmedByUserId} is not null and ${t.privilegedOverrideReason} is not null)`
  ),
]);

// ---------------------------------------------------------------------------
// MIGRATION NOTES for the integration step (hand-add to the generated SQL):
//
// 1. RLS + the standard tenant_isolation policy (same text as migrations/0000)
//    on every table in this file:
//    document_folder_templates, document_folders, document_groups,
//    document_version_files, document_text, document_access_log,
//    document_access_blocks, document_retention_rules,
//    document_checklist_templates, document_checklist_items,
//    document_templates, document_template_versions, generated_document_sources,
//    signature_envelopes, signature_signers, court_filings, filing_service_records.
//
// 2. Staging grants app_runtime SELECT/INSERT/UPDATE/DELETE on new tables by
//    default. Restrict as follows:
//    - document_access_log is append-only (every view/download must survive):
//        REVOKE UPDATE, DELETE ON document_access_log FROM app_runtime;
//    - version history must never lose rows (c84: never overwritten):
//        REVOKE DELETE ON document_groups, document_version_files, document_text,
//          document_folders, document_folder_templates, document_retention_rules,
//          document_access_blocks, document_checklist_templates, document_checklist_items
//          FROM app_runtime;
//      (Destruction after the retention clock — c90 — runs under a separate,
//      elevated purge role after lawyer approval, not as app_runtime.)
//    - document_retention_rules is supersede-only; app_runtime may UPDATE only
//      the superseded_* columns:
//        REVOKE UPDATE ON document_retention_rules FROM app_runtime;
//        GRANT UPDATE (superseded_at, superseded_by_user_id) ON document_retention_rules TO app_runtime;
//    - document_version_files: the bytes' identity never changes:
//        REVOKE UPDATE ON document_version_files FROM app_runtime;
//        GRANT UPDATE (scan_status, scan_detail, scanned_at, quarantined_at, last_verified_at)
//          ON document_version_files TO app_runtime;
//
// 3. Shared `documents` table (schema.ts — FOUNDATION REQUEST, DONE in
//    migrations/0007 as trigger documents_version_content_frozen, which also
//    freezes tenant_id, plus REVOKE DELETE, TRUNCATE):
//    a BEFORE UPDATE trigger that rejects changes to storage_key, sha256,
//    size_bytes, mime_type, version, version_group_id, matter_id once set,
//    so a version's content can never be overwritten in place; and
//    REVOKE DELETE ON documents FROM app_runtime.
//
// 4. document_text.search_vector is a STORED generated column:
//      GENERATED ALWAYS AS (setweight(to_tsvector('english'::regconfig, coalesce(title,'')),'A')
//                         || setweight(to_tsvector('english'::regconfig, coalesce(content,'')),'B')) STORED
//    Check drizzle-kit emitted exactly that (with the ::regconfig casts — the
//    one-argument to_tsvector is only STABLE and Postgres would refuse it).
//    The GIN index document_text_search_idx cannot lead with tenant_id
//    without the btree_gin extension; tenant scoping comes from RLS plus the
//    explicit tenant_id filter in every query. If btree_gin is available,
//    prefer: CREATE INDEX … USING gin (tenant_id, search_vector).
//    tsvector values are capped at 1 MB; the engine truncates content to the
//    firm's maxIndexedChars setting (default 400 000 chars) before insert.
//
// 5. Partial unique indexes above use expressions (coalesce) and WHERE
//    clauses; confirm drizzle-kit emitted them verbatim.
//
// 6. document_groups gained four columns (c40): delivery_status (default
//    'not_yet'), delivery_method, delivery_confirmed_at,
//    delivery_confirmed_by_user_id. All nullable or defaulted, so this is a
//    purely additive ALTER TABLE — existing rows get delivery_status =
//    'not_yet' and need no backfill.
//
// 7. document_checklist_items.task_id references the foundation `tasks`
//    table (src/db/tables/foundation.ts) — confirm drizzle-kit resolved the
//    cross-file FK without a circular-import problem at generate time; if it
//    did not, add the FK by hand to the generated SQL instead.
//
// 8. document_checklist_items is NOT in the "never overwritten" list above:
//    unlike a document version, a checklist item's status is meant to be
//    updated in place (missing → requested → received → accepted) by
//    src/engines/document/checklist/service.ts. app_runtime keeps ordinary
//    UPDATE on this table; only DELETE is revoked (items are archived, not
//    deleted — see the table's own comment).
//
// 9. c85 templates. Same never-delete rule as the rest of this file:
//      REVOKE DELETE ON document_templates, document_template_versions,
//        generated_document_sources FROM app_runtime;
//    A version's body is immutable once written; app_runtime may only move
//    its status:
//      REVOKE UPDATE ON document_template_versions FROM app_runtime;
//      GRANT UPDATE (status, approved_by_user_id, approved_at, superseded_at)
//        ON document_template_versions TO app_runtime;
//    generated_document_sources: only clearances change after insert:
//      REVOKE UPDATE ON generated_document_sources FROM app_runtime;
//      GRANT UPDATE (clearances) ON generated_document_sources TO app_runtime;
//    The partial unique index document_template_versions_one_approved_key
//    must be emitted with its WHERE clause; approving a new version must
//    supersede the old one in the same transaction, before the insert/update
//    that sets the new one to 'approved'.
//
// 10. signature_envelopes / signature_signers (c4): RLS + tenant_isolation
//     like every other table in this file. app_runtime keeps ordinary
//     UPDATE (status moves draft → sent → completed/declined/expired/voided
//     in place; a signer's status moves pending → sent → viewed → signed, or
//     → declined); REVOKE DELETE on both (an envelope is voided, never
//     deleted, so the signing history survives — spec §5 rule 2). No FK from
//     signature_envelopes.documentId to a specific version needs an ON
//     DELETE rule since `documents` rows are never deleted (note 3 above).
//
// 11. court_filings / filing_service_records (c86): RLS + tenant_isolation
//     like every other table in this file. app_runtime keeps ordinary UPDATE
//     (a filing's status moves draft → submitted → accepted/rejected in
//     place; a service record's status moves pending → completed/failed);
//     REVOKE DELETE on both — a rejected filing is never corrected in place,
//     the lawyer files a new version as a new row instead (note 10's
//     reasoning for signature_envelopes applies the same way here). No FK ON
//     DELETE rule is needed from court_filings.documentId /
//     stampedDocumentId or filing_service_records.proofDocumentId to a
//     specific version, since `documents` rows are never deleted (note 3).
//
// 12. document_share_links (c89): RLS + tenant_isolation like every other
//     table in this file. A link is REVOKED, never deleted (the same
//     "history survives" reasoning as signature_envelopes / court_filings —
//     notes 10/11), so:
//       REVOKE DELETE ON document_share_links FROM app_runtime;
//     app_runtime keeps ordinary UPDATE (download_count, last_accessed_at,
//     revoked_at/revoked_by_user_id/revoked_reason all move in place after
//     the row is created). token_hash/document_id/group_id/matter_id are
//     set once at creation and never change in the app's own code, but
//     unlike document_version_files there is no integrity reason to also
//     revoke UPDATE on those columns at the database level here.
//
// 13. document_access_log.actor_type widens from this PR's base
//     ('user'|'client'|'system') to add 'external_recipient' (c89: a
//     share-link token holder, which is nobody's user or party row). This is
//     an ALTER on an EXISTING constraint, not a new-table note — hand-add:
//       ALTER TABLE document_access_log DROP CONSTRAINT document_access_log_actor_type_check;
//       ALTER TABLE document_access_log ADD CONSTRAINT document_access_log_actor_type_check
//         CHECK (actor_type in ('user','client','system','external_recipient'));
//     Purely additive (widens the allowed set) — no backfill, no existing
//     row can violate it.
// ---------------------------------------------------------------------------
