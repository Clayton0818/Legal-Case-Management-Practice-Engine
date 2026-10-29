// c90 — closing a file: the closing checklist, the retention preview, the
// destruction review and reopening. Pure decision logic; callers load the
// facts and write the results (and the audit rows, rule 10).
//
// Spec: docs/product/features/document/c90-closing-a-file.md §4–5.
//   Rule 1  A matter cannot close while the client's trust balance is above
//           zero unless a lawyer recorded a hold reason (c82, c95). This item
//           can NOT be waived.
//   Rule 2  Every other item must be done or waived with a logged reason.
//   Rule 3  Only an attorney closes, reopens, or approves destruction
//           (right `matters.close`, attorney-only in src/core/permissions.ts).
//   Rule 4  No product default retention: the firm must set one (criterion 8).
//   Rule 5  Nothing is destroyed automatically.
//   Rule 6  A legal hold blocks destruction approval.
//   Rule 8  Trust records are never destroyed by this flow.
//
// Retention periods are legal / policy rules. Applying one goes through the
// existing rules.retention_periods gate in ../retention/policy.ts
// (proposeRetention); the preview here only shows the date the database
// trigger on `matters` will compute from closed_at + retention_years.

import { addYearsUtc } from "../retention/policy";

export const CLOSE_RIGHT = "matters.close";

export type ClosingItemKey =
  | "final_invoice"
  | "trust_balance"
  | "open_tasks"
  | "future_events"
  | "closing_letter"
  | "originals"
  | "retention_period";

/** Items that can never be waived: trust (rule 1) and retention (rule 4). */
export const UNWAIVABLE: ReadonlySet<ClosingItemKey> = new Set(["trust_balance", "retention_period"]);

export type FinalInvoiceState = "settled" | "written_off" | "none_needed" | "open" | "not_issued";
export type ClosingLetterState = "delivered" | "approved" | "draft" | "none";
export type OriginalDisposition = "returned" | "kept_at_client_instruction" | "other";

export interface OriginalHeld {
  groupId: string;
  title: string;
  disposition: OriginalDisposition | null;
  /** Required for 'other' (and recommended for every disposition). */
  note?: string | null;
}

export interface ClosingFacts {
  finalInvoice: FinalInvoiceState;
  /**
   * The client's trust balance on this matter in cents, from the ledger (c76).
   * null = trust ledger not live for this firm: a lawyer must attest the
   * balance is zero outside the product (spec §4.2), with who and when.
   */
  trustBalanceCents: number | null;
  trustHoldReason: string | null;
  trustAttestation: { byUserId: string; at: Date } | null;
  openTaskCount: number;
  futureEventCount: number;
  closingLetter: ClosingLetterState;
  originals: readonly OriginalHeld[];
  /** Retention the lawyer confirmed (defaults from the firm's per-practice-area setting). null = none set. */
  retentionYears: number | null;
  /** Item key -> lawyer's reason for waiving it. */
  waivers: Readonly<Partial<Record<ClosingItemKey, string>>>;
}

export type ItemState = "done" | "waived" | "open";

export interface ClosingItem {
  key: ClosingItemKey;
  label: string;
  state: ItemState;
  detail: string;
}

export interface ClosingEvaluation {
  items: ClosingItem[];
  canClose: boolean;
  blockers: ClosingItem[];
}

const LABELS: Record<ClosingItemKey, string> = {
  final_invoice: "Final invoice settled or written off",
  trust_balance: "Trust balance zero, or a hold reason recorded",
  open_tasks: "Open tasks completed or cancelled",
  future_events: "Future calendar events cancelled",
  closing_letter: "Closing letter approved and delivered",
  originals: "Original documents returned or disposition recorded",
  retention_period: "Retention period set",
};

function moneyCents(c: number): string {
  return `$${(c / 100).toFixed(2)}`;
}

