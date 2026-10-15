// Ethical screens (c60): the lifecycle step this card adds on top of what
// c59's decision service already built. A 'proceed_with_screen' decision
// already creates the conflict_screens row (status 'requested') and a
// "conflict-check.screen_setup" hand-off task (decisionService.ts); and
// activateScreen() (also already in decisionService.ts) flips a screen from
// 'requested' to 'active', re-audits it and refreshes the matter's conflict
// gate. What was missing, and what this file adds:
//
//   - actually SENDING the written notice the screen requires before it can
//     be treated as enforced, and completing the hand-off task once every
//     screen from a decision is set up (setUpScreensForDecision /
//     runScreenSetupTask, wired into the worker below);
//   - LIFTING a screen once it is no longer needed (liftScreen);
//   - a read-side enforcement check other engines' access code can call
//     before letting a screened user reach a matter or intake session, with
//     an audit row and an alert to the firm's conflicts attorneys
//     (assertNotScreened) — screenedSubjectIds() (access.ts) already answers
//     "what is this user screened from"; this is what a caller DOES with a
//     positive answer.
//
// Explicitly NOT in scope here: wiring assertNotScreened() into every other
// engine's own read paths (document access, calendar, billing). Each of
// those engines decides for itself where an ethical-screen check belongs in
// its own request flow; this file only gives them the call to make and
// guarantees it is logged and alerted the same way everywhere it is used.

import { and, eq } from "drizzle-orm";
import { matters } from "@/db/schema";
import { conflictScreens, inquiryParties } from "@/db/tables/conflict-check";
import { audit, enqueueNotification, getTask, raiseFlag } from "@/core";
import type { TenantTx } from "@/tenancy/withTenant";
import { assertCan, loadAccess, listConflictAttorneys, screenedSubjectIds, type ConflictAccess } from "./access";
import { activateScreen, type ScreenRow } from "./decisionService";
import { CONFLICT_COPY_GATES } from "./gates";
import { ENGINE } from "./settings";
import { actorFor, completeTaskIfOpen, ConflictError } from "./util";

export type { ScreenRow };

export const SCREEN_SETUP_TASK_TYPE = "conflict-check.screen_setup";

/** Thrown by assertNotScreened(): the user is screened from this matter/intake session. */
export class ScreenBlockedError extends Error {
  constructor(
    readonly userId: string,
    readonly subjectId: string
  ) {
    super(`User ${userId} is screened from ${subjectId} and may not access it.`);
    this.name = "ScreenBlockedError";
  }
}

/** Pure: is this screen currently in force? */
export function isScreenActive(screen: Pick<ScreenRow, "status">): boolean {
  return screen.status === "active";
}

/** Pure: the hand-off task's sourceRef is `conflict_decision:<id>` (set by decisionService.ts). Extracts the id, or null if the ref doesn't match. */
export function parseDecisionRef(sourceRef: string | null | undefined): string | null {
  if (!sourceRef) return null;
  const m = /^conflict_decision:(.+)$/.exec(sourceRef);
  return m ? m[1]! : null;
}

/** Pure: liftScreen()'s reason requirement, isolated so it is testable without a transaction. */
export function requireLiftReason(reason: string | null | undefined): string {
  const r = reason?.trim();
  if (!r) throw new ConflictError("A reason is required to lift a screen.");
  return r;
}

// ---------------------------------------------------------------------------
// Enforcement (read side)
// ---------------------------------------------------------------------------

/**
 * Call this before letting `access.userId` reach `subjectId` (a matter or
 * intake session id). Throws ScreenBlockedError when screened — the caller
 * decides what that means for its own route (404, 403, a redirect; a
 * screen's existence can itself be confidential, so never explain why).
 * Every call this is wired into, blocked or not, is that caller's own
 * decision; what this function guarantees is that the positive case is
 * handled the same way everywhere: one audit row other engines' logs agree
 * on, plus an internal alert to the firm's conflicts attorneys, so a
 * screened person repeatedly reaching for a matter doesn't go unnoticed.
 */
export async function assertNotScreened(
  tx: TenantTx,
  tenantId: string,
  access: Pick<ConflictAccess, "userId">,
  subjectId: string,
  attempted: string
): Promise<void> {
  const screened = await screenedSubjectIds(tx, tenantId, access.userId);
  if (!screened.has(subjectId)) return;

  await audit(tx, {
    tenantId,
    engine: ENGINE,
    action: "screen.blocked",
    entityType: "conflict_screen_subject",
    entityId: subjectId,
    actor: { type: "user", userId: access.userId },
    payload: { attempted },
  });

  const attorneys = await listConflictAttorneys(tx, tenantId);
  const alertUserIds = attorneys.all.filter((id) => id !== access.userId);
  if (alertUserIds.length > 0) {
    await raiseFlag(tx, {
      tenantId,
      type: "conflict-check.screen_blocked_attempt",
      severity: "high",
      audience: "internal",
      title: "A screened user attempted to access a screened matter",
      summary: `User ${access.userId} attempted '${attempted}' on a subject they are screened from.`,
      recipients: { userIds: alertUserIds },
      sourceCard: "c60",
      engine: ENGINE,
      dedupeKey: `conflict-check.screen_blocked:${subjectId}:${access.userId}`,
    });
  }
  throw new ScreenBlockedError(access.userId, subjectId);
}

// ---------------------------------------------------------------------------
// Lifting a screen
// ---------------------------------------------------------------------------

export interface LiftScreenInput {
  tenantId: string;
  screenId: string;
  reason: string;
  access: ConflictAccess;
  now?: Date;
}

