// c49 — required-documents checklist, database side. A matter's checklist
// is seeded once from the firm's active template (by practice area, falling
// back to the firm-wide one) and then lives on its own rows: a missing item
// exists before any file does, which is exactly what document_groups cannot
// model (a group needs bytes to exist at all).
//
// "Flagged on both client and firm sides" (c49) is satisfied by two existing
// mechanisms rather than a new one: requesting an item creates a task (core/
// tasks.ts) visible to whoever is responsible for it — a CLIENT task shows
// in their portal to-do list (c46), a firm task shows on the firm side — and
// overdue escalation for that task is the calendar/alerts engine's job
// (c44/c45/c46), not this file's. A client-responsible request also raises a
// 'both' flag so it shows on the matter's firm-side flag list too.

import { and, desc, eq, isNull, max } from "drizzle-orm";
import { matters } from "@/db/schema";
import { documentChecklistItems, documentChecklistTemplates, type ChecklistTemplateItem } from "@/db/tables/document";
import { tasks } from "@/db/tables/foundation";
import { audit, cancelTask, completeTask, createTask, raiseFlag, type Actor, type TaskDue, type TaskRow } from "@/core";
import { NOTIFY_COPY_GATES } from "@/compliance/gates";
import type { TenantTx } from "@/tenancy/withTenant";
import { DocumentError, NotFoundError } from "../errors";
import { ENGINE } from "../settings";
import { decideMatter, type AccessContext, type StaffViewer } from "../access/policy";
import { actorOf } from "../access/service";
import { missingChecklistItems, pickChecklistTemplate, validateChecklistTemplate } from "./template";

export const CHECKLIST_TASK_KIND = "document.checklist_item_requested";

function requireTemplateManager(viewer: StaffViewer): void {
  if (!viewer.permissions.includes("settings.manage") && viewer.role !== "attorney") {
    throw new DocumentError("Only a firm admin or an attorney can manage checklist templates.", 403);
  }
}

function requireWrite(viewer: StaffViewer, what: string): void {
  if (!viewer.permissions.includes("documents.write")) throw new DocumentError(`You cannot ${what}.`, 403);
}

// ---------------------------------------------------------------------------
// Templates (firm-set, per practice area) — mirrors folders/service.ts
// ---------------------------------------------------------------------------

export async function listChecklistTemplates(tx: TenantTx, tenantId: string) {
  return tx
    .select()
    .from(documentChecklistTemplates)
    .where(eq(documentChecklistTemplates.tenantId, tenantId))
    .orderBy(desc(documentChecklistTemplates.version));
}

export async function createChecklistTemplate(
  tx: TenantTx,
  tenantId: string,
  by: StaffViewer,
  input: { name: string; practiceArea: string | null; items: unknown }
) {
  requireTemplateManager(by);
  if (!input.name?.trim()) throw new DocumentError("Template name is required.");
  const v = validateChecklistTemplate(input.items);
  if (!v.ok) throw new DocumentError("The checklist template has problems.", 422, { errors: v.errors });
  const area = input.practiceArea;
  const [prev] = await tx
    .select({ v: max(documentChecklistTemplates.version) })
    .from(documentChecklistTemplates)
    .where(
      and(
        eq(documentChecklistTemplates.tenantId, tenantId),
        area === null ? isNull(documentChecklistTemplates.practiceArea) : eq(documentChecklistTemplates.practiceArea, area)
      )
    );
  const [row] = await tx
    .insert(documentChecklistTemplates)
    .values({ tenantId, name: input.name.trim(), practiceArea: area, version: (prev?.v ?? 0) + 1, status: "draft", items: v.normalized, createdByUserId: by.userId })
    .returning();
  await audit(tx, {
    tenantId,
    engine: ENGINE,
    action: "checklist_template.created",
    entityType: "document_checklist_template",
    entityId: row!.id,
    actor: actorOf(by),
    payload: { practiceArea: area, version: row!.version },
  });
  return row!;
}