/** Evaluate every closing item. Pure. */
export function evaluateClosing(f: ClosingFacts): ClosingEvaluation {
  const items: ClosingItem[] = [];
  const push = (key: ClosingItemKey, done: boolean, detail: string) => {
    const waiver = f.waivers[key]?.trim();
    const state: ItemState = done ? "done" : waiver && !UNWAIVABLE.has(key) ? "waived" : "open";
    items.push({ key, label: LABELS[key], state, detail: state === "waived" ? `Waived: ${waiver}` : detail });
  };

  push(
    "final_invoice",
    f.finalInvoice === "settled" || f.finalInvoice === "written_off" || f.finalInvoice === "none_needed",
    f.finalInvoice === "open" ? "The final invoice is still unpaid." : f.finalInvoice === "not_issued" ? "No final invoice has been issued." : "Final invoice resolved."
  );

  // Rule 1 / acceptance criterion 1.
  if (f.trustBalanceCents === null) {
    push("trust_balance", f.trustAttestation !== null, f.trustAttestation ? "A lawyer attested the trust balance is zero." : "Trust ledger is not live: a lawyer must attest the balance is zero.");
  } else if (f.trustBalanceCents < 0) {
    push("trust_balance", false, `Trust balance is negative (${moneyCents(f.trustBalanceCents)}); this must be investigated before closing.`);
  } else {
    const held = f.trustBalanceCents > 0 && !!f.trustHoldReason?.trim();
    push(
      "trust_balance",
      f.trustBalanceCents === 0 || held,
      f.trustBalanceCents === 0
        ? "Trust balance is zero."
        : held
          ? `Holding ${moneyCents(f.trustBalanceCents)} in trust: ${f.trustHoldReason!.trim()}`
          : `Trust balance must be zero or a hold reason recorded (currently ${moneyCents(f.trustBalanceCents)}).`
    );
  }

  push("open_tasks", f.openTaskCount === 0, f.openTaskCount === 0 ? "No open tasks." : `${f.openTaskCount} open task(s) must be completed or cancelled with a reason.`);
  push("future_events", f.futureEventCount === 0, f.futureEventCount === 0 ? "No future events." : `${f.futureEventCount} future event(s) must be cancelled.`);
  push(
    "closing_letter",
    f.closingLetter === "delivered",
    f.closingLetter === "delivered" ? "Delivered." : f.closingLetter === "approved" ? "Approved but not yet delivered." : f.closingLetter === "draft" ? "Drafted; a lawyer must approve it." : "No closing letter yet (generate it from the firm's approved closing template)."
  );

  // Criterion 3: every original held needs a disposition ('other' needs a note).
  const unresolved = f.originals.filter((o) => o.disposition === null || (o.disposition === "other" && !o.note?.trim()));
  push(
    "originals",
    unresolved.length === 0,
    unresolved.length === 0 ? (f.originals.length === 0 ? "No originals held." : "All originals accounted for.") : `Unresolved originals: ${unresolved.map((o) => o.title).join(", ")}.`
  );

  // Criterion 8.
  const r = f.retentionYears;
  const retentionOk = r !== null && Number.isInteger(r) && r >= 0 && r <= 100;
  push("retention_period", retentionOk, retentionOk ? `${r} year(s) after closing.` : "Enter the retention period before closing (the product ships no default).");

  const blockers = items.filter((i) => i.state === "open");
  return { items, canClose: blockers.length === 0, blockers };
}

export type Decision = { ok: true } | { ok: false; reason: string };

/** Rule 3 + rule 2: an attorney may close only when nothing is still open. */
export function canCloseMatter(rights: ReadonlySet<string>, evaluation: ClosingEvaluation): Decision {
  if (!rights.has(CLOSE_RIGHT)) return { ok: false, reason: "Only an attorney can close a matter." };
  if (!evaluation.canClose) return { ok: false, reason: evaluation.blockers.map((b) => b.detail).join(" ") };
  return { ok: true };
}

/** Validate a waiver before it is recorded (and audited). */
export function validateWaiver(rights: ReadonlySet<string>, key: ClosingItemKey, reason: string): Decision {
  if (!rights.has(CLOSE_RIGHT)) return { ok: false, reason: "Only an attorney can waive a closing item." };
  if (UNWAIVABLE.has(key)) {
    return { ok: false, reason: key === "trust_balance" ? "The trust item cannot be waived: refund the balance or record a hold reason." : "The retention period cannot be waived." };
  }
  if (!reason.trim()) return { ok: false, reason: "Record why this item is being waived." };
  return { ok: true };
}

