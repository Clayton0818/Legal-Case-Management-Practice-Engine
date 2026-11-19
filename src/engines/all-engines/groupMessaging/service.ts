// c124 — group messaging for matters with more than one client.
//
// The flow:
//  1. A lawyer marks the matter as a joint representation (their decision,
//     recorded; the software never decides it).
//  2. Staff record each client's consent to information being shared with the
//     other clients, using the attorney-reviewed consent wording (shown as a
//     visible placeholder until approved; the consent row stores whether it was).
//  3. Once every current client has consented, staff can post to the group
//     thread. Each client gets an in-app notice and an email notice with no
//     case details (held until the email vendor and the wording are approved,
//     like every other client email). The message itself is read in the portal.
// Every step is audited (c6). Withdrawing a consent or ending the joint
// representation closes the group thread immediately.

import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { matterParties, matters, parties, users } from "@/db/schema";
import { clientSharingConsents, jointRepresentations, matterGroupMessages } from "@/db/tables/all-engines";
import type { TenantTx } from "@/tenancy/withTenant";
import { audit } from "@/core/audit";
import { enqueueNotification } from "@/core/notify";
import { assertCan, can, type MatterRef } from "@/core/permissions";
import { gateStatus, legalCopyStatus } from "@/compliance/approvals";
import { AllEnginesError, ENGINE } from "../common/errors";
import { GROUP_MESSAGING_GATES } from "../gates";
import { loadMatterRef, type StaffContext } from "../permissions/service";
import { canDecideJointRepresentation, checkMessageBody, deriveGroupState, type ClientOnMatter, type GroupState } from "./rules";

async function requireMatter(tx: TenantTx, tenantId: string, staff: StaffContext, matterId: string, right: "matters.view" | "matters.edit"): Promise<MatterRef> {
  const ref = await loadMatterRef(tx, tenantId, matterId);
  if (!ref) throw new AllEnginesError("No such matter.", 404);
  assertCan(staff.actor, right, { type: "matter", ...ref }, staff.config);
  return ref;
}

function requireUser(staff: StaffContext): string {
  if (!staff.userId) throw new AllEnginesError("This action is recorded against a person; sign in as a staff member.", 403);
  return staff.userId;
}

async function currentClients(tx: TenantTx, tenantId: string, matterId: string): Promise<ClientOnMatter[]> {
  return tx
    .select({ partyId: matterParties.partyId, fullName: parties.fullName, isAdverse: matterParties.isAdverse })
    .from(matterParties)
    .innerJoin(parties, and(eq(parties.id, matterParties.partyId), eq(parties.tenantId, matterParties.tenantId)))
    .where(and(eq(matterParties.tenantId, tenantId), eq(matterParties.matterId, matterId), eq(matterParties.role, "client"), isNull(matterParties.endedAt)))
    .orderBy(asc(parties.fullName));
}

async function activeJoint(tx: TenantTx, tenantId: string, matterId: string) {
  const [row] = await tx
    .select()
    .from(jointRepresentations)
    .where(and(eq(jointRepresentations.tenantId, tenantId), eq(jointRepresentations.matterId, matterId), isNull(jointRepresentations.endedAt)))
    .limit(1);
  return row ?? null;
}

async function activeConsents(tx: TenantTx, tenantId: string, matterId: string) {
  return tx
    .select()
    .from(clientSharingConsents)
    .where(and(eq(clientSharingConsents.tenantId, tenantId), eq(clientSharingConsents.matterId, matterId), isNull(clientSharingConsents.withdrawnAt)));
}

async function stateFor(tx: TenantTx, tenantId: string, matterId: string): Promise<{ state: GroupState; clients: ClientOnMatter[] }> {
  const [joint, clients, consents] = await Promise.all([activeJoint(tx, tenantId, matterId), currentClients(tx, tenantId, matterId), activeConsents(tx, tenantId, matterId)]);
  return { state: deriveGroupState({ jointActive: joint !== null, clients, consents }), clients };
}

export interface GroupView {
  matterId: string;
  clientName: string | null;
  joint: { markedAt: Date; markedByName: string | null; note: string | null } | null;
  clients: Array<ClientOnMatter & { consentGivenAt: Date | null; consentWordingApproved: boolean | null }>;
  state: GroupState;
  consentWording: { text: string; approved: boolean };
  messages: Array<{ id: string; authorType: string; authorName: string | null; body: string; recipientCount: number; createdAt: Date }>;
  /** What the viewer may do. */
  can: { decideJoint: boolean; edit: boolean };
}

