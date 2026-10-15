// c41 — Document engine · the AI asks the client to review and sign off a
// document before it is filed.
//
// Reuses the shared `documents` lifecycle (src/core/documents.ts) end to
// end: attorney_approved -> client_review -> client_approved. "Restart
// sign-off on edit" needs no extra bookkeeping here: an edited document is a
// NEW version (a new `documents` row created by uploadDocument(), starting
// at status 'uploaded') while the old version is superseded, so the review
// the client already acted on can never be mistaken for a review of the new
// bytes — the new version simply has not been asked for yet.
//
// The AI delivers the request and records the client's decision only. It
// never explains what the document means or whether the client should sign
// (UPL guardrail, c41) — that is why DOCUMENT_COPY_GATES.clientSignoffRequest
// carries no legal explanation, and why this file never writes client-facing
// prose of its own.

import { and, eq } from "drizzle-orm";
import { documents, matters, users } from "@/db/schema";
import { tasks } from "@/db/tables/foundation";
import { audit, cancelTask, completeTask, createTask, raiseFlag, type TaskDue, type TaskRow } from "@/core";
import type { TenantTx } from "@/tenancy/withTenant";
import { DocumentError, NotFoundError } from "../errors";
import { ENGINE } from "../settings";
import { decideMatter, type AccessContext, type StaffViewer } from "../access/policy";
import { actorOf } from "../access/service";
import { DOCUMENT_COPY_GATES } from "../gates";

/** Statuses a document may still be moved into client review from. */
export const REVIEW_ELIGIBLE_STATUSES = ["draft", "uploaded", "in_review", "attorney_approved"] as const;

/** Task kind for a client sign-off request; the document id is the task's sourceRef. */
export const SIGNOFF_TASK_KIND = "document.client_signoff";

export type ClientDecision = "approved" | "changes_requested";

interface ReviewCtx {
  tenantId: string;
  viewer: StaffViewer;
  access: AccessContext;
  now?: Date;
}

function requireAttorneyDecision(viewer: StaffViewer, what: string): void {
  if (!viewer.permissions.includes("documents.approve")) {
    throw new DocumentError(`Only an attorney can ${what}.`, 403);
  }
}

async function loadDocument(tx: TenantTx, tenantId: string, documentId: string) {
  const [d] = await tx.select().from(documents).where(and(eq(documents.tenantId, tenantId), eq(documents.id, documentId))).limit(1);
  if (!d) throw new NotFoundError("Document");
  return d;
}

async function firmAdminIds(tx: TenantTx, tenantId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.role, "firm_admin"), eq(users.status, "active")));
  return rows.map((r) => r.id);
}

async function findOpenSignoffTask(tx: TenantTx, tenantId: string, documentId: string): Promise<TaskRow | undefined> {
  const [row] = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.tenantId, tenantId), eq(tasks.kind, SIGNOFF_TASK_KIND), eq(tasks.sourceRef, documentId), eq(tasks.status, "open")))
    .limit(1);
  return row;
}

export interface RequestClientSignoffInput {
  documentId: string;
  due: TaskDue;
  /** Court date / filing deadline tied to this sign-off (real clock, no grace, critical — c44/c45). */
  deadlineCritical?: boolean;
  relatedCalendarEventId?: string | null;
}

export interface RequestClientSignoffResult {
  documentId: string;
  taskId: string;
}

