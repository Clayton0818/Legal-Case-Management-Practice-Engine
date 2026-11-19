// c122 — services behind the staff console's "New intake" form and the
// guided intake page. Thin on purpose: creating the intake, the disclosures,
// the conflict-check names and the case details all go through the existing
// channel services (c65), so every rule (staff role, disclosure proof,
// case-details lock, conflict check before details) is enforced in one
// place. What this file adds is the duplicate lookup before an intake is
// created, and one read model for the guided page.

import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { intakeSessions, parties } from "@/db/schema";
import { intakeSessionState } from "@/db/tables/intake";
import type { TenantTx } from "@/tenancy/withTenant";
import { normalizeName } from "@/core/contacts";
import { requireStaff, STAFF_ROLES } from "../common/actors";
import { IntakeValidationError } from "../common/errors";
import { getSessionBundle } from "../common/sessions";
import { getConflictStatusForSession, type ConflictState } from "../adapters/conflictStatus";
import { receiveInbound } from "../channels/service";
import { caseDetailsLock, normalizeEmail, normalizePhone, suggestDuplicates, type LockReason } from "../channels/records";
import { deriveStaffSteps, STAFF_CASE_DETAIL_FIELDS, validateNewIntake, type NewIntakeInput, type StaffStepView } from "./steps";

export interface ExistingIntakeMatch {
  partyId: string;
  fullName: string;
  matchedOn: string[];
  /** Open (not finished) intakes for this contact, newest first. */
  openIntakes: Array<{ intakeSessionId: string; channel: string; status: string; startedAt: Date }>;
}

/**
 * People the firm already has on file who match the name, email or phone
 * typed into the form, with any intake of theirs that is still open. Staff
 * use this to pick up the existing intake instead of creating a duplicate.
 * Nothing is merged or changed here (c71: staff confirm, never auto-merge).
 */
export async function findExistingContacts(
  tx: TenantTx,
  input: { tenantId: string; staffUserId: string; name?: string | null; email?: string | null; phone?: string | null }
): Promise<ExistingIntakeMatch[]> {
  await requireStaff(tx, input.tenantId, input.staffUserId, STAFF_ROLES, "look up existing contacts");
  const name = input.name?.trim() ? normalizeName(input.name) : null;
  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phone);
  const conds = [];
  if (name && name !== "unknown contact") conds.push(eq(parties.normalizedName, name));
  if (email) conds.push(eq(parties.email, email));
  if (phone) conds.push(eq(parties.phone, phone));
  if (conds.length === 0) return [];

  const candidates = await tx
    .select({ id: parties.id, fullName: parties.fullName, normalizedName: parties.normalizedName, email: parties.email, phone: parties.phone })
    .from(parties)
    .where(and(eq(parties.tenantId, input.tenantId), or(...conds)))
    .limit(50);
  const ranked = suggestDuplicates({ normalizedName: name, email, phone }, candidates).slice(0, 10);
  if (ranked.length === 0) return [];

  const ids = ranked.map((r) => r.id);
  const open = await tx
    .select({
      partyId: intakeSessionState.partyId,
      intakeSessionId: intakeSessionState.intakeSessionId,
      channel: intakeSessionState.channel,
      status: intakeSessionState.status,
      startedAt: intakeSessions.startedAt,
    })
    .from(intakeSessionState)
    .innerJoin(intakeSessions, and(eq(intakeSessions.id, intakeSessionState.intakeSessionId), eq(intakeSessions.tenantId, intakeSessionState.tenantId)))
    .where(
      and(
        eq(intakeSessionState.tenantId, input.tenantId),
        inArray(intakeSessionState.partyId, ids),
        isNull(intakeSessions.terminalState),
        sql`${intakeSessionState.status} not in ('closed', 'not_an_inquiry')`
      )
    );

  const byId = new Map(candidates.map((c) => [c.id, c]));
  return ranked.map((r) => ({
    partyId: r.id,
    fullName: byId.get(r.id)?.fullName ?? "Unknown contact",
    matchedOn: r.matchedOn,
    openIntakes: open
      .filter((o) => o.partyId === r.id)
      .map(({ intakeSessionId, channel, status, startedAt }) => ({ intakeSessionId, channel, status, startedAt }))
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime()),
  }));
}

