// c89 — outbound document sharing, database side: creating a link (staff,
// tenant-scoped, privilege-enforced), the public token-based access the
// unauthenticated endpoint calls, revoking, and listing a matter's/group's
// links with their access history.
//
// Every view/download through a link — allowed or denied — is a row in
// document_access_log (actorType 'external_recipient'), the SAME append-only
// table the rest of the Document engine logs through (access/service.ts),
// not a parallel log. The link row itself (document_share_links) only ever
// changes in place (download_count, last_accessed_at, revoked_*); it is
// never deleted.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { documents } from "@/db/schema";
import { documentAccessLog, documentGroups, documentShareLinks, documentVersionFiles } from "@/db/tables/document";
import { audit } from "@/core";
import type { TenantTx } from "@/tenancy/withTenant";
import { DocumentError, NotFoundError } from "../errors";
import { ENGINE, type DocumentSettings } from "../settings";
import { decideDocumentAccess, type AccessContext, type StaffViewer } from "../access/policy";
import { actorOf } from "../access/service";
import { gatedAdapters, type DocumentAdapters } from "../storage/adapters";
import { checksumsMatch, sha256Hex } from "../versions/versioning";
import { generateShareToken, hashShareSecret } from "./crypto";
import {
  decideShareAccess,
  requiresPrivilegedOverride,
  statusForShareDenial,
  validateCreateShareLinkInput,
  type CreateShareLinkCandidate,
  type RecipientType,
  type ShareAccessAction,
} from "./policy";

interface Ctx {
  tenantId: string;
  viewer: StaffViewer;
  access: AccessContext;
  settings: DocumentSettings;
  adapters?: DocumentAdapters;
  now?: Date;
}

type ShareLinkRow = typeof documentShareLinks.$inferSelect;

async function loadGroupAndCurrent(tx: TenantTx, tenantId: string, groupId: string) {
  const [g] = await tx.select().from(documentGroups).where(and(eq(documentGroups.tenantId, tenantId), eq(documentGroups.id, groupId))).limit(1);
  if (!g) throw new NotFoundError("Document");
  const [cur] = await tx.select().from(documents).where(eq(documents.id, g.currentDocumentId)).limit(1);
  if (!cur) throw new NotFoundError("Document");
  return { group: g, current: cur };
}