/** Lift a screen (conflicts-attorney decision only, c60 §4.1). Reason is required and logged — screens never lapse silently. */
export async function liftScreen(tx: TenantTx, input: LiftScreenInput): Promise<ScreenRow> {
  assertCan(input.access, "decide");
  const reason = requireLiftReason(input.reason);
  const now = input.now ?? new Date();

  const [screen] = await tx
    .select()
    .from(conflictScreens)
    .where(and(eq(conflictScreens.tenantId, input.tenantId), eq(conflictScreens.id, input.screenId)))
    .limit(1);
  if (!screen) throw new ConflictError("Screen not found.", 404);
  if (screen.status === "lifted") throw new ConflictError("Screen is already lifted.");

  const [row] = await tx
    .update(conflictScreens)
    .set({ status: "lifted", liftedAt: now })
    .where(eq(conflictScreens.id, screen.id))
    .returning();
  if (!row) throw new Error("liftScreen: update failed.");

  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "screen.lifted",
    entityType: "conflict_screen",
    entityId: row.id,
    matterId: row.matterId,
    actor: actorFor(input.access),
    reason,
  });
  return row;
}

// ---------------------------------------------------------------------------
// Screen set-up hand-off (c59 decision -> c60 enforcement)
// ---------------------------------------------------------------------------

/** The prospective client / client a screen protects, resolved for the written-notice send. Null when it can't be resolved yet. */
async function resolveAffectedPartyId(
  tx: TenantTx,
  tenantId: string,
  screen: Pick<ScreenRow, "matterId" | "intakeSessionId">
): Promise<string | null> {
  if (screen.matterId) {
    const [m] = await tx
      .select({ primaryPartyId: matters.primaryPartyId })
      .from(matters)
      .where(and(eq(matters.tenantId, tenantId), eq(matters.id, screen.matterId)))
      .limit(1);
    return m?.primaryPartyId ?? null;
  }
  if (screen.intakeSessionId) {
    const rows = await tx
      .select()
      .from(inquiryParties)
      .where(and(eq(inquiryParties.tenantId, tenantId), eq(inquiryParties.intakeSessionId, screen.intakeSessionId)));
    return rows.find((r) => r.role === "prospective_client")?.partyId ?? null;
  }
  return null;
}

export interface SetUpScreensResult {
  /** Screens whose notice was sent and that are now 'active'. */
  activated: number;
  /** Requested screens left untouched because no party could be resolved yet — the hand-off task stays open for a human. */
  skipped: number;
}

/**
 * The c59 -> c60 hand-off: every screen a decision requested gets its
 * required written notice sent to the affected client or prospective
 * client, then is activated (decisionService.ts's activateScreen, which also
 * re-audits and refreshes the matter's conflict gate). A screen whose party
 * can't be resolved yet is left 'requested' — never silently dropped — so it
 * stays visible on the open hand-off task for a person to finish by hand.
 */
export async function setUpScreensForDecision(
  tx: TenantTx,
  input: { tenantId: string; decisionId: string; by: ConflictAccess; now?: Date }
): Promise<SetUpScreensResult> {
  const now = input.now ?? new Date();
  const requested = await tx
    .select()
    .from(conflictScreens)
    .where(
      and(
        eq(conflictScreens.tenantId, input.tenantId),
        eq(conflictScreens.decisionId, input.decisionId),
        eq(conflictScreens.status, "requested")
      )
    );

  let activated = 0;
  let skipped = 0;
  for (const screen of requested) {
    const partyId = await resolveAffectedPartyId(tx, input.tenantId, screen);
    if (!partyId) {
      skipped += 1;
      continue;
    }
    await enqueueNotification(
      tx,
      {
        tenantId: input.tenantId,
        channel: "email",
        recipient: { type: "party", partyId },
        templateKey: CONFLICT_COPY_GATES.screenSetupNotice.key,
        payload: {},
        sensitive: true,
        dedupeKey: `conflict-check.screen_notice:${screen.id}`,
      },
      { now }
    );
    await activateScreen(tx, { tenantId: input.tenantId, screenId: screen.id, noticeSentAt: now, access: input.by, now });
    activated += 1;
  }
  return { activated, skipped };
}

/**
 * Worker entry point for the "conflict-check.screen_setup" scheduled task
 * (created by decisionService.ts alongside each 'requested' screen, owned by
 * the conflicts attorney the decision assigned it to). Loads that attorney's
 * own access and uses it to set up every screen from the decision; completes
 * the task only once none were skipped, so an unresolved party keeps the
 * hand-off visible instead of quietly disappearing.
 */
export async function runScreenSetupTask(
  tx: TenantTx,
  input: { tenantId: string; taskId: string; sourceRef: string | null | undefined; now?: Date }
): Promise<SetUpScreensResult | null> {
  const decisionId = parseDecisionRef(input.sourceRef);
  if (!decisionId) return null;

  const task = await getTask(tx, input.tenantId, input.taskId);
  if (!task || !task.ownerUserId) return null;

  const now = input.now ?? new Date();
  const access = await loadAccess(tx, input.tenantId, task.ownerUserId);
  const result = await setUpScreensForDecision(tx, { tenantId: input.tenantId, decisionId, by: access, now });

  if (result.skipped === 0) {
    await completeTaskIfOpen(tx, {
      tenantId: input.tenantId,
      taskId: input.taskId,
      by: actorFor(access),
      reason: "Every screen from this decision is set up and notice has been sent.",
      at: now,
    });
  }
  return result;
}
