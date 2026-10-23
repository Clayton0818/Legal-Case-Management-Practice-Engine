// c110 — bridge this engine's own outcome to the shared
// `conflict_check_results` table that the intake engine reads
// (src/engines/intake/adapters/conflictStatus.ts).
//
// The engines may not import each other (src/engines/README.md), so the
// shared table IS the hand-off. Before this module, runConflictCheck() only
// wrote `conflict_checks` (this engine's own table), so intake never saw an
// outcome and every inquiry stayed locked at "no check yet" — the DEMO seed
// (c106) papered over the gap with a hand-written mirror.
//
// What is written, and the rules it keeps:
//  - one `conflict_check_results` row per check whose subject is an intake
//    session, with the SAME tri-state outcome (clear / possible / definite).
//    Nothing is upgraded, downgraded or cleared here.
//  - only ids and outcome reasons go into `matched_sources`: names and hit
//    details stay on the restricted `conflict_checks` record, because intake
//    staff (not just the conflicts role) can read conflict_check_results.
//  - a 'possible' result is marked resolved ONLY when the session's conflict
//    gate is open AND a human conflicts attorney recorded a decision; the
//    resolver is that attorney. Intake reads a resolved 'possible' as
//    "attorney cleared", so the system never resolves one by itself, and a
//    declined / awaiting-consent / awaiting-screen gate leaves it unresolved
//    (intake keeps it paused for the attorney). If a corrected decision
//    closes the gate again, the resolution is withdrawn.
//  - 'definite' is never resolved here: intake treats definite as definite.

import { and, desc, eq } from "drizzle-orm";
import { conflictCheckResults, intakeSessions } from "@/db/schema";
import { conflictChecks, conflictDecisions } from "@/db/tables/conflict-check";
import { audit } from "@/core";
import type { TenantTx } from "@/tenancy/withTenant";
import type { GateResult } from "./decisions";
import { ENGINE } from "./settings";
import type { ConflictOutcome } from "./types";

/** conflict_check_results.role_sought is NOT NULL; a check may be run without a role. */
export const ROLE_NOT_SPECIFIED = "not_specified";

const OUTCOMES: readonly ConflictOutcome[] = ["clear", "possible", "definite"];

function isOutcome(value: string): value is ConflictOutcome {
  return (OUTCOMES as readonly string[]).includes(value);
}

/** The parts of a conflict_checks row this bridge needs. */
export interface CheckForIntake {
  id: string;
  tenantId: string;
  intakeSessionId: string | null;
  roleSought: string | null;
  outcome: string;
  outcomeReasons: readonly string[];
  legacyResultId: string | null;
}

export type IntakeResultInsert = typeof conflictCheckResults.$inferInsert;

/**
 * The conflict_check_results row for a check, or null when the check is not
 * an intake check (or already points at an existing legacy result row). Pure.
 */
export function intakeResultValues(check: CheckForIntake, firmConfigVersionId: string, createdAt: Date): IntakeResultInsert | null {
  if (!check.intakeSessionId || check.legacyResultId) return null;
  if (!isOutcome(check.outcome)) return null;
  return {
    tenantId: check.tenantId,
    intakeSessionId: check.intakeSessionId,
    roleSought: check.roleSought?.trim() || ROLE_NOT_SPECIFIED,
    outcome: check.outcome,
    // Ids and reason codes only — never names or hit details (see header).
    matchedSources: { conflictCheckId: check.id, reasons: [...check.outcomeReasons] },
    firmConfigVersionId,
    resolvedByUserId: null,
    resolvedAt: null,
    createdAt,
  };
}

export interface ResultForResolution {
  outcome: ConflictOutcome;
  resolvedAt: Date | null;
  resolvedByUserId: string | null;
}

export type ResolutionPatch = { resolvedByUserId: string | null; resolvedAt: Date | null };

/**
 * How the latest intake result should change after the session's gate was
 * recomputed. Null = leave it alone. Pure.
 *
 * Only a 'possible' result is ever touched. It is resolved when the gate is
 * open and a human decided (never without a decider), and un-resolved when
 * the gate has closed again (e.g. a corrected decision).
 */