export async function activateChecklistTemplate(tx: TenantTx, tenantId: string, by: StaffViewer, templateId: string) {
  requireTemplateManager(by);
  const [t] = await tx
    .select()
    .from(documentChecklistTemplates)
    .where(and(eq(documentChecklistTemplates.tenantId, tenantId), eq(documentChecklistTemplates.id, templateId)))
    .for("update")
    .limit(1);
  if (!t) throw new NotFoundError("Checklist template");
  if (t.status !== "draft") throw new DocumentError(`Only a draft template can be activated (this one is ${t.status}).`, 409);
  const now = new Date();
  await tx
    .update(documentChecklistTemplates)
    .set({ status: "retired", retiredAt: now })
    .where(
      and(
        eq(documentChecklistTemplates.tenantId, tenantId),
        eq(documentChecklistTemplates.status, "active"),
        t.practiceArea === null ? isNull(documentChecklistTemplates.practiceArea) : eq(documentChecklistTemplates.practiceArea, t.practiceArea)
      )
    );
  const [row] = await tx
    .update(documentChecklistTemplates)
    .set({ status: "active", activatedAt: now, activatedByUserId: by.userId })
    .where(eq(documentChecklistTemplates.id, t.id))
    .returning();
  await audit(tx, {
    tenantId,
    engine: ENGINE,
    action: "checklist_template.activated",
    entityType: "document_checklist_template",
    entityId: t.id,
    actor: actorOf(by),
    payload: { practiceArea: t.practiceArea, version: t.version },
  });
  return row!;
}

// ---------------------------------------------------------------------------
// A matter's checklist
// ---------------------------------------------------------------------------

export type ChecklistItemRow = typeof documentChecklistItems.$inferSelect;

async function loadMatter(tx: TenantTx, tenantId: string, matterId: string) {
  const [m] = await tx
    .select({ id: matters.id, practiceArea: matters.practiceArea, primaryPartyId: matters.primaryPartyId, assignedUserId: matters.assignedUserId })
    .from(matters)
    .where(and(eq(matters.tenantId, tenantId), eq(matters.id, matterId)))
    .limit(1);
  if (!m) throw new NotFoundError("Matter");
  return m;
}

/** Seed any template items the matter's checklist is missing. Idempotent — safe to call repeatedly. */
export async function seedChecklistForMatter(tx: TenantTx, tenantId: string, matterId: string): Promise<{ created: number; source: string }> {
  const matter = await loadMatter(tx, tenantId, matterId);
  const templates = await tx
    .select()
    .from(documentChecklistTemplates)
    .where(and(eq(documentChecklistTemplates.tenantId, tenantId), eq(documentChecklistTemplates.status, "active")));
  const picked = pickChecklistTemplate(templates, matter.practiceArea);
  if (picked.items.length === 0) return { created: 0, source: picked.source };

  const existing = await tx
    .select({ templateItemKey: documentChecklistItems.templateItemKey })
    .from(documentChecklistItems)
    .where(and(eq(documentChecklistItems.tenantId, tenantId), eq(documentChecklistItems.matterId, matterId), isNull(documentChecklistItems.archivedAt)));
  const todo = missingChecklistItems(picked.items, existing);
  if (todo.length === 0) return { created: 0, source: picked.source };

  let created = 0;
  for (const item of todo) {
    const [row] = await tx
      .insert(documentChecklistItems)
      .values({
        tenantId,
        matterId,
        templateId: picked.templateId,
        templateItemKey: item.key,
        label: item.label,
        description: item.description,
        responsibleParty: item.responsibleParty,
        status: "missing",
      })
      .onConflictDoNothing()
      .returning({ id: documentChecklistItems.id });
    if (row) created++;
  }
  if (created > 0) {
    await audit(tx, {
      tenantId,
      engine: ENGINE,
      action: "checklist.seeded",
      entityType: "matter",
      entityId: matterId,
      matterId,
      payload: { created, source: picked.source, templateId: picked.templateId },
    });
  }
  return { created, source: picked.source };
}

/** Everything on a matter's checklist (staff view — internal and third-party items included). */
export async function listChecklistForStaff(tx: TenantTx, tenantId: string, viewer: StaffViewer, access: AccessContext, matterId: string): Promise<ChecklistItemRow[]> {
  if (!viewer.permissions.includes("documents.read")) throw new DocumentError("You cannot see this checklist.", 403);
  const scope = decideMatter(viewer, matterId, access);
  if (!scope.allowed) throw new DocumentError("You do not have access to this matter.", 403, { reason: scope.reason });
  await seedChecklistForMatter(tx, tenantId, matterId);
  return tx
    .select()
    .from(documentChecklistItems)
    .where(and(eq(documentChecklistItems.tenantId, tenantId), eq(documentChecklistItems.matterId, matterId), isNull(documentChecklistItems.archivedAt)))
    .orderBy(desc(documentChecklistItems.createdAt));
}