/** Everything the group-messaging page shows for one matter (staff view). */
export async function loadGroupView(tx: TenantTx, tenantId: string, staff: StaffContext, matterId: string): Promise<GroupView> {
  const ref = await requireMatter(tx, tenantId, staff, matterId, "matters.view");
  const [joint, clients, consents] = await Promise.all([activeJoint(tx, tenantId, matterId), currentClients(tx, tenantId, matterId), activeConsents(tx, tenantId, matterId)]);
  const [header] = await tx
    .select({ clientName: parties.fullName })
    .from(matters)
    .innerJoin(parties, and(eq(parties.id, matters.primaryPartyId), eq(parties.tenantId, matters.tenantId)))
    .where(and(eq(matters.tenantId, tenantId), eq(matters.id, matterId)))
    .limit(1);
  const [marker] = joint ? await tx.select({ name: users.displayName }).from(users).where(and(eq(users.tenantId, tenantId), eq(users.id, joint.markedByUserId))).limit(1) : [];
  const messages = await tx
    .select({
      id: matterGroupMessages.id,
      authorType: matterGroupMessages.authorType,
      authorUserName: users.displayName,
      authorPartyName: parties.fullName,
      body: matterGroupMessages.body,
      recipientPartyIds: matterGroupMessages.recipientPartyIds,
      createdAt: matterGroupMessages.createdAt,
    })
    .from(matterGroupMessages)
    .leftJoin(users, and(eq(users.id, matterGroupMessages.authorUserId), eq(users.tenantId, matterGroupMessages.tenantId)))
    .leftJoin(parties, and(eq(parties.id, matterGroupMessages.authorPartyId), eq(parties.tenantId, matterGroupMessages.tenantId)))
    .where(and(eq(matterGroupMessages.tenantId, tenantId), eq(matterGroupMessages.matterId, matterId)))
    .orderBy(desc(matterGroupMessages.createdAt))
    .limit(100);
  const byParty = new Map(consents.map((c) => [c.partyId, c]));
  const wording = legalCopyStatus(GROUP_MESSAGING_GATES.consentWording.key);
  const resource = { type: "matter" as const, ...ref };
  return {
    matterId,
    clientName: header?.clientName ?? null,
    joint: joint ? { markedAt: joint.markedAt, markedByName: marker?.name ?? null, note: joint.note } : null,
    clients: clients.map((c) => ({ ...c, consentGivenAt: byParty.get(c.partyId)?.givenAt ?? null, consentWordingApproved: byParty.get(c.partyId)?.consentWordingApproved ?? null })),
    state: deriveGroupState({ jointActive: joint !== null, clients, consents }),
    consentWording: { text: wording.text, approved: wording.approved },
    messages: messages.map((m) => ({
      id: m.id,
      authorType: m.authorType,
      authorName: m.authorType === "staff" ? m.authorUserName : m.authorPartyName,
      body: m.body,
      recipientCount: m.recipientPartyIds.length,
      createdAt: m.createdAt,
    })),
    can: {
      decideJoint: canDecideJointRepresentation(staff.roles) && can(staff.actor, "matters.edit", resource, staff.config),
      edit: can(staff.actor, "matters.edit", resource, staff.config),
    },
  };
}

/** A lawyer records that the matter is a joint representation. */
export async function markJointRepresentation(tx: TenantTx, input: { tenantId: string; staff: StaffContext; matterId: string; note?: string | null; now?: Date }) {
  const { tenantId, staff, matterId } = input;
  await requireMatter(tx, tenantId, staff, matterId, "matters.edit");
  if (!canDecideJointRepresentation(staff.roles)) throw new AllEnginesError("Only a lawyer can mark a matter as a joint representation.", 403);
  const userId = requireUser(staff);
  if (await activeJoint(tx, tenantId, matterId)) throw new AllEnginesError("This matter is already marked as a joint representation.", 409);
  const clients = await currentClients(tx, tenantId, matterId);
  if (clients.length < 2) throw new AllEnginesError("A joint representation needs at least two clients on the matter.", 409);
  const [row] = await tx
    .insert(jointRepresentations)
    .values({ tenantId, matterId, markedByUserId: userId, note: input.note?.trim() || null, markedAt: input.now ?? new Date() })
    .returning({ id: jointRepresentations.id });
  await audit(tx, { tenantId, engine: ENGINE, action: "group_messaging.joint_marked", entityType: "joint_representation", entityId: row!.id, matterId, actor: staff.auditActor, payload: { clientCount: clients.length } });
  return { ok: true };
}