/**
 * Create an intake a staff member is entering by hand (walk-in, or a call
 * taken outside the firm's phone system). Goes through receiveInbound like
 * every other channel: no automated reply is sent, the response clock
 * starts, and the event records which staff member entered it.
 */
export async function createStaffEnteredIntake(
  tx: TenantTx,
  input: NewIntakeInput & { tenantId: string; staffUserId: string }
): Promise<{ intakeSessionId: string }> {
  const checked = validateNewIntake(input);
  if (!checked.ok) throw new IntakeValidationError(checked.errors.join(" "));
  const { channel, name, email, phone, language } = checked.value;
  const result = await receiveInbound(tx, {
    tenantId: input.tenantId,
    channel,
    from: { name, email, phone },
    language,
    staffUserId: input.staffUserId,
  });
  return { intakeSessionId: result.intakeSessionId };
}

export interface StaffIntakeView {
  intakeSessionId: string;
  channel: string;
  status: string;
  language: string;
  startedAt: Date;
  matterId: string | null;
  contact: { fullName: string; email: string | null; phone: string | null } | null;
  disclosuresAcknowledgedAt: Date | null;
  conflictMinimum: { fullName?: string; otherPartyNames?: string[] };
  conflictState: ConflictState;
  caseDetails: Partial<Record<(typeof STAFF_CASE_DETAIL_FIELDS)[number], string>>;
  caseDetailsLocked: boolean;
  lockReasons: LockReason[];
  responseTargetAt: Date | null;
  firstHumanContactAt: Date | null;
  responseOutcome: string | null;
  fitOutcome: string | null;
  safetyFlagged: boolean;
  steps: StaffStepView[];
}

/** Everything the guided intake page shows, in one read (staff view; internal). */
export async function getStaffIntakeView(tx: TenantTx, tenantId: string, intakeSessionId: string): Promise<StaffIntakeView> {
  const { session, state } = await getSessionBundle(tx, tenantId, intakeSessionId);
  const [party] = state.partyId
    ? await tx
        .select({ fullName: parties.fullName, email: parties.email, phone: parties.phone })
        .from(parties)
        .where(and(eq(parties.tenantId, tenantId), eq(parties.id, state.partyId)))
        .limit(1)
    : [];
  const conflict = await getConflictStatusForSession(tx, tenantId, session.id);
  const lock = caseDetailsLock({
    disclosuresAcknowledgedAt: state.disclosuresAcknowledgedAt,
    conflictMinimum: state.conflictMinimum,
    conflictState: conflict.state,
    status: state.status,
  });
  const answers = (session.collectedAnswers ?? {}) as Record<string, unknown>;
  const caseDetails: StaffIntakeView["caseDetails"] = {};
  for (const key of STAFF_CASE_DETAIL_FIELDS) {
    const v = answers[key];
    if (typeof v === "string" && v.trim()) caseDetails[key] = v;
  }
  return {
    intakeSessionId: session.id,
    channel: state.channel,
    status: state.status,
    language: session.language,
    startedAt: session.startedAt,
    matterId: session.matterId,
    contact: party ?? null,
    disclosuresAcknowledgedAt: state.disclosuresAcknowledgedAt,
    conflictMinimum: state.conflictMinimum,
    conflictState: conflict.state,
    caseDetails,
    caseDetailsLocked: lock.locked,
    lockReasons: lock.reasons,
    responseTargetAt: state.responseTargetAt,
    firstHumanContactAt: state.firstHumanContactAt,
    responseOutcome: state.responseOutcome,
    fitOutcome: state.fitOutcome,
    safetyFlagged: state.safetyFlagged,
    steps: deriveStaffSteps({
      status: state.status,
      disclosuresAcknowledgedAt: state.disclosuresAcknowledgedAt,
      conflictMinimum: state.conflictMinimum,
      conflictCheckRequestedAt: state.conflictCheckRequestedAt,
      conflictState: conflict.state,
      caseDetailsRecorded: Object.keys(caseDetails).length > 0,
    }),
  };
}
