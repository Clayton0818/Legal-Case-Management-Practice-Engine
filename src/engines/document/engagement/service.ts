// c39 — Document engine · the client signs the engagement agreement.
//
// Sequence: draft the agreement from the matter + gated fee terms -> send it
// out for e-signature -> client signs -> firm countersigns -> matter stage
// becomes 'retained' and the intake session closes.
//
// c4 ("E-signature & engagement letter generation") is the actual vendor
// integration; this file is the workflow/orchestration step c39 names as its
// own job ("c4 is the build, this tile is the workflow step it serves"). It
// talks to e-signature only through SignatureRequestAdapter below, which has
// no real vendor behind it yet — every request fails closed through
// vendor.esignature until c4 wires one in with setSignatureAdapter().
//
// The fee terms embedded in the agreement text are the gated
// rules.fee_agreement_terms wording (RULE_GATES.feeAgreementTerms): a
// visible placeholder until an attorney approves real terms, never
// hard-coded law. The optional AI-disclosure clause (c10 §4.6) is the same
// kind of gated copy (DOCUMENT_COPY_GATES.aiDisclosureNotice).

import { and, eq, isNull } from "drizzle-orm";
import { documents, intakeSessions, matters, parties, users } from "@/db/schema";
import { audit, raiseFlag, type Actor } from "@/core";
import { auditBlocked } from "@/core/audit";
import { legalCopy, requireApproval, runGated, type PendingApprovalError } from "@/compliance/approvals";
import type { TenantTx } from "@/tenancy/withTenant";
import { DocumentError, NotFoundError } from "../errors";
import { ENGINE, type DocumentSettings } from "../settings";
import { decideMatter, type AccessContext, type StaffViewer } from "../access/policy";
import { actorOf } from "../access/service";
import { folderByKey } from "../folders/service";
import { uploadDocument, type UploadResult } from "../store/service";
import type { DocumentAdapters } from "../storage/adapters";
import { DOCUMENT_COPY_GATES, RULE_GATES, VENDOR_GATES } from "../gates";

export const ENGAGEMENT_DOCUMENT_TYPE = "engagement_agreement";

/** Matter stages an engagement agreement may still be started from (c39). */
export const ENGAGEMENT_ELIGIBLE_STAGES = [
  "prospective",
  "consultation_scheduled",
  "consult_completed_manual_follow_up",
  "pending_review",
] as const;

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

export interface EngagementAgreementVars {
  firmName: string;
  clientName: string;
  /** Gated wording (RULE_GATES.feeAgreementTerms), already resolved by legalCopy(). */
  feeTermsText: string;
  /** Gated AI-disclosure wording (c10 §4.6), already resolved by legalCopy(). */
  aiDisclosureText: string;
}

/**
 * Compose the agreement body. Pure — callers resolve the gated wording with
 * legalCopy() first so this function has no compliance-registry dependency
 * and is trivial to test with fixed strings.
 */
export function composeEngagementAgreementText(vars: EngagementAgreementVars): string {
  return [
    `ENGAGEMENT AGREEMENT`,
    ``,
    `Client: ${vars.clientName}`,
    `Firm: ${vars.firmName}`,
    ``,
    `FEE TERMS`,
    vars.feeTermsText,
    ``,
    `USE OF ARTIFICIAL INTELLIGENCE`,
    vars.aiDisclosureText,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

interface EngagementCtx {
  tenantId: string;
  viewer: StaffViewer;
  access: AccessContext;
  settings: DocumentSettings;
  /** Passed straight through to uploadDocument(); omit to use the engine's default (internal) adapters. */
  adapters?: DocumentAdapters;
  now?: Date;
}

function requireAttorneyDecision(viewer: StaffViewer, what: string): void {
  // documents.approve is an ATTORNEY_ONLY decision right (src/auth/rbac.ts);
  // sending/countersigning a binding agreement is squarely that kind of call.
  if (!viewer.permissions.includes("documents.approve")) {
    throw new DocumentError(`Only an attorney can ${what}.`, 403);
  }
}

async function loadMatterForEngagement(tx: TenantTx, tenantId: string, matterId: string) {
  const [m] = await tx
    .select({ id: matters.id, stage: matters.stage, primaryPartyId: matters.primaryPartyId })
    .from(matters)
    .where(and(eq(matters.tenantId, tenantId), eq(matters.id, matterId)))
    .limit(1);
  if (!m) throw new NotFoundError("Matter");
  return m;
}

async function firmAdminIds(tx: TenantTx, tenantId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.role, "firm_admin"), eq(users.status, "active")));
  return rows.map((r) => r.id);
}