/** A lawyer ends the joint representation; the group thread closes at once. */
export async function endJointRepresentation(tx: TenantTx, input: { tenantId: string; staff: StaffContext; matterId: string; reason: string; now?: Date }) {
  const { tenantId, staff, matterId } = input;
  await requireMatter(tx, tenantId, staff, matterId, "matters.edit");
  if (!canDecideJointRepresentation(staff.roles)) throw new AllEnginesError("Only a lawyer can end a joint representation.", 403);
  const userId = requireUser(staff);
  if (!input.reason.trim()) throw new AllEnginesError("A reason is required.");
  const joint = await activeJoint(tx, tenantId, matterId);
  if (!joint) throw new AllEnginesError("This matter isn't marked as a joint representation.", 409);
  await tx
    .update(jointRepresentations)
    .set({ endedAt: input.now ?? new Date(), endedByUserId: userId, endReason: input.reason.trim() })
    .where(and(eq(jointRepresentations.tenantId, tenantId), eq(jointRepresentations.id, joint.id)));
  await audit(tx, { tenantId, engine: ENGINE, action: "group_messaging.joint_ended", entityType: "joint_representation", entityId: joint.id, matterId, actor: staff.auditActor, reason: input.reason.trim() });
  return { ok: true };
}

/** Staff record one client's consent to sharing, with the consent wording version used. */
export async function recordSharingConsent(tx: TenantTx, input: { tenantId: string; staff: StaffContext; matterId: string; partyId: string; now?: Date }) {
  const { tenantId, staff, matterId, partyId } = input;
  await requireMatter(tx, tenantId, staff, matterId, "matters.edit");
  const userId = requireUser(staff);
  if (!(await activeJoint(tx, tenantId, matterId))) throw new AllEnginesError("A lawyer has to mark the matter as a joint representation first.", 409);
  const clients = await currentClients(tx, tenantId, matterId);
  if (!clients.some((c) => c.partyId === partyId)) throw new AllEnginesError("Consent can only be recorded for a current client on this matter.", 422);
  const existing = (await activeConsents(tx, tenantId, matterId)).find((c) => c.partyId === partyId);
  if (existing) throw new AllEnginesError("This client's consent is already recorded.", 409);
  const status = gateStatus(GROUP_MESSAGING_GATES.consentWording.key);
  const [row] = await tx
    .insert(clientSharingConsents)
    .values({
      tenantId,
      matterId,
      partyId,
      consentGateKey: status.gate.key,
      consentDraftHash: status.gate.draftHash,
      consentWordingApproved: status.approved,
      recordedByUserId: userId,
      givenAt: input.now ?? new Date(),
    })
    .returning({ id: clientSharingConsents.id });
  await audit(tx, {
    tenantId,
    engine: ENGINE,
    action: "group_messaging.consent_recorded",
    entityType: "client_sharing_consent",
    entityId: row!.id,
    matterId,
    actor: staff.auditActor,
    payload: { partyId, wordingApproved: status.approved, draftHash: status.gate.draftHash },
  });
  return { ok: true, wordingApproved: status.approved };
}

/** A client withdraws consent (recorded by staff); the group thread closes at once. */
export async function withdrawSharingConsent(tx: TenantTx, input: { tenantId: string; staff: StaffContext; matterId: string; partyId: string; reason?: string | null; now?: Date }) {
  const { tenantId, staff, matterId, partyId } = input;
  await requireMatter(tx, tenantId, staff, matterId, "matters.edit");
  const userId = requireUser(staff);
  const existing = (await activeConsents(tx, tenantId, matterId)).find((c) => c.partyId === partyId);
  if (!existing) throw new AllEnginesError("This client has no active consent to withdraw.", 409);
  await tx
    .update(clientSharingConsents)
    .set({ withdrawnAt: input.now ?? new Date(), withdrawnRecordedByUserId: userId, withdrawReason: input.reason?.trim() || null })
    .where(and(eq(clientSharingConsents.tenantId, tenantId), eq(clientSharingConsents.id, existing.id)));
  await audit(tx, { tenantId, engine: ENGINE, action: "group_messaging.consent_withdrawn", entityType: "client_sharing_consent", entityId: existing.id, matterId, actor: staff.auditActor, payload: { partyId } });
  return { ok: true };
}

async function notifyRecipients(tx: TenantTx, tenantId: string, matterId: string, messageId: string, recipients: readonly string[]): Promise<void> {
  for (const partyId of recipients) {
    for (const channel of ["in_app", "email"] as const) {
      await enqueueNotification(tx, {
        tenantId,
        channel,
        recipient: { type: "party", partyId },
        templateKey: GROUP_MESSAGING_GATES.newMessageNotice.key,
        payload: {},
        matterId,
        sensitive: true,
        dedupeKey: `group-message:${messageId}:${partyId}:${channel}`,
      });
    }
  }
}