function requireCanShare(viewer: StaffViewer): void {
  // Sending a document outside the firm is the same class of decision as
  // making it clientVisible or lifting a legal hold (store/service.ts
  // updateDocumentGroup) — attorney-only, never just "documents.write".
  if (!viewer.permissions.includes("documents.write") || !viewer.permissions.includes("documents.approve")) {
    throw new DocumentError("Only an attorney can share a document outside the firm.", 403);
  }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateShareLinkInput extends CreateShareLinkCandidate {
  groupId: string;
}

export interface CreateShareLinkResult {
  linkId: string;
  /** Shown ONCE — build the recipient's URL from this and hand it over now; it cannot be recovered later. */
  token: string;
  groupId: string;
  documentId: string;
  matterId: string;
  recipientType: RecipientType;
  expiresAt: Date;
  maxDownloads: number | null;
  privilegedOverrideConfirmed: boolean;
}

export async function createShareLink(tx: TenantTx, ctx: Ctx, input: CreateShareLinkInput): Promise<CreateShareLinkResult> {
  const { tenantId, viewer } = ctx;
  requireCanShare(viewer);
  const now = ctx.now ?? new Date();

  const { group, current } = await loadGroupAndCurrent(tx, tenantId, input.groupId);
  // The sharing staff member must themselves be able to see this document —
  // a screen or a restricted tag beats "I'm an attorney" just like it does
  // everywhere else in this engine.
  const viewDecision = decideDocumentAccess(viewer, "view", { matterId: group.matterId, privilegeTag: current.privilegeTag, clientVisible: current.clientVisible }, ctx.access);
  if (!viewDecision.allowed) throw new DocumentError("You cannot share this document.", 403, { reason: viewDecision.reason });

  // Validate recipientType before computing the override requirement — a
  // bad recipientType should fail with ITS own message, not a confusing
  // "needs an override" one for a type validateCreateShareLinkInput will
  // reject anyway.
  const recipientType = input.recipientType;
  const needsOverride = requiresPrivilegedOverride({ privilegeTag: current.privilegeTag, clientVisible: current.clientVisible }, recipientType as RecipientType);
  const check = validateCreateShareLinkInput(input, needsOverride, now);
  if (!check.ok) throw new DocumentError(check.errors.join(" "), 422);

  const { token, tokenHash } = generateShareToken(tenantId);
  const [row] = await tx
    .insert(documentShareLinks)
    .values({
      tenantId,
      matterId: group.matterId,
      groupId: group.id,
      documentId: current.id,
      createdByUserId: viewer.userId,
      recipientType: input.recipientType as string,
      recipientLabel: check.recipientLabel,
      tokenHash,
      expiresAt: check.expiresAt,
      maxDownloads: check.maxDownloads,
      privilegedOverrideConfirmed: needsOverride,
      privilegedOverrideConfirmedByUserId: needsOverride ? viewer.userId : null,
      privilegedOverrideReason: needsOverride ? (input.privilegedOverrideReason as string).trim() : null,
      createdAt: now,
    })
    .returning();

  await audit(tx, {
    tenantId,
    engine: ENGINE,
    action: "document_share_link.created",
    entityType: "document_share_link",
    entityId: row!.id,
    matterId: group.matterId,
    actor: actorOf(viewer),
    reason: needsOverride ? (input.privilegedOverrideReason as string).trim() : null,
    payload: {
      groupId: group.id,
      documentId: current.id,
      recipientType: input.recipientType,
      recipientLabel: check.recipientLabel,
      expiresAt: check.expiresAt.toISOString(),
      maxDownloads: check.maxDownloads,
      privilegeTag: current.privilegeTag,
      privilegedOverrideConfirmed: needsOverride,
    },
  });

  return {
    linkId: row!.id,
    token,
    groupId: group.id,
    documentId: current.id,
    matterId: group.matterId,
    recipientType: input.recipientType as RecipientType,
    expiresAt: check.expiresAt,
    maxDownloads: check.maxDownloads,
    privilegedOverrideConfirmed: needsOverride,
  };
}

// ---------------------------------------------------------------------------
// Public, token-based access (no session — see src/app/api/document/share)
// ---------------------------------------------------------------------------

async function logShareAccess(
  tx: TenantTx,
  tenantId: string,
  input: {
    shareLinkId: string | null;
    groupId?: string | null;
    documentId?: string | null;
    matterId?: string | null;
    action: ShareAccessAction;
    outcome: "allowed" | "denied";
    reason?: string | null;
    detail?: Record<string, unknown>;
  }
): Promise<void> {
  if (input.outcome === "denied" && !input.reason) throw new Error("A denied share access needs a reason.");
  await tx.insert(documentAccessLog).values({
    tenantId,
    documentId: input.documentId ?? null,
    groupId: input.groupId ?? null,
    matterId: input.matterId ?? null,
    actorType: "external_recipient",
    actorUserId: null,
    actorPartyId: null,
    action: input.action,
    outcome: input.outcome,
    reason: input.reason ?? null,
    detail: { shareLinkId: input.shareLinkId, ...(input.detail ?? {}) },
  });
}

type ShareDenialReason = Parameters<typeof statusForShareDenial>[0];

class ShareAccessDeniedError extends DocumentError {
  constructor(readonly reason: ShareDenialReason) {
    super("This link is not valid.", statusForShareDenial(reason));
    this.name = "ShareAccessDeniedError";
  }
}

async function denyShareAndLog(
  tx: TenantTx,
  tenantId: string,
  link: Pick<ShareLinkRow, "id" | "groupId" | "documentId" | "matterId"> | null,
  action: ShareAccessAction,
  reason: ShareDenialReason
): Promise<never> {
  await logShareAccess(tx, tenantId, {
    shareLinkId: link?.id ?? null,
    groupId: link?.groupId ?? null,
    documentId: link?.documentId ?? null,
    matterId: link?.matterId ?? null,
    action,
    outcome: "denied",
    reason,
  });
  throw new ShareAccessDeniedError(reason);
}

/**
 * If the group has never been marked "sent" any other way, a successful
 * download through a share link is itself evidence the file reached the
 * other side (c40). Best-effort: 'not_yet' only, never overwrites a status
 * a human already set ('sent' or 'not_needed').
 */
async function markDeliveredIfOutstanding(tx: TenantTx, tenantId: string, groupId: string, now: Date): Promise<void> {
  await tx
    .update(documentGroups)
    .set({ deliveryStatus: "sent", deliveryMethod: "platform", deliveryConfirmedAt: now, updatedAt: now })
    .where(and(eq(documentGroups.tenantId, tenantId), eq(documentGroups.id, groupId), eq(documentGroups.deliveryStatus, "not_yet")));
}

export interface SharedDocumentView {
  linkId: string;
  groupId: string;
  documentId: string;
  matterId: string;
  title: string;
  recipientLabel: string | null;
  expiresAt: Date;
  name: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  version: number;
}

/** GET /api/document/share/[token] — metadata only. Logged as 'view'. Throws ShareAccessDeniedError (mapped by http.ts). */
export async function viewSharedDocument(tx: TenantTx, tenantId: string, secret: string, now: Date = new Date()): Promise<SharedDocumentView> {
  const tokenHash = hashShareSecret(secret);
  const [row] = await tx
    .select({ link: documentShareLinks, group: documentGroups, doc: documents })
    .from(documentShareLinks)
    .innerJoin(documentGroups, eq(documentGroups.id, documentShareLinks.groupId))
    .innerJoin(documents, eq(documents.id, documentShareLinks.documentId))
    .where(and(eq(documentShareLinks.tenantId, tenantId), eq(documentShareLinks.tokenHash, tokenHash)))
    .limit(1);
  if (!row) return denyShareAndLog(tx, tenantId, null, "view", "invalid_token");
  const { link, group, doc } = row;

  const decision = decideShareAccess(link, "view", now);
  if (!decision.allowed) return denyShareAndLog(tx, tenantId, link, "view", decision.reason);

  await tx.update(documentShareLinks).set({ lastAccessedAt: now }).where(eq(documentShareLinks.id, link.id));
  await logShareAccess(tx, tenantId, { shareLinkId: link.id, groupId: link.groupId, documentId: link.documentId, matterId: link.matterId, action: "view", outcome: "allowed" });

  return {
    linkId: link.id,
    groupId: group.id,
    documentId: doc.id,
    matterId: link.matterId,
    title: group.title,
    recipientLabel: link.recipientLabel,
    expiresAt: link.expiresAt,
    name: doc.name,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    version: doc.version,
  };
}

export interface SharedDocumentDownload {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
  sha256: string;
}

/** GET /api/document/share/[token]/download — the bytes of the PINNED version. Logged as 'download'. */
export async function downloadSharedDocument(
  tx: TenantTx,
  tenantId: string,
  secret: string,
  adapters: DocumentAdapters | undefined,
  now: Date = new Date()
): Promise<SharedDocumentDownload> {
  const tokenHash = hashShareSecret(secret);
  const [link] = await tx
    .select()
    .from(documentShareLinks)
    .where(and(eq(documentShareLinks.tenantId, tenantId), eq(documentShareLinks.tokenHash, tokenHash)))
    .for("update")
    .limit(1);
  if (!link) return denyShareAndLog(tx, tenantId, null, "download", "invalid_token");

  const decision = decideShareAccess(link, "download", now);
  if (!decision.allowed) return denyShareAndLog(tx, tenantId, link, "download", decision.reason);

  const [fileRow] = await tx
    .select({ doc: documents, file: documentVersionFiles })
    .from(documents)
    .innerJoin(documentVersionFiles, eq(documentVersionFiles.documentId, documents.id))
    .where(and(eq(documents.tenantId, tenantId), eq(documents.id, link.documentId)))
    .limit(1);
  // Should not happen — documents and their version files are never deleted
  // (MIGRATION NOTES #2/#3) — but this is a data-integrity gap, not an
  // access decision, so it is a plain error, not a logged denial.
  if (!fileRow) throw new DocumentError("This document is not available right now.", 500);
  const { doc, file } = fileRow;

  const resolved = gatedAdapters(tenantId, adapters);
  const bytes = await resolved.storage.get(file.storageKey);
  if (!checksumsMatch(sha256Hex(bytes), file.sha256)) {
    await audit(tx, { tenantId, engine: ENGINE, action: "document.integrity_failed", entityType: "document", entityId: doc.id, matterId: link.matterId, payload: { storage: file.storageAdapter, shareLinkId: link.id } });
    return denyShareAndLog(tx, tenantId, link, "download", "integrity_failed");
  }

  await tx
    .update(documentShareLinks)
    .set({ downloadCount: sql`${documentShareLinks.downloadCount} + 1`, lastAccessedAt: now })
    .where(eq(documentShareLinks.id, link.id));
  await markDeliveredIfOutstanding(tx, tenantId, link.groupId, now);
  await logShareAccess(tx, tenantId, {
    shareLinkId: link.id,
    groupId: link.groupId,
    documentId: link.documentId,
    matterId: link.matterId,
    action: "download",
    outcome: "allowed",
    detail: { bytes: bytes.length },
  });

  return { bytes, filename: doc.name ?? file.originalFilename ?? "document", mimeType: doc.mimeType ?? "application/octet-stream", sha256: file.sha256 };
}

// ---------------------------------------------------------------------------
// Revoke
// ---------------------------------------------------------------------------

export async function revokeShareLink(tx: TenantTx, ctx: Ctx, linkId: string, reason: string): Promise<ShareLinkRow> {
  const { tenantId, viewer } = ctx;
  if (!viewer.permissions.includes("documents.write")) throw new DocumentError("Not allowed.", 403);
  if (!reason.trim()) throw new DocumentError("A reason is required to revoke a share link.");
  const now = ctx.now ?? new Date();

  const [link] = await tx.select().from(documentShareLinks).where(and(eq(documentShareLinks.tenantId, tenantId), eq(documentShareLinks.id, linkId))).for("update").limit(1);
  if (!link) throw new NotFoundError("Share link");
  if (link.revokedAt) throw new DocumentError("This link has already been revoked.", 409);

  const [row] = await tx
    .update(documentShareLinks)
    .set({ revokedAt: now, revokedByUserId: viewer.userId, revokedReason: reason.trim() })
    .where(eq(documentShareLinks.id, link.id))
    .returning();

  await audit(tx, {
    tenantId,
    engine: ENGINE,
    action: "document_share_link.revoked",
    entityType: "document_share_link",
    entityId: link.id,
    matterId: link.matterId,
    actor: actorOf(viewer),
    reason: reason.trim(),
    payload: { groupId: link.groupId, documentId: link.documentId },
  });
  return row!;
}

// ---------------------------------------------------------------------------
// Listing (staff)
// ---------------------------------------------------------------------------

export interface ShareLinkSummary extends Omit<ShareLinkRow, "tokenHash"> {
  accessCount: { allowed: number; denied: number };
}

async function accessCountsFor(tx: TenantTx, tenantId: string, linkIds: readonly string[]): Promise<Map<string, { allowed: number; denied: number }>> {
  const out = new Map<string, { allowed: number; denied: number }>();
  if (linkIds.length === 0) return out;
  const shareLinkIdExpr = sql<string>`${documentAccessLog.detail} ->> 'shareLinkId'`;
  const rows = await tx
    .select({ shareLinkId: shareLinkIdExpr, outcome: documentAccessLog.outcome, n: sql<number>`count(*)::int` })
    .from(documentAccessLog)
    .where(and(eq(documentAccessLog.tenantId, tenantId), eq(documentAccessLog.actorType, "external_recipient"), inArray(shareLinkIdExpr, [...linkIds])))
    .groupBy(shareLinkIdExpr, documentAccessLog.outcome);
  for (const r of rows) {
    const id = r.shareLinkId;
    if (!id) continue;
    const entry = out.get(id) ?? { allowed: 0, denied: 0 };
    if (r.outcome === "allowed") entry.allowed += r.n;
    else entry.denied += r.n;
    out.set(id, entry);
  }
  return out;
}

function omitHash(row: ShareLinkRow): Omit<ShareLinkRow, "tokenHash"> {
  const rest: Partial<ShareLinkRow> = { ...row };
  delete rest.tokenHash;
  return rest as Omit<ShareLinkRow, "tokenHash">;
}

/** A matter's (or one group's) share links, newest first, with each link's allowed/denied access counts. Never includes tokenHash. */
export async function listShareLinks(tx: TenantTx, tenantId: string, filter: { matterId?: string; groupId?: string }): Promise<ShareLinkSummary[]> {
  const conds = [eq(documentShareLinks.tenantId, tenantId)];
  if (filter.matterId) conds.push(eq(documentShareLinks.matterId, filter.matterId));
  if (filter.groupId) conds.push(eq(documentShareLinks.groupId, filter.groupId));
  const rows = await tx.select().from(documentShareLinks).where(and(...conds)).orderBy(desc(documentShareLinks.createdAt));
  const counts = await accessCountsFor(tx, tenantId, rows.map((r) => r.id));
  return rows.map((r) => ({ ...omitHash(r), accessCount: counts.get(r.id) ?? { allowed: 0, denied: 0 } }));
}

export interface ShareLinkDetail {
  link: Omit<ShareLinkRow, "tokenHash">;
  history: (typeof documentAccessLog.$inferSelect)[];
}

/** One link plus its full access history (every row document_access_log holds for it), newest first. */
export async function getShareLinkDetail(tx: TenantTx, tenantId: string, linkId: string): Promise<ShareLinkDetail> {
  const [link] = await tx.select().from(documentShareLinks).where(and(eq(documentShareLinks.tenantId, tenantId), eq(documentShareLinks.id, linkId))).limit(1);
  if (!link) throw new NotFoundError("Share link");
  const history = await tx
    .select()
    .from(documentAccessLog)
    .where(and(eq(documentAccessLog.tenantId, tenantId), eq(documentAccessLog.actorType, "external_recipient"), sql`${documentAccessLog.detail} ->> 'shareLinkId' = ${linkId}`))
    .orderBy(desc(documentAccessLog.occurredAt));
  return { link: omitHash(link), history };
}