export type StartEngagementResult =
  | { status: "sent_for_signature"; documentId: string; groupId: string; vendorRequestId: string }
  | { status: "blocked_pending_esignature_vendor"; documentId: string; groupId: string; placeholder: string };

/**
 * Generate the agreement and send it out for e-signature. Writes the draft
 * even when the send is blocked (c39's drafting step is real work the firm
 * can see and start preparing around; only the vendor call is gated).
 */
export async function startEngagementAgreement(
  tx: TenantTx,
  ctx: EngagementCtx,
  input: { matterId: string; firmName?: string }
): Promise<StartEngagementResult> {
  requireAttorneyDecision(ctx.viewer, "start an engagement agreement");
  const matter = await loadMatterForEngagement(tx, ctx.tenantId, input.matterId);
  if (!(ENGAGEMENT_ELIGIBLE_STAGES as readonly string[]).includes(matter.stage)) {
    throw new DocumentError(`An engagement agreement cannot be started from matter stage '${matter.stage}'.`, 409);
  }
  const scope = decideMatter(ctx.viewer, input.matterId, ctx.access);
  if (!scope.allowed) throw new DocumentError("You do not have access to this matter.", 403, { reason: scope.reason });

  const [party] = await tx.select({ fullName: parties.fullName }).from(parties).where(eq(parties.id, matter.primaryPartyId)).limit(1);
  const now = ctx.now ?? new Date();

  const text = composeEngagementAgreementText({
    firmName: input.firmName ?? "the firm",
    clientName: party?.fullName ?? "the client",
    feeTermsText: legalCopy(RULE_GATES.feeAgreementTerms.key),
    aiDisclosureText: legalCopy(DOCUMENT_COPY_GATES.aiDisclosureNotice.key),
  });

  const folder = await folderByKey(tx, ctx.tenantId, input.matterId, "agreements");
  const upload: UploadResult = await uploadDocument(
    tx,
    { tenantId: ctx.tenantId, viewer: ctx.viewer, access: ctx.access, settings: ctx.settings, adapters: ctx.adapters, now },
    {
      matterId: input.matterId,
      folderId: folder?.id ?? null,
      bytes: new TextEncoder().encode(text),
      filename: "Engagement Agreement.html",
      declaredMimeType: "text/html",
      documentType: ENGAGEMENT_DOCUMENT_TYPE,
      privilegeTag: "confidential",
      title: `Engagement Agreement — ${party?.fullName ?? input.matterId}`,
    }
  );

  const gated = await runGated(
    VENDOR_GATES.esignature.key,
    "document.engagement.request_signature",
    () => getSignatureAdapter().requestSignature({ tenantId: ctx.tenantId, documentId: upload.documentId, signerName: party?.fullName ?? "the client", signerEmail: null }),
    { tenantId: ctx.tenantId, detail: { documentId: upload.documentId, matterId: input.matterId } }
  );

  if (!gated.ok) {
    await auditBlocked(tx, gated.blocked, {
      tenantId: ctx.tenantId,
      engine: ENGINE,
      entityType: "document",
      entityId: upload.documentId,
      matterId: input.matterId,
      actor: actorOf(ctx.viewer),
    });
    return { status: "blocked_pending_esignature_vendor", documentId: upload.documentId, groupId: upload.groupId, placeholder: gated.blocked.placeholder };
  }

  await tx.update(documents).set({ status: "client_review", clientVisible: true, updatedAt: now }).where(eq(documents.id, upload.documentId));
  await audit(tx, {
    tenantId: ctx.tenantId,
    engine: ENGINE,
    action: "document.engagement.signature_requested",
    entityType: "document",
    entityId: upload.documentId,
    matterId: input.matterId,
    actor: actorOf(ctx.viewer),
    payload: { groupId: upload.groupId, vendorRequestId: gated.value.vendorRequestId },
  });
  return { status: "sent_for_signature", documentId: upload.documentId, groupId: upload.groupId, vendorRequestId: gated.value.vendorRequestId };
}