export function resolutionPatch(
  result: ResultForResolution,
  gate: Pick<GateResult, "state">,
  deciderUserId: string | null,
  now: Date
): ResolutionPatch | null {
  if (result.outcome !== "possible") return null;
  const resolved = result.resolvedAt !== null || result.resolvedByUserId !== null;
  if (gate.state === "open") {
    if (resolved || !deciderUserId) return null;
    return { resolvedByUserId: deciderUserId, resolvedAt: now };
  }
  return resolved ? { resolvedByUserId: null, resolvedAt: null } : null;
}

/**
 * Write the intake-facing result for a freshly inserted check. Called by
 * runConflictCheck() in the same transaction, before the gate is refreshed.
 */
export async function recordIntakeResult(tx: TenantTx, check: CheckForIntake, now: Date): Promise<void> {
  if (!check.intakeSessionId || check.legacyResultId) return;
  const [session] = await tx
    .select({ firmConfigVersionId: intakeSessions.firmConfigVersionId })
    .from(intakeSessions)
    .where(and(eq(intakeSessions.tenantId, check.tenantId), eq(intakeSessions.id, check.intakeSessionId)))
    .limit(1);
  if (!session) return;
  const values = intakeResultValues(check, session.firmConfigVersionId, now);
  if (!values) return;
  const [row] = await tx.insert(conflictCheckResults).values(values).returning({ id: conflictCheckResults.id });
  await audit(tx, {
    tenantId: check.tenantId,
    engine: ENGINE,
    action: "intake_result.recorded",
    entityType: "conflict_check_result",
    entityId: row?.id ?? null,
    intakeSessionId: check.intakeSessionId,
    payload: { checkId: check.id, outcome: check.outcome },
  });
}

/** The conflicts attorney who most recently decided a check on this session, if any. */
async function latestDeciderForSession(tx: TenantTx, tenantId: string, intakeSessionId: string): Promise<string | null> {
  const [row] = await tx
    .select({ userId: conflictDecisions.decidedByUserId })
    .from(conflictDecisions)
    .innerJoin(conflictChecks, eq(conflictChecks.id, conflictDecisions.checkId))
    .where(and(eq(conflictDecisions.tenantId, tenantId), eq(conflictChecks.tenantId, tenantId), eq(conflictChecks.intakeSessionId, intakeSessionId)))
    .orderBy(desc(conflictDecisions.decidedAt))
    .limit(1);
  return row?.userId ?? null;
}

/**
 * Keep the session's latest intake result in step with its conflict gate.
 * Called by refreshGate() for every intake-session subject, so decisions,
 * signed waivers and activated screens all reach intake the same way.
 */
export async function syncIntakeResolution(
  tx: TenantTx,
  tenantId: string,
  intakeSessionId: string,
  gate: Pick<GateResult, "state">,
  now: Date
): Promise<void> {
  const [latest] = await tx
    .select({
      id: conflictCheckResults.id,
      outcome: conflictCheckResults.outcome,
      resolvedAt: conflictCheckResults.resolvedAt,
      resolvedByUserId: conflictCheckResults.resolvedByUserId,
    })
    .from(conflictCheckResults)
    .where(and(eq(conflictCheckResults.tenantId, tenantId), eq(conflictCheckResults.intakeSessionId, intakeSessionId)))
    .orderBy(desc(conflictCheckResults.createdAt))
    .limit(1);
  if (!latest || latest.outcome !== "possible") return;

  const decider = gate.state === "open" ? await latestDeciderForSession(tx, tenantId, intakeSessionId) : null;
  const patch = resolutionPatch(latest, gate, decider, now);
  if (!patch) return;

  await tx
    .update(conflictCheckResults)
    .set(patch)
    .where(and(eq(conflictCheckResults.tenantId, tenantId), eq(conflictCheckResults.id, latest.id)));
  await audit(tx, {
    tenantId,
    engine: ENGINE,
    action: patch.resolvedAt ? "intake_result.resolved" : "intake_result.reopened",
    entityType: "conflict_check_result",
    entityId: latest.id,
    intakeSessionId,
    actor: patch.resolvedByUserId ? { type: "user", userId: patch.resolvedByUserId } : undefined,
    payload: { gateState: gate.state },
  });
}
