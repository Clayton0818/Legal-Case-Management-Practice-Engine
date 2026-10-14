// Unpaid-invoice tracking and reminders (c81): an aging report plus a
// polite, factual reminder sequence — never a collections-threat message,
// and never an automatic escalation past a lawyer. Pure domain logic +
// tests only in this PR; no new tables, routes, or send-wiring yet (see the
// note at the top of timeEntries.ts).
//
// The reminder copy is NOT drafted fresh here — it reuses the shared
// notify.client.reminder gate that src/compliance/gates.ts already lists
// c81 against, so the exact same attorney-reviewed wording this firm uses
// for its other client reminders is the wording c81 sends, and nothing
// goes out until that gate is approved.

import { legalCopyStatus } from "@/compliance/approvals";
import { NOTIFY_COPY_GATES } from "@/compliance/gates";
import { sumCents, type Cents } from "./money";

export const AGING_BUCKETS = ["current", "30", "60", "90+"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export class CollectionsError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "CollectionsError";
  }
}

export interface OpenInvoiceSummary {
  invoiceId: string;
  matterId: string;
  clientId: string;
  lawyerId: string;
  amountDueCents: Cents;
  /** YYYY-MM-DD */
  dueDate: string;
}

/** Whole days between dueDate and asOf (both YYYY-MM-DD); never negative. */
export function daysPastDue(dueDate: string, asOf: string): number {
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  const today = Date.parse(`${asOf}T00:00:00Z`);
  if (Number.isNaN(due) || Number.isNaN(today)) {
    throw new CollectionsError("INVALID_DATE", "dueDate and asOf must be YYYY-MM-DD dates.");
  }
  return Math.max(0, Math.round((today - due) / 86_400_000));
}

/** current (not yet overdue), 30 (1-30 days), 60 (31-60 days), 90+ (61+ days) — matching c81's card text exactly. */
export function agingBucketFor(daysOverdue: number): AgingBucket {
  if (!Number.isInteger(daysOverdue) || daysOverdue < 0) {
    throw new CollectionsError("INVALID_DAYS", "daysOverdue must be a whole number, zero or more.");
  }
  if (daysOverdue === 0) return "current";
  if (daysOverdue <= 30) return "30";
  if (daysOverdue <= 60) return "60";
  return "90+";
}

export interface AgingReportRow {
  bucket: AgingBucket;
  invoiceCount: number;
  totalCents: Cents;
}

export interface AgingReport {
  asOf: string;
  rows: AgingReportRow[];
  totalCents: Cents;
  byClient: Map<string, Cents>;
  byMatter: Map<string, Cents>;
  byLawyer: Map<string, Cents>;
}

/** Fully-paid invoices (amountDueCents <= 0) are excluded — this is a report of what is still open. */
export function buildAgingReport(invoices: OpenInvoiceSummary[], asOf: string): AgingReport {
  const rowsByBucket = new Map<AgingBucket, { count: number; total: Cents }>();
  for (const bucket of AGING_BUCKETS) rowsByBucket.set(bucket, { count: 0, total: 0n });
  const byClient = new Map<string, Cents>();
  const byMatter = new Map<string, Cents>();
  const byLawyer = new Map<string, Cents>();

  for (const inv of invoices) {
    if (inv.amountDueCents <= 0n) continue;
    const overdue = daysPastDue(inv.dueDate, asOf);
    const bucket = agingBucketFor(overdue);
    const row = rowsByBucket.get(bucket)!;
    row.count += 1;
    row.total += inv.amountDueCents;
    byClient.set(inv.clientId, (byClient.get(inv.clientId) ?? 0n) + inv.amountDueCents);
    byMatter.set(inv.matterId, (byMatter.get(inv.matterId) ?? 0n) + inv.amountDueCents);
    byLawyer.set(inv.lawyerId, (byLawyer.get(inv.lawyerId) ?? 0n) + inv.amountDueCents);
  }

  const rows: AgingReportRow[] = AGING_BUCKETS.map((bucket) => {
    const r = rowsByBucket.get(bucket)!;
    return { bucket, invoiceCount: r.count, totalCents: r.total };
  });
  const totalCents = sumCents(rows.map((r) => r.totalCents));
  return { asOf, rows, totalCents, byClient, byMatter, byLawyer };
}

export interface ReminderStageConfig {
  /** Days overdue at which this stage becomes due. */
  afterDays: number;
}

/** A reasonable starting sequence, not a settled firm policy — real values belong in firm settings once this ships. */
export const DEFAULT_REMINDER_STAGES: readonly ReminderStageConfig[] = Object.freeze([
  { afterDays: 7 },
  { afterDays: 21 },
  { afterDays: 45 },
]);

/** The highest stage index that is due (daysOverdue >= its afterDays) and not already in alreadySentStages; null if none is due. */
export function dueReminderStage(
  daysOverdue: number,
  stages: readonly ReminderStageConfig[] = DEFAULT_REMINDER_STAGES,
  alreadySentStages: readonly number[] = []
): number | null {
  let candidate: number | null = null;
  stages.forEach((stage, index) => {
    if (daysOverdue >= stage.afterDays && !alreadySentStages.includes(index)) candidate = index;
  });
  return candidate;
}

/** Past the last configured reminder stage, this hands the account to a lawyer instead of sending another automated reminder. */
export function recommendLawyerEscalation(
  daysOverdue: number,
  stages: readonly ReminderStageConfig[] = DEFAULT_REMINDER_STAGES
): boolean {
  const last = stages[stages.length - 1];
  return last !== undefined && daysOverdue > last.afterDays;
}

export interface ReminderDraft {
  text: string;
  approved: boolean;
  pendingReviewers: string[];
  gateKey: string;
}

/**
 * The reminder text, via the shared attorney-reviewed template
 * (notify.client.reminder). Comes back as a visible
 * "[PENDING ATTORNEY REVIEW ...]" placeholder — never a guessed message —
 * until that gate is actually approved.
 */
export function buildReminderDraft(vars: Record<string, string | number>): ReminderDraft {
  const status = legalCopyStatus(NOTIFY_COPY_GATES.reminder.key, vars);
  return {
    text: status.text,
    approved: status.approved,
    pendingReviewers: status.pendingReviewers,
    gateKey: NOTIFY_COPY_GATES.reminder.key,
  };
}