/** The client signs. Does not yet move the matter — that waits for the firm's countersignature. */
export async function recordClientSignature(
  tx: TenantTx,
  input: { tenantId: string; documentId: string; partyId: string; now?: Date }
): Promise<void> {
  const now = input.now ?? new Date();
  const [doc] = await tx.select().from(documents).where(and(eq(documents.tenantId, input.tenantId), eq(documents.id, input.documentId))).limit(1);
  if (!doc) throw new NotFoundError("Document");
  if (doc.status !== "client_review") throw new DocumentError(`This agreement is not awaiting a client signature (status: ${doc.status}).`, 409);
  const [matter] = await tx.select({ primaryPartyId: matters.primaryPartyId }).from(matters).where(eq(matters.id, doc.matterId)).limit(1);
  if (!matter || matter.primaryPartyId !== input.partyId) throw new DocumentError("You are not a party to this matter.", 403);

  await tx.update(documents).set({ status: "client_approved", updatedAt: now }).where(eq(documents.id, doc.id));
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "document.engagement.client_signed",
    entityType: "document",
    entityId: doc.id,
    matterId: doc.matterId,
    actor: { type: "client", partyId: input.partyId },
    payload: { version: doc.version },
  });
}

export interface CountersignResult {
  documentId: string;
  matterId: string;
  matterStage: "retained";
  intakeSessionClosed: boolean;
}

/**
 * The firm countersigns: the agreement becomes fully executed. This is the
 * "on signature" moment the card means — matter stage -> retained, the
 * intake session closes, and billing/trust gets a heads-up that a retainer
 * request may be due (c39's hand-off; billing-trust engine is not built
 * yet, so this is a flag for a human, never a trust-account movement —
 * that always needs rules.trust_accounting separately).
 */