/** Staff post to the group thread. Refused unless the thread is available; goes to exactly the current consenting clients. */
export async function postGroupMessage(tx: TenantTx, input: { tenantId: string; staff: StaffContext; matterId: string; body: string; now?: Date }) {
  const { tenantId, staff, matterId } = input;
  await requireMatter(tx, tenantId, staff, matterId, "matters.edit");
  const userId = requireUser(staff);
  const checked = checkMessageBody(input.body);
  if (!checked.ok) throw new AllEnginesError(checked.error);
  const { state } = await stateFor(tx, tenantId, matterId);
  if (!state.available) throw new AllEnginesError("The group thread isn't available.", 409, state.reasons);
  const [row] = await tx
    .insert(matterGroupMessages)
    .values({ tenantId, matterId, authorType: "staff", authorUserId: userId, body: checked.body, recipientPartyIds: state.recipients, createdAt: input.now ?? new Date() })
    .returning({ id: matterGroupMessages.id });
  await notifyRecipients(tx, tenantId, matterId, row!.id, state.recipients);
  await audit(tx, {
    tenantId,
    engine: ENGINE,
    action: "group_messaging.message_posted",
    entityType: "matter_group_message",
    entityId: row!.id,
    matterId,
    actor: staff.auditActor,
    payload: { recipientCount: state.recipients.length },
  });
  return { ok: true, messageId: row!.id, recipientCount: state.recipients.length };
}

/**
 * A client's reply to the group thread, for the client portal to call once it
 * has a group view (follow-up). The client must be a current, consenting
 * client and the thread must be available; the reply goes to the other
 * clients, and the firm sees it on the matter's thread.
 */
export async function postClientGroupReply(tx: TenantTx, input: { tenantId: string; matterId: string; partyId: string; body: string; now?: Date }) {
  const { tenantId, matterId, partyId } = input;
  const checked = checkMessageBody(input.body);
  if (!checked.ok) throw new AllEnginesError(checked.error);
  const { state } = await stateFor(tx, tenantId, matterId);
  if (!state.available) throw new AllEnginesError("The group thread isn't available.", 409, state.reasons);
  if (!state.recipients.includes(partyId)) throw new AllEnginesError("Only a client in the group can reply to it.", 403);
  const others = state.recipients.filter((p) => p !== partyId);
  const [row] = await tx
    .insert(matterGroupMessages)
    .values({ tenantId, matterId, authorType: "client", authorPartyId: partyId, body: checked.body, recipientPartyIds: others, createdAt: input.now ?? new Date() })
    .returning({ id: matterGroupMessages.id });
  await notifyRecipients(tx, tenantId, matterId, row!.id, others);
  await audit(tx, {
    tenantId,
    engine: ENGINE,
    action: "group_messaging.client_reply",
    entityType: "matter_group_message",
    entityId: row!.id,
    matterId,
    actor: { type: "client", partyId },
    payload: { recipientCount: others.length },
  });
  return { ok: true, messageId: row!.id };
}

export interface GroupMatterChoice {
  matterId: string;
  clientName: string;
  clientCount: number;
}

/** Matters with two or more current clients that the person may open (the page's picker). */
export async function listGroupMatters(tx: TenantTx, tenantId: string, staff: StaffContext, limit = 50): Promise<GroupMatterChoice[]> {
  const clientRows = await tx
    .select({ matterId: matterParties.matterId })
    .from(matterParties)
    .where(and(eq(matterParties.tenantId, tenantId), eq(matterParties.role, "client"), isNull(matterParties.endedAt)));
  const counts = new Map<string, number>();
  for (const r of clientRows) counts.set(r.matterId, (counts.get(r.matterId) ?? 0) + 1);
  const ids = [...counts.entries()].filter(([, n]) => n >= 2).map(([id]) => id);
  if (ids.length === 0) return [];
  const rows = await tx
    .select({ matterId: matters.id, clientName: parties.fullName })
    .from(matters)
    .innerJoin(parties, and(eq(parties.id, matters.primaryPartyId), eq(parties.tenantId, matters.tenantId)))
    .where(and(eq(matters.tenantId, tenantId), inArray(matters.id, ids)))
    .orderBy(desc(matters.openedAt));
  const out: GroupMatterChoice[] = [];
  for (const r of rows) {
    if (out.length >= limit) break;
    const ref = await loadMatterRef(tx, tenantId, r.matterId);
    if (ref && can(staff.actor, "matters.view", { type: "matter", ...ref }, staff.config)) out.push({ ...r, clientCount: counts.get(r.matterId) ?? 0 });
  }
  return out;
}