export interface ClientChecklistItemView {
  id: string;
  label: string;
  description: string;
  status: string;
  notApplicableReason: string | null;
}

/**
 * A client's own checklist: only responsibleParty = 'client' rows, and only
 * the fields a client may see (no internal AI-check detail, no firm/
 * third-party items — same visibility boundary as c45/c46).
 */
export async function listClientChecklist(tx: TenantTx, tenantId: string, partyId: string, matterId: string): Promise<ClientChecklistItemView[]> {
  const [matter] = await tx.select({ primaryPartyId: matters.primaryPartyId }).from(matters).where(and(eq(matters.tenantId, tenantId), eq(matters.id, matterId))).limit(1);
  if (!matter || matter.primaryPartyId !== partyId) throw new DocumentError("You are not a party to this matter.", 403);
  const rows = await tx
    .select()
    .from(documentChecklistItems)
    .where(
      and(
        eq(documentChecklistItems.tenantId, tenantId),
        eq(documentChecklistItems.matterId, matterId),
        eq(documentChecklistItems.responsibleParty, "client"),
        isNull(documentChecklistItems.archivedAt)
      )
    )
    .orderBy(desc(documentChecklistItems.createdAt));
  return rows.map((r) => ({ id: r.id, label: r.label, description: r.description, status: r.status, notApplicableReason: r.notApplicableReason }));
}

/** A lawyer adds an item by hand (not from the template). */
export async function addChecklistItem(
  tx: TenantTx,
  tenantId: string,
  by: StaffViewer,
  access: AccessContext,
  input: { matterId: string; label: string; description?: string; responsibleParty: ChecklistTemplateItem["responsibleParty"] }
): Promise<ChecklistItemRow> {
  requireWrite(by, "add a checklist item");
  const scope = decideMatter(by, input.matterId, access);
  if (!scope.allowed) throw new DocumentError("You do not have access to this matter.", 403, { reason: scope.reason });
  if (!input.label.trim()) throw new DocumentError("A checklist item needs a label.");
  const [row] = await tx
    .insert(documentChecklistItems)
    .values({
      tenantId,
      matterId: input.matterId,
      templateId: null,
      templateItemKey: null,
      label: input.label.trim(),
      description: input.description?.trim() ?? "",
      responsibleParty: input.responsibleParty,
      status: "missing",
      createdByUserId: by.userId,
    })
    .returning();
  await audit(tx, {
    tenantId,
    engine: ENGINE,
    action: "checklist_item.added",
    entityType: "document_checklist_item",
    entityId: row!.id,
    matterId: input.matterId,
    actor: actorOf(by),
    payload: { label: row!.label, responsibleParty: row!.responsibleParty },
  });
  return row!;
}

async function loadItem(tx: TenantTx, tenantId: string, itemId: string): Promise<ChecklistItemRow> {
  const [row] = await tx.select().from(documentChecklistItems).where(and(eq(documentChecklistItems.tenantId, tenantId), eq(documentChecklistItems.id, itemId))).limit(1);
  if (!row) throw new NotFoundError("Checklist item");
  return row;
}

async function findOpenChecklistTask(tx: TenantTx, tenantId: string, itemId: string): Promise<TaskRow | undefined> {
  const [row] = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.tenantId, tenantId), eq(tasks.kind, CHECKLIST_TASK_KIND), eq(tasks.sourceRef, itemId), eq(tasks.status, "open")))
    .limit(1);
  return row;
}

