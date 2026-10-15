// c40 — Document engine · the AI asks staff whether a document has been
// sent to the client outside the platform (mail, hand delivery, a separate
// email, …). "Sent through the platform itself" (c4's e-signature/delivery
// flow) marks a group 'sent' / 'platform' automatically from that flow and
// never needs asking.
//
// The question is one more thing with a due date, so it rides the shared
// task mechanism (core/tasks.ts) instead of its own timer: asking opens a
// task; "not yet" pushes the SAME task's due date forward (re-asks on a
// cadence) instead of creating a new one each time; any other answer closes
// it. Overdue flagging for that task is the calendar/alerts engine's job
// (c44/c45/c46) — this file only ever creates/advances/completes it.

import { and, eq } from "drizzle-orm";
import { documentGroups } from "@/db/tables/document";
import { tasks } from "@/db/tables/foundation";
import { audit, changeTaskDue, completeTask, createTask, type TaskRow } from "@/core";
import type { TenantTx } from "@/tenancy/withTenant";
import { DocumentError, NotFoundError } from "../errors";
import { ENGINE } from "../settings";
import { decideMatter, type AccessContext, type StaffViewer } from "../access/policy";
import { actorOf } from "../access/service";

export const DELIVERY_STATUSES = ["sent", "not_yet", "not_needed"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const DELIVERY_METHODS = ["platform", "email", "mail", "hand_delivery", "other"] as const;
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number];

/** Task kind for a delivery question (core/tasks.ts); the group id is the task's sourceRef. */
export const DELIVERY_TASK_KIND = "document.delivery_confirmation";

/** How long until a "not yet sent" answer is asked again. */
export const DELIVERY_REASK_HOURS = 24;

/** Pure: when the delivery question should be asked again after a "not yet" answer. */
export function nextDeliveryReaskAt(now: Date, hours: number = DELIVERY_REASK_HOURS): Date {
  return new Date(now.getTime() + hours * 3_600_000);
}

interface DeliveryCtx {
  tenantId: string;
  viewer: StaffViewer;
  access: AccessContext;
  now?: Date;
}

function requireWrite(viewer: StaffViewer, what: string): void {
  if (!viewer.permissions.includes("documents.write")) {
    throw new DocumentError(`You cannot ${what}.`, 403);
  }
}

async function loadGroup(tx: TenantTx, tenantId: string, groupId: string) {
  const [g] = await tx
    .select()
    .from(documentGroups)
    .where(and(eq(documentGroups.tenantId, tenantId), eq(documentGroups.id, groupId)))
    .limit(1);
  if (!g) throw new NotFoundError("Document");
  return g;
}

function requireScope(viewer: StaffViewer, matterId: string, access: AccessContext): void {
  const scope = decideMatter(viewer, matterId, access);
  if (!scope.allowed) throw new DocumentError("You do not have access to this matter.", 403, { reason: scope.reason });
}

/** The open delivery-confirmation task for this file, if any. */
async function findOpenDeliveryTask(tx: TenantTx, tenantId: string, groupId: string): Promise<TaskRow | undefined> {
  const [row] = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.tenantId, tenantId), eq(tasks.kind, DELIVERY_TASK_KIND), eq(tasks.sourceRef, groupId), eq(tasks.status, "open")))
    .limit(1);
  return row;
}

export type AskAboutDeliveryResult = { asked: true; taskId: string } | { asked: false; reason: string; taskId?: string };

/**
 * Ask staff whether this file has been sent. A no-op (not a second task)
 * when delivery is already settled or a question is already open.
 */