/** An attorney asks the client to review and sign off this document before it is filed. */
export async function requestClientSignoff(tx: TenantTx, ctx: ReviewCtx, input: RequestClientSignoffInput): Promise<RequestClientSignoffResult> {
  requireAttorneyDecision(ctx.viewer, "send a document out for client sign-off");
  const doc = await loadDocument(tx, ctx.tenantId, input.documentId);
  if (!(REVIEW_ELIGIBLE_STATUSES as readonly string[]).includes(doc.status)) {
    throw new DocumentError(`A document in status '${doc.status}' cannot be sent for client sign-off.`, 409);
  }
  const scope = decideMatter(ctx.viewer, doc.matterId, ctx.access);
  if (!scope.allowed) throw new DocumentError("You do not have access to this matter.", 403, { reason: scope.reason });
  if (!(doc.privilegeTag === "none" || doc.privilegeTag === "confidential")) {
    throw new DocumentError(`A '${doc.privilegeTag}' document cannot be shared with the client; change its tag first.`, 409);
  }
  const [matter] = await tx.select({ primaryPartyId: matters.primaryPartyId }).from(matters).where(eq(matters.id, doc.matterId)).limit(1);
  if (!matter) throw new NotFoundError("Matter");

  const now = ctx.now ?? new Date();
  await tx.update(documents).set({ status: "client_review", clientVisible: true, updatedAt: now }).where(eq(documents.id, doc.id));
  await audit(tx, {
    tenantId: ctx.tenantId,
    engine: ENGINE,
    action: "document.review.signoff_requested",
    entityType: "document",
    entityId: doc.id,
    matterId: doc.matterId,
    actor: actorOf(ctx.viewer),
    payload: { version: doc.version },
  });

  const task = await createTask(
    tx,
    {
      tenantId: ctx.tenantId,
      kind: SIGNOFF_TASK_KIND,
      title: `Review and sign off: ${doc.name ?? "a document"}`,
      owner: { type: "client", partyId: matter.primaryPartyId },
      visibility: "client",
      due: input.due,
      deadlineCritical: input.deadlineCritical ?? false,
      relatedCalendarEventId: input.relatedCalendarEventId ?? null,
      matterId: doc.matterId,
      sourceCard: "c41",
      sourceRef: doc.id,
      engine: ENGINE,
      createdBy: actorOf(ctx.viewer),
    },
    { now }
  );

  await raiseFlag(
    tx,
    {
      tenantId: ctx.tenantId,
      type: "document.review.signoff_requested",
      severity: "info",
      audience: "client",
      title: "Client sign-off requested",
      summary: `A document for matter ${doc.matterId} was sent to the client for review.`,
      matterId: doc.matterId,
      taskId: task.id,
      recipients: { partyIds: [matter.primaryPartyId] },
      clientCopyKey: DOCUMENT_COPY_GATES.clientSignoffRequest.key,
      dedupeKey: `document.review.signoff_requested:${doc.id}`,
      engine: ENGINE,
      sourceCard: "c41",
    },
    { now }
  );

  return { documentId: doc.id, taskId: task.id };
}

export interface RecordClientDecisionInput {
  documentId: string;
  partyId: string;
  decision: ClientDecision;
  /** Required for 'changes_requested' — what the client wants changed. */
  comment?: string | null;
}

export type RecordClientDecisionResult = { documentId: string; status: "client_approved" | "in_review" };

/** The client approves, or asks for changes (kicks the document back to the firm). */
export async function recordClientDecision(tx: TenantTx, input: { tenantId: string; now?: Date } & RecordClientDecisionInput): Promise<RecordClientDecisionResult> {
  const doc = await loadDocument(tx, input.tenantId, input.documentId);
  if (doc.status !== "client_review") {
    throw new DocumentError(`This document is not awaiting your review (status: ${doc.status}).`, 409);
  }
  const [matter] = await tx
    .select({ primaryPartyId: matters.primaryPartyId, assignedUserId: matters.assignedUserId })
    .from(matters)
    .where(eq(matters.id, doc.matterId))
    .limit(1);
  if (!matter || matter.primaryPartyId !== input.partyId) throw new DocumentError("You are not a party to this matter.", 403);

  const now = input.now ?? new Date();
  const by = { type: "client" as const, partyId: input.partyId };
  const openTask = await findOpenSignoffTask(tx, input.tenantId, doc.id);

  if (input.decision === "approved") {
    await tx.update(documents).set({ status: "client_approved", updatedAt: now }).where(eq(documents.id, doc.id));
    await audit(tx, {
      tenantId: input.tenantId,
      engine: ENGINE,
      action: "document.review.client_approved",
      entityType: "document",
      entityId: doc.id,
      matterId: doc.matterId,
      actor: by,
      payload: { version: doc.version },
    });
    if (openTask) {
      await completeTask(tx, { tenantId: input.tenantId, taskId: openTask.id, by, reason: "Client approved the document.", engine: ENGINE });
    }
    return { documentId: doc.id, status: "client_approved" };
  }

  const comment = input.comment?.trim();
  if (!comment) throw new DocumentError("Please say what needs to change.");
  await tx.update(documents).set({ status: "in_review", updatedAt: now }).where(eq(documents.id, doc.id));
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "document.review.changes_requested",
    entityType: "document",
    entityId: doc.id,
    matterId: doc.matterId,
    actor: by,
    payload: { version: doc.version, comment },
  });
  if (openTask) {
    await cancelTask(tx, { tenantId: input.tenantId, taskId: openTask.id, by, reason: `Client requested changes: ${comment}`, engine: ENGINE });
  }
  const admins = await firmAdminIds(tx, input.tenantId);
  const recipients = [...new Set([...(matter.assignedUserId ? [matter.assignedUserId] : []), ...admins])];
  if (recipients.length > 0) {
    await raiseFlag(
      tx,
      {
        tenantId: input.tenantId,
        type: "document.review.changes_requested",
        severity: "warning",
        audience: "internal",
        title: "Client requested changes before signing off",
        summary: comment,
        details: { documentId: doc.id },
        matterId: doc.matterId,
        recipients: { userIds: recipients },
        dedupeKey: `document.review.changes_requested:${doc.id}:${now.getTime()}`,
        engine: ENGINE,
        sourceCard: "c41",
      },
      { now }
    );
  }

  return { documentId: doc.id, status: "in_review" };
}