/**
 * Preview of matters.eligible_for_deletion_at (criterion 2: closed
 * 2026-10-01 with 5 years -> 2031-10-01). The database trigger is the source
 * of truth; this is for showing the date before the lawyer confirms.
 */
export function previewDestructionReviewDate(closedAt: Date, retentionYears: number): Date {
  return addYearsUtc(closedAt, retentionYears);
}

// ---------------------------------------------------------------------------
// Destruction review (spec §4.7–4.9)
// ---------------------------------------------------------------------------

export interface DestructionReviewFacts {
  /** Legal holds on any of the matter's files (document_groups.legal_hold), with reasons. */
  legalHolds: readonly { groupId: string; reason: string }[];
  openDisputes: number;
  /** Originals still marked held. */
  originalsStillHeld: number;
  /** The reviewer's rights. */
  rights: ReadonlySet<string>;
}

export interface DestructionReviewOptions {
  approveDestruction: Decision;
  extend: Decision;
  placeOnHold: Decision;
  /** Shown to the reviewer next to the options. */
  warnings: string[];
}

/** Which review options are available (criterion 5: a legal hold disables approval). Pure. */
export function destructionReviewOptions(f: DestructionReviewFacts): DestructionReviewOptions {
  const attorney = f.rights.has(CLOSE_RIGHT);
  const notAttorney: Decision = { ok: false, reason: "Only an attorney can decide a destruction review." };
  const warnings: string[] = [];
  if (f.openDisputes > 0) warnings.push(`${f.openDisputes} open dispute(s) on this matter.`);
  if (f.originalsStillHeld > 0) warnings.push(`${f.originalsStillHeld} original document(s) are still held by the firm.`);

  let approve: Decision = attorney ? { ok: true } : notAttorney;
  if (attorney && f.legalHolds.length > 0) {
    approve = { ok: false, reason: `Legal hold: ${f.legalHolds.map((h) => h.reason).join("; ")}` };
  } else if (attorney && f.originalsStillHeld > 0) {
    approve = { ok: false, reason: "Return or record a disposition for every original before destruction." };
  }
  return { approveDestruction: approve, extend: attorney ? { ok: true } : notAttorney, placeOnHold: attorney ? { ok: true } : notAttorney, warnings };
}

export function validateExtension(years: number, reason: string): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(years) || years < 1 || years > 50) errors.push("Extend by a whole number of years from 1 to 50.");
  if (!reason.trim()) errors.push("Record why retention is being extended.");
  return errors;
}

/**
 * What a destruction removes and what it keeps (spec §4.9, rules 7–8). The
 * purge itself runs under a separate elevated role after lawyer approval
 * (see MIGRATION NOTES 2 in src/db/tables/document.ts), never as app_runtime.
 */
export const DESTRUCTION_SCOPE = {
  removes: ["document bytes and versions", "extracted text", "filed email", "portal messages", "intake answers"],
  keeps: [
    "tombstone: matter id, open/close dates, who approved destruction and when",
    "conflict-index parties (c56), permanently",
    "audit events, under the audit log's own retention",
    "trust account records (c76), under the trust-record retention",
  ],
} as const;

// ---------------------------------------------------------------------------
// Reopen (spec §4.10, criterion 7)
// ---------------------------------------------------------------------------

export interface ReopenPlan {
  stage: "retained";
  clearClosedAt: true;
  cancelTaskIds: string[];
}

export function planReopen(rights: ReadonlySet<string>, reason: string, pendingReviewTaskIds: readonly string[]): { ok: true; plan: ReopenPlan } | { ok: false; reason: string } {
  if (!rights.has(CLOSE_RIGHT)) return { ok: false, reason: "Only an attorney can reopen a matter." };
  if (!reason.trim()) return { ok: false, reason: "Record why the matter is being reopened." };
  return { ok: true, plan: { stage: "retained", clearClosedAt: true, cancelTaskIds: [...pendingReviewTaskIds] } };
}