/** Ask for a missing item. Creates the owning task (client/firm) and, for a client-owed item, raises a 'both' flag. */
export async function requestChecklistItem(
  tx: TenantTx,
  tenantId: string,
  by: StaffViewer,
  access: AccessContext,
  itemId: string,
  input: { due: TaskDue; deadlineCritical?: boolean }
): Promise<ChecklistItemRow> {
  requireWrite(by, "request a checklist item");
  const item = await loadItem(tx, tenantId, itemId);
  const scope = decideMatter(by, item.matterId, access);
  if (!scope.allowed) throw new DocumentError("You do not have access to this matter.", 403, { reason: scope.reason });
  if (item.status !== "missing") throw new DocumentError(`This item is already '${item.status}'.`, 409);

  const matter = await loadMatter(tx, tenantId, item.matterId);
  const now = new Date();
  const owner =
    item.responsibleParty === "client"
      ? ({ type: "client", partyId: matter.primaryPartyId } as const)
      : item.responsibleParty === "firm" && matter.assignedUserId
        ? ({ type: "user", userId: matter.assignedUserId } as const)
        : ({ type: "firm" } as const); // third-party items are chased by firm staff

  const task = await createTask(
    tx,
    {
      tenantId,
      kind: CHECKLIST_TASK_KIND,
      title: `Provide: ${item.label}`,
      description: item.description || null,
      owner,
      visibility: item.responsibleParty === "client" ? "client" : "internal",
      due: input.due,
      deadlineCritical: input.deadlineCritical ?? false,
      matterId: item.matterId,
      sourceCard: "c49",
      sourceRef: item.id,
      engine: ENGINE,
      createdBy: actorOf(by),
    },
    { now }
  );

  const [row] = await tx
    .update(documentChecklistItems)
    .set({ status: "requested", requestedAt: now, taskId: task.id, updatedAt: now })
    .where(eq(documentChecklistItems.id, item.id))
    .returning();
  await audit(tx, {
    tenantId,
    engine: ENGINE,
    action: "checklist_item.requested",
    entityType: "document_checklist_item",
    entityId: item.id,
    matterId: item.matterId,
    actor: actorOf(by),
    payload: { responsibleParty: item.responsibleParty },
  });

  if (item.responsibleParty === "client") {
    await raiseFlag(
      tx,
      {
        tenantId,
        type: "document.checklist_item.requested",
        severity: "info",
        audience: "both",
        title: `Document requested: ${item.label}`,
        summary: `Waiting on the client for '${item.label}' (matter ${item.matterId}).`,
        matterId: item.matterId,
        taskId: task.id,
        recipients: { userIds: matter.assignedUserId ? [matter.assignedUserId] : [], partyIds: [matter.primaryPartyId] },
        // Reuses the existing generic reminder wording (c42/c46/c52/c81) rather
        // than defining a new copy gate for one more "something's waiting" notice.
        clientCopyKey: NOTIFY_COPY_GATES.reminder.key,
        dedupeKey: `document.checklist_item.requested:${item.id}`,
        engine: ENGINE,
        sourceCard: "c49",
      },
      { now }
    );
  }

  return row!;
}

/** The AI's basic upload sanity check (never a legal-sufficiency judgment — only a lawyer accepts an item). Pure. */
export function aiChecklistSanityCheck(input: { sizeBytes: number; detectedMimeType: string | null; pageCount?: number | null }): {
  status: "passed" | "flagged";
  detail: Record<string, unknown>;
} {
  const reasons: string[] = [];
  if (input.sizeBytes < 1024) reasons.push("The file is unusually small for a document.");
  if (input.pageCount !== undefined && input.pageCount !== null && input.pageCount < 1) reasons.push("No pages were detected.");
  if (!input.detectedMimeType) reasons.push("The file type could not be determined.");
  return reasons.length > 0 ? { status: "flagged", detail: { reasons } } : { status: "passed", detail: {} };
}

/** A file was uploaded against this item: mark it received and run the sanity check. */
export async function recordChecklistUpload(
  tx: TenantTx,
  tenantId: string,
  by: Actor,
  itemId: string,
  input: { groupId: string; sizeBytes: number; detectedMimeType: string | null; pageCount?: number | null }
): Promise<ChecklistItemRow> {
  const item = await loadItem(tx, tenantId, itemId);
  if (item.status === "accepted" || item.status === "not_applicable") {
    throw new DocumentError(`This item is already '${item.status}' and cannot take a new upload through the checklist.`, 409);
  }
  const now = new Date();
  const check = aiChecklistSanityCheck(input);
  const [row] = await tx
    .update(documentChecklistItems)
    .set({ status: "received", receivedAt: now, groupId: input.groupId, aiCheckStatus: check.status, aiCheckDetail: check.detail, updatedAt: now })
    .where(eq(documentChecklistItems.id, item.id))
    .returning();
  await audit(tx, {
    tenantId,
    engine: ENGINE,
    action: "checklist_item.received",
    entityType: "document_checklist_item",
    entityId: item.id,
    matterId: item.matterId,
    actor: by,
    payload: { groupId: input.groupId, aiCheckStatus: check.status },
  });
  const openTask = await findOpenChecklistTask(tx, tenantId, item.id);
  if (openTask) {
    await completeTask(tx, { tenantId, taskId: openTask.id, by, reason: "Document received.", engine: ENGINE });
  }
  return row!;
}