export async function recordFirmCountersignature(
  tx: TenantTx,
  ctx: Omit<EngagementCtx, "settings">,
  input: { documentId: string }
): Promise<CountersignResult> {
  requireAttorneyDecision(ctx.viewer, "countersign an engagement agreement");
  const now = ctx.now ?? new Date();
  const [doc] = await tx.select().from(documents).where(and(eq(documents.tenantId, ctx.tenantId), eq(documents.id, input.documentId))).limit(1);
  if (!doc) throw new NotFoundError("Document");
  if (doc.status !== "client_approved") throw new DocumentError(`This agreement is not awaiting the firm's countersignature (status: ${doc.status}).`, 409);
  const scope = decideMatter(ctx.viewer, doc.matterId, ctx.access);
  if (!scope.allowed) throw new DocumentError("You do not have access to this matter.", 403, { reason: scope.reason });

  await tx.update(documents).set({ status: "final", updatedAt: now }).where(eq(documents.id, doc.id));
  await tx.update(matters).set({ stage: "retained" }).where(eq(matters.id, doc.matterId));
  await audit(tx, {
    tenantId: ctx.tenantId,
    engine: ENGINE,
    action: "document.engagement.countersigned",
    entityType: "document",
    entityId: doc.id,
    matterId: doc.matterId,
    actor: actorOf(ctx.viewer),
    payload: { version: doc.version },
  });
  await audit(tx, {
    tenantId: ctx.tenantId,
    engine: ENGINE,
    action: "matter.stage_changed",
    entityType: "matter",
    entityId: doc.matterId,
    matterId: doc.matterId,
    actor: actorOf(ctx.viewer),
    payload: { to: "retained", reason: "engagement_agreement_fully_executed" },
  });

  const [session] = await tx
    .select({ id: intakeSessions.id })
    .from(intakeSessions)
    .where(and(eq(intakeSessions.tenantId, ctx.tenantId), eq(intakeSessions.matterId, doc.matterId), isNull(intakeSessions.completedAt)))
    .limit(1);
  let intakeSessionClosed = false;
  if (session) {
    await tx.update(intakeSessions).set({ completedAt: now, terminalState: "retained" }).where(eq(intakeSessions.id, session.id));
    await audit(tx, {
      tenantId: ctx.tenantId,
      engine: ENGINE,
      action: "intake_session.completed",
      entityType: "intake_session",
      entityId: session.id,
      matterId: doc.matterId,
      intakeSessionId: session.id,
      actor: actorOf(ctx.viewer),
      payload: { terminalState: "retained" },
    });
    intakeSessionClosed = true;
  }

  // Billing & trust hand-off (c39 note): no billing-trust engine exists yet
  // to receive this, so a human is flagged instead of any money moving.
  // rules.trust_accounting still gates the actual retainer-into-IOLTA step
  // whenever that engine is built; this flag never bypasses it.
  const admins = await firmAdminIds(tx, ctx.tenantId);
  const recipients = [...new Set([...admins, ...(ctx.viewer.userId ? [ctx.viewer.userId] : [])])];
  if (recipients.length > 0) {
    await raiseFlag(tx, {
      tenantId: ctx.tenantId,
      type: "document.engagement.retainer_handoff",
      severity: "info",
      audience: "internal",
      title: "New retained matter — a retainer request may be due",
      summary: `The engagement agreement for matter ${doc.matterId} is fully executed. Check whether a retainer request into trust is needed (rules.trust_accounting).`,
      matterId: doc.matterId,
      recipients: { userIds: recipients },
      dedupeKey: `document.engagement.retainer_handoff:${doc.matterId}`,
      engine: ENGINE,
      sourceCard: "c39",
    });
  }

  return { documentId: doc.id, matterId: doc.matterId, matterStage: "retained", intakeSessionClosed };
}

// ---------------------------------------------------------------------------
// Signature-request adapter seam (for c4 to fill in later)
// ---------------------------------------------------------------------------

export interface SignatureRequestAdapter {
  readonly name: string;
  requestSignature(input: { tenantId: string; documentId: string; signerName: string; signerEmail: string | null }): Promise<{ vendorRequestId: string }>;
}

/** No e-signature vendor is wired yet: every call fails closed through vendor.esignature. */
export class UnavailableSignatureAdapter implements SignatureRequestAdapter {
  readonly name = "unavailable";
  async requestSignature(input: { tenantId: string }): Promise<{ vendorRequestId: string }> {
    requireApproval(VENDOR_GATES.esignature.key, { action: "document.request_signature", tenantId: input.tenantId });
    // requireApproval always throws while the gate is pending; this line is
    // only reachable once a real adapter is swapped in with setSignatureAdapter().
    throw new Error("UnavailableSignatureAdapter: no e-signature vendor configured.");
  }
}

let signatureAdapter: SignatureRequestAdapter = new UnavailableSignatureAdapter();

/** c4 (or tests): plug in a real adapter. Pass null to reset to the fail-closed default. */
export function setSignatureAdapter(next: SignatureRequestAdapter | null): void {
  signatureAdapter = next ?? new UnavailableSignatureAdapter();
}

export function getSignatureAdapter(): SignatureRequestAdapter {
  return signatureAdapter;
}

// Re-exported so callers constructing an Actor for recordClientSignature's
// audit entry do not need a separate import just for the type.
export type { Actor };
export type { PendingApprovalError };