export async function askAboutDelivery(
  tx: TenantTx,
  ctx: DeliveryCtx,
  input: { groupId: string; dueInHours?: number }
): Promise<AskAboutDeliveryResult> {
  requireWrite(ctx.viewer, "ask about delivery");
  const group = await loadGroup(tx, ctx.tenantId, input.groupId);
  requireScope(ctx.viewer, group.matterId, ctx.access);

  if (group.deliveryStatus !== "not_yet") {
    return { asked: false, reason: `Delivery is already recorded as '${group.deliveryStatus}'.` };
  }
  const open = await findOpenDeliveryTask(tx, ctx.tenantId, group.id);
  if (open) return { asked: false, reason: "A delivery question is already open for this file.", taskId: open.id };

  const task = await createTask(
    tx,
    {
      tenantId: ctx.tenantId,
      kind: DELIVERY_TASK_KIND,
      title: `Confirm delivery: has "${group.title}" been sent to the client?`,
      owner: { type: "firm" },
      due: { hours: input.dueInHours ?? DELIVERY_REASK_HOURS, clock: "business" },
      matterId: group.matterId,
      sourceCard: "c40",
      sourceRef: group.id,
      engine: ENGINE,
      createdBy: actorOf(ctx.viewer),
    },
    { now: ctx.now }
  );
  return { asked: true, taskId: task.id };
}

export interface RecordDeliveryAnswerInput {
  groupId: string;
  status: DeliveryStatus;
  /** Required when status is 'sent'. Ignored otherwise. */
  method?: DeliveryMethod | null;
}

export type RecordDeliveryAnswerResult = { groupId: string; status: DeliveryStatus; taskReopenedUntil?: Date };

/**
 * Record the staff answer. 'sent' / 'not_needed' settle the question and
 * close any open task; 'not_yet' leaves the group's status alone and pushes
 * the same task's due date forward instead of creating a new one.
 */
export async function recordDeliveryAnswer(
  tx: TenantTx,
  ctx: DeliveryCtx,
  input: RecordDeliveryAnswerInput
): Promise<RecordDeliveryAnswerResult> {
  requireWrite(ctx.viewer, "record a delivery answer");
  if (!(DELIVERY_STATUSES as readonly string[]).includes(input.status)) {
    throw new DocumentError(`Unknown delivery status '${input.status}'.`);
  }
  if (input.status === "sent") {
    if (!input.method) throw new DocumentError("How the document was sent is required when marking it delivered.");
    if (!(DELIVERY_METHODS as readonly string[]).includes(input.method)) throw new DocumentError(`Unknown delivery method '${input.method}'.`);
  }
  const group = await loadGroup(tx, ctx.tenantId, input.groupId);
  requireScope(ctx.viewer, group.matterId, ctx.access);
  const now = ctx.now ?? new Date();
  const openTask = await findOpenDeliveryTask(tx, ctx.tenantId, group.id);
  const by = actorOf(ctx.viewer);

  if (input.status === "not_yet") {
    let taskReopenedUntil: Date | undefined;
    if (openTask) {
      const next = nextDeliveryReaskAt(now);
      await changeTaskDue(tx, {
        tenantId: ctx.tenantId,
        taskId: openTask.id,
        dueAt: next,
        by,
        reason: "Staff said the document has not been sent yet; asking again later.",
        engine: ENGINE,
      });
      taskReopenedUntil = next;
    }
    await audit(tx, {
      tenantId: ctx.tenantId,
      engine: ENGINE,
      action: "document.delivery.still_pending",
      entityType: "document_group",
      entityId: group.id,
      matterId: group.matterId,
      actor: by,
    });
    return { groupId: group.id, status: "not_yet", taskReopenedUntil };
  }

  await tx
    .update(documentGroups)
    .set({
      deliveryStatus: input.status,
      deliveryMethod: input.status === "sent" ? (input.method as DeliveryMethod) : null,
      deliveryConfirmedAt: now,
      deliveryConfirmedByUserId: ctx.viewer.userId,
      updatedAt: now,
    })
    .where(eq(documentGroups.id, group.id));
  await audit(tx, {
    tenantId: ctx.tenantId,
    engine: ENGINE,
    action: "document.delivery.recorded",
    entityType: "document_group",
    entityId: group.id,
    matterId: group.matterId,
    actor: by,
    payload: { status: input.status, method: input.method ?? null },
  });
  if (openTask) {
    await completeTask(tx, {
      tenantId: ctx.tenantId,
      taskId: openTask.id,
      by,
      reason: `Delivery recorded as '${input.status}'.`,
      engine: ENGINE,
    });
  }
  return { groupId: group.id, status: input.status };
}
