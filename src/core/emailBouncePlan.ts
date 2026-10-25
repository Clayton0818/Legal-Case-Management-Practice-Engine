// What to do when an email from the notification outbox (c51) bounces. Pure,
// no I/O: src/core/emailBounces.ts loads the facts and carries out the plan.
//
// Founder decision (2026-10-23): when a CLIENT's email hard-bounces or is
// marked as spam, alert BOTH the matter's responsible lawyer AND the firm's
// intake staff. If the firm has neither, fall back to the firm admins so the
// alert never goes nowhere (c51). A task to confirm a working, SAFE address
// goes with it. Nothing is ever re-sent through another channel or address
// automatically: the client's safe-contact choices (c42, c103) decide that,
// and a person makes the call.
//
// A STAFF member's bounced email flags the firm admins (their account email
// is probably wrong). Soft bounces ('failed') are retried by the outbox and
// produce nothing here.

export type BounceSeverity = "warning" | "high";

export interface BounceFacts {
  /** Outbox row id of the email that bounced. */
  notificationId: string;
  recipientType: "user" | "party";
  matterId: string | null;
  /** The bounced notification was urgent. */
  urgent: boolean;
  /** Short, address-free reason recorded by the webhook (e.g. "Permanent bounce (HardBounce)."). */
  detail: string | null;

  /** Client bounces. */
  partyId: string | null;
  partyDvSensitive: boolean;
  /** The matter's responsible lawyer, ONLY if that user is active. */
  assignedLawyerId: string | null;
  /** Active intake staff of the firm. */
  intakeStaffIds: readonly string[];

  /** Staff bounces. */
  bouncedUserId: string | null;
  bouncedUserName: string | null;

  /** Active firm admins (the fallback for both kinds). */
  adminIds: readonly string[];
}

export interface PlannedBounceFlag {
  type: string;
  severity: BounceSeverity;
  urgent: boolean;
  title: string;
  summary: string;
  recipientUserIds: string[];
  dedupeKey: string;
}

export interface PlannedBounceTask {
  kind: string;
  title: string;
  owner: { type: "user"; userId: string } | { type: "firm" };
  dueBusinessHours: number;
  sourceRef: string;
}

export type BouncePlan =
  | { kind: "none"; reason: string }
  | { kind: "client"; flag: PlannedBounceFlag; task: PlannedBounceTask }
  | { kind: "staff"; flag: PlannedBounceFlag };

export const CLIENT_BOUNCE_FLAG_TYPE = "notify.client_email_bounced";
export const STAFF_BOUNCE_FLAG_TYPE = "notify.staff_email_bounced";
export const CLIENT_BOUNCE_TASK_KIND = "core.client_email_bounced";
export const CLIENT_BOUNCE_TASK_TITLE = "Confirm a working, safe email address with the client";

/** Business hours to confirm a new address: 8 normally, 2 when the client is DV-sensitive or the notice was urgent. */
export const BOUNCE_DUE_BUSINESS_HOURS = { standard: 8, priority: 2 } as const;

export function clientBounceDedupeKey(partyId: string): string {
  return `client_email_bounced:${partyId}`;
}

export function staffBounceDedupeKey(userId: string): string {
  return `staff_email_bounced:${userId}`;
}

function uniq(ids: ReadonlyArray<string | null | undefined>): string[] {
  return [...new Set(ids.filter((x): x is string => Boolean(x)))];
}

function reasonText(detail: string | null): string {
  const d = (detail ?? "").trim().replace(/\.+$/, "");
  return d || "permanent bounce";
}

/**
 * Who hears about a client's bounced email: the responsible lawyer AND all
 * intake staff; if both are missing, the firm admins. Never empty while the
 * firm has any of the three.
 */
export function clientBounceRecipients(input: {
  assignedLawyerId: string | null;
  intakeStaffIds: readonly string[];
  adminIds: readonly string[];
}): string[] {
  const primary = uniq([input.assignedLawyerId, ...input.intakeStaffIds]);
  return primary.length > 0 ? primary : uniq([...input.adminIds]);
}

export function planEmailBounce(f: BounceFacts): BouncePlan {
  const reason = reasonText(f.detail);

  if (f.recipientType === "party") {
    if (!f.partyId) return { kind: "none", reason: "Client bounce without a party id." };
    const recipients = clientBounceRecipients(f);
    if (recipients.length === 0) {
      return { kind: "none", reason: "The firm has no active lawyer on the matter, intake staff or admin to alert." };
    }
    const priority = f.partyDvSensitive || f.urgent;
    let summary =
      `An email to this client bounced (${reason}). Their notice is still waiting in the client portal. ` +
      "Confirm a new address using a contact method the client marked safe; do not switch to another channel that is not on their safe-contact list.";
    if (f.partyDvSensitive) summary += " This client is marked DV-sensitive: the responsible lawyer decides how to reach them.";
    return {
      kind: "client",
      flag: {
        type: CLIENT_BOUNCE_FLAG_TYPE,
        severity: priority ? "high" : "warning",
        urgent: priority,
        title: "Client email could not be delivered",
        summary,
        recipientUserIds: recipients,
        dedupeKey: clientBounceDedupeKey(f.partyId),
      },
      task: {
        kind: CLIENT_BOUNCE_TASK_KIND,
        title: CLIENT_BOUNCE_TASK_TITLE,
        owner: f.assignedLawyerId ? { type: "user", userId: f.assignedLawyerId } : { type: "firm" },
        dueBusinessHours: priority ? BOUNCE_DUE_BUSINESS_HOURS.priority : BOUNCE_DUE_BUSINESS_HOURS.standard,
        sourceRef: `notification:${f.notificationId}`,
      },
    };
  }

  if (!f.bouncedUserId) return { kind: "none", reason: "Staff bounce without a user id." };
  const recipients = f.adminIds.length > 0 ? uniq([...f.adminIds]) : [f.bouncedUserId];
  const name = (f.bouncedUserName ?? "").trim() || "a staff member";
  return {
    kind: "staff",
    flag: {
      type: STAFF_BOUNCE_FLAG_TYPE,
      severity: "warning",
      urgent: false,
      title: "A staff member's email could not be delivered",
      summary: `Alerts to ${name} are not reaching their inbox (${reason}). Check the email address on their account.`,
      recipientUserIds: recipients,
      dedupeKey: staffBounceDedupeKey(f.bouncedUserId),
    },
  };
}
