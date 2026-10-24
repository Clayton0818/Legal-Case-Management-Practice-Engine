// Carries out the bounced-email plan (./emailBouncePlan.ts) for one outbox
// row: loads who to alert, opens the follow-up task (client bounces only)
// and raises the internal flag. Called by the Postmark webhook
// (src/app/api/webhooks/postmark/route.ts) right after recordDeliveryStatus()
// marks an email row 'bounced', in the same firm-scoped transaction.
//
// Webhooks are retried, and one client can bounce several emails: an open
// flag with the same dedupe key means "already being handled", so nothing
// new is created (checked BEFORE the task, so retries never pile up tasks).
// Completing the task resolves its flag through the normal task path
// (resolveFlagsForTask in ./tasks.ts).

import { and, eq, isNull } from "drizzle-orm";
import { matters, parties, users } from "@/db/schema";
import { flags } from "@/db/tables/foundation";
import type { TenantTx } from "@/tenancy/withTenant";
import type { NotificationRow } from "./notify";
import { raiseFlag } from "./flags";
import { createTask } from "./tasks";
import { clientBounceDedupeKey, planEmailBounce, staffBounceDedupeKey, type BounceFacts, type BouncePlan } from "./emailBouncePlan";

export type EmailBounceOutcome =
  | { kind: "none"; reason: string }
  | { kind: "client" | "staff"; flagId: string; taskId: string | null };

type BounceRow = Pick<
  NotificationRow,
  "id" | "tenantId" | "status" | "channel" | "recipientType" | "recipientUserId" | "recipientPartyId" | "matterId" | "urgent" | "lastError"
>;

async function activeUserIdsWithRole(tx: TenantTx, tenantId: string, role: "firm_admin" | "intake_staff"): Promise<string[]> {
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.role, role), eq(users.status, "active")));
  return rows.map((r) => r.id);
}

async function openFlagExists(tx: TenantTx, tenantId: string, dedupeKey: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: flags.id })
    .from(flags)
    .where(and(eq(flags.tenantId, tenantId), eq(flags.dedupeKey, dedupeKey), isNull(flags.resolvedAt)))
    .limit(1);
  return Boolean(row);
}

async function assignedActiveLawyer(tx: TenantTx, tenantId: string, matterId: string | null): Promise<string | null> {
  if (!matterId) return null;
  const [row] = await tx
    .select({ userId: users.id })
    .from(matters)
    .innerJoin(users, and(eq(users.id, matters.assignedUserId), eq(users.tenantId, matters.tenantId)))
    .where(and(eq(matters.tenantId, tenantId), eq(matters.id, matterId), eq(users.status, "active")))
    .limit(1);
  return row?.userId ?? null;
}

/** Load the facts the planner needs for one bounced email row. */
async function loadBounceFacts(tx: TenantTx, row: BounceRow): Promise<BounceFacts> {
  const tenantId = row.tenantId;
  const adminIds = await activeUserIdsWithRole(tx, tenantId, "firm_admin");
  const base = {
    notificationId: row.id,
    matterId: row.matterId,
    urgent: row.urgent,
    detail: row.lastError,
    adminIds,
  };

  if (row.recipientType === "party") {
    let dv = false;
    if (row.recipientPartyId) {
      const [p] = await tx
        .select({ dv: parties.dvSensitive })
        .from(parties)
        .where(and(eq(parties.tenantId, tenantId), eq(parties.id, row.recipientPartyId)))
        .limit(1);
      dv = p?.dv ?? false;
    }
    return {
      ...base,
      recipientType: "party",
      partyId: row.recipientPartyId,
      partyDvSensitive: dv,
      assignedLawyerId: await assignedActiveLawyer(tx, tenantId, row.matterId),
      intakeStaffIds: await activeUserIdsWithRole(tx, tenantId, "intake_staff"),
      bouncedUserId: null,
      bouncedUserName: null,
    };
  }

  let name: string | null = null;
  if (row.recipientUserId) {
    const [u] = await tx
      .select({ name: users.displayName })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.id, row.recipientUserId)))
      .limit(1);
    name = u?.name ?? null;
  }
  return {
    ...base,
    recipientType: "user",
    partyId: null,
    partyDvSensitive: false,
    assignedLawyerId: null,
    intakeStaffIds: [],
    bouncedUserId: row.recipientUserId,
    bouncedUserName: name,
  };
}

/**
 * Alert the right people about one bounced email. Does nothing for rows that
 * are not bounced emails, or while an alert for the same client / staff
 * member is still open.
 */
export async function handleEmailBounce(tx: TenantTx, row: BounceRow, opts: { now?: Date } = {}): Promise<EmailBounceOutcome> {
  if (row.channel !== "email" || row.status !== "bounced") return { kind: "none", reason: "Not a bounced email." };

  const dedupeKey =
    row.recipientType === "party"
      ? row.recipientPartyId && clientBounceDedupeKey(row.recipientPartyId)
      : row.recipientUserId && staffBounceDedupeKey(row.recipientUserId);
  if (!dedupeKey) return { kind: "none", reason: "Bounced row has no recipient id." };
  if (await openFlagExists(tx, row.tenantId, dedupeKey)) {
    return { kind: "none", reason: "An alert for this recipient is already open." };
  }

  const plan: BouncePlan = planEmailBounce(await loadBounceFacts(tx, row));
  if (plan.kind === "none") return plan;

  let taskId: string | null = null;
  if (plan.kind === "client") {
    const task = await createTask(
      tx,
      {
        tenantId: row.tenantId,
        kind: plan.task.kind,
        title: plan.task.title,
        owner: plan.task.owner,
        due: { hours: plan.task.dueBusinessHours, clock: "business" },
        matterId: row.matterId,
        sourceCard: "c51",
        sourceRef: plan.task.sourceRef,
        metadata: { notificationId: row.id },
        engine: "core",
      },
      { now: opts.now }
    );
    taskId = task.id;
  }

  const { flag } = await raiseFlag(
    tx,
    {
      tenantId: row.tenantId,
      type: plan.flag.type,
      severity: plan.flag.severity,
      audience: "internal",
      title: plan.flag.title,
      summary: plan.flag.summary,
      matterId: row.matterId,
      taskId,
      recipients: { userIds: plan.flag.recipientUserIds },
      dedupeKey: plan.flag.dedupeKey,
      urgent: plan.flag.urgent,
      sourceCard: "c51",
      engine: "core",
    },
    { now: opts.now }
  );
  return { kind: plan.kind, flagId: flag.id, taskId };
}