/** Mark an item not applicable to this matter (a required-and-logged reason — c49). */
export async function markChecklistNotApplicable(
  tx: TenantTx,
  tenantId: string,
  by: StaffViewer,
  access: AccessContext,
  itemId: string,
  reason: string
): Promise<ChecklistItemRow> {
  requireWrite(by, "mark a checklist item not applicable");
  const item = await loadItem(tx, tenantId, itemId);
  const scope = decideMatter(by, item.matterId, access);
  if (!scope.allowed) throw new DocumentError("You do not have access to this matter.", 403, { reason: scope.reason });
  if (!reason.trim()) throw new DocumentError("A reason is required.");
  const now = new Date();
  const [row] = await tx
    .update(documentChecklistItems)
    .set({ status: "not_applicable", notApplicableReason: reason.trim(), updatedAt: now })
    .where(eq(documentChecklistItems.id, item.id))
    .returning();
  await audit(tx, {
    tenantId,
    engine: ENGINE,
    action: "checklist_item.not_applicable",
    entityType: "document_checklist_item",
    entityId: item.id,
    matterId: item.matterId,
    actor: actorOf(by),
    reason: reason.trim(),
  });
  const openTask = await findOpenChecklistTask(tx, tenantId, item.id);
  if (openTask) {
    await cancelTask(tx, { tenantId, taskId: openTask.id, by: actorOf(by), reason: `Marked not applicable: ${reason.trim()}`, engine: ENGINE });
  }
  return row!;
}

/** An attorney accepts a received item (documents.approve — never just "received"). */
export async function acceptChecklistItem(tx: TenantTx, tenantId: string, by: StaffViewer, access: AccessContext, itemId: string): Promise<ChecklistItemRow> {
  if (!by.permissions.includes("documents.approve")) throw new DocumentError("Only an attorney can accept a checklist item.", 403);
  const item = await loadItem(tx, tenantId, itemId);
  const scope = decideMatter(by, item.matterId, access);
  if (!scope.allowed) throw new DocumentError("You do not have access to this matter.", 403, { reason: scope.reason });
  if (item.status !== "received") throw new DocumentError(`Only a received item can be accepted (this one is '${item.status}').`, 409);
  const now = new Date();
  const [row] = await tx
    .update(documentChecklistItems)
    .set({ status: "accepted", acceptedAt: now, acceptedByUserId: by.userId, updatedAt: now })
    .where(eq(documentChecklistItems.id, item.id))
    .returning();
  await audit(tx, {
    tenantId,
    engine: ENGINE,
    action: "checklist_item.accepted",
    entityType: "document_checklist_item",
    entityId: item.id,
    matterId: item.matterId,
    actor: actorOf(by),
  });
  return row!;
}

/** A lawyer removes an item added by hand. Archived, never deleted — still a logged, reasoned change (c49). */
export async function archiveChecklistItem(tx: TenantTx, tenantId: string, by: StaffViewer, access: AccessContext, itemId: string, reason: string): Promise<ChecklistItemRow> {
  requireWrite(by, "remove a checklist item");
  const item = await loadItem(tx, tenantId, itemId);
  const scope = decideMatter(by, item.matterId, access);
  if (!scope.allowed) throw new DocumentError("You do not have access to this matter.", 403, { reason: scope.reason });
  if (!reason.trim()) throw new DocumentError("A reason is required to remove a checklist item.");
  const now = new Date();
  const [row] = await tx.update(documentChecklistItems).set({ archivedAt: now, updatedAt: now }).where(eq(documentChecklistItems.id, item.id)).returning();
  await audit(tx, {
    tenantId,
    engine: ENGINE,
    action: "checklist_item.archived",
    entityType: "document_checklist_item",
    entityId: item.id,
    matterId: item.matterId,
    actor: actorOf(by),
    reason: reason.trim(),
  });
  const openTask = await findOpenChecklistTask(tx, tenantId, item.id);
  if (openTask) {
    await cancelTask(tx, { tenantId, taskId: openTask.id, by: actorOf(by), reason: `Checklist item removed: ${reason.trim()}`, engine: ENGINE });
  }
  return row!;
}
