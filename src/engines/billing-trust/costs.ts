// Costs and expenses (c78): filing fees, service of process, experts, and
// other matter costs — tracked separately from time, and flagged as
// trust-funded or firm-funded. Pure domain logic + tests only in this PR; no
// new tables or API routes yet (see the note at the top of timeEntries.ts
// for why c77/c78/c79/c81 each land as their own same-day PR against main
// rather than one combined PR).
//
// Whether a cost is actually PAID from the trust account is a real-money
// action and stays with the trust ledger (c76) and its own approval gate;
// this file only records and prices the cost, it never moves money.

import { assertPositiveAmount, parseCents, type Cents } from "./money";

export const COST_CATEGORIES = [
  "filing_fee",
  "service_of_process",
  "expert",
  "copies",
  "travel",
  "mileage",
  "other",
] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

export const COST_STATUSES = ["pending", "approved", "billed", "written_off"] as const;
export type CostStatus = (typeof COST_STATUSES)[number];

export const COST_PAID_BY = ["firm", "trust"] as const;
export type CostPaidBy = (typeof COST_PAID_BY)[number];

export class CostError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "CostError";
  }
}

export interface CostInput {
  matterId: string;
  category: CostCategory;
  description: string;
  amountCents: Cents;
  /** YYYY-MM-DD */
  incurredOn: string;
  billable: boolean;
  paidBy: CostPaidBy;
  receiptDocumentId?: string | null;
  /** e.g. 10 for a 10% markup; the real markup ceiling comes from the engagement agreement (c39), not this engine. */
  markupPercent?: number | null;
}

export interface Cost extends CostInput {
  id: string;
  tenantId: string;
  status: CostStatus;
  /** amountCents after markup is applied; equals amountCents when markupPercent is unset. */
  billedAmountCents: Cents;
  approvedByUserId: string | null;
  approvedAt: Date | null;
  createdAt: Date;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A sanity ceiling on markup itself, not a settled fee rule — the fee-agreement-terms gate (c39/c52) governs what a firm may actually charge. */
const MAX_MARKUP_PERCENT = 500;

function assertNonNegativeCents(v: Cents): Cents {
  if (v < 0n) throw new CostError("INVALID_AMOUNT", "Amount must be zero or more.");
  return v;
}

/** miles * centsPerMile, rounded half up to the cent. Miles may be fractional (e.g. 12.5). */
export function computeMileageCents(miles: number, ratePerMileCents: Cents): Cents {
  if (!Number.isFinite(miles) || miles < 0) throw new CostError("INVALID_MILES", "Miles must be zero or more.");
  const rate = assertNonNegativeCents(ratePerMileCents);
  const milesHundredths = BigInt(Math.round(miles * 100));
  const numerator = milesHundredths * rate;
  const denom = 100n;
  const q = numerator / denom;
  const r = numerator % denom;
  return r * 2n >= denom ? q + 1n : q;
}

/** amountCents * (100 + markupPercent) / 100, rounded half up. Returns amountCents unchanged when markupPercent is null/0. */
export function applyMarkup(amountCents: Cents, markupPercent: number | null | undefined): Cents {
  const base = assertPositiveAmount(amountCents, "amountCents");
  if (markupPercent === null || markupPercent === undefined || markupPercent === 0) return base;
  if (!Number.isFinite(markupPercent) || markupPercent < 0 || markupPercent > MAX_MARKUP_PERCENT) {
    throw new CostError("INVALID_MARKUP", `markupPercent must be between 0 and ${MAX_MARKUP_PERCENT}.`);
  }
  const markupHundredths = BigInt(Math.round(markupPercent * 100));
  const factor = 10_000n + markupHundredths;
  const denom = 10_000n;
  const numerator = base * factor;
  const q = numerator / denom;
  const r = numerator % denom;
  return r * 2n >= denom ? q + 1n : q;
}

export function validateCostInput(input: CostInput): void {
  if (!DATE_RE.test(input.incurredOn)) throw new CostError("INVALID_DATE", "incurredOn must be a YYYY-MM-DD date.");
  if (!input.description.trim()) throw new CostError("DESCRIPTION_REQUIRED", "A description is required.");
  assertPositiveAmount(parseCents(input.amountCents, "amountCents"), "amountCents");
}

export function approveCost(
  cost: Pick<Cost, "status">,
  approverUserId: string,
  now: Date = new Date()
): { status: "approved"; approvedByUserId: string; approvedAt: Date } {
  if (cost.status !== "pending") {
    throw new CostError("INVALID_TRANSITION", `Only a pending cost can be approved (was '${cost.status}').`);
  }
  return { status: "approved", approvedByUserId: approverUserId, approvedAt: now };
}

export function markCostBilled(cost: Pick<Cost, "status">, invoiceId: string): { status: "billed" } {
  if (cost.status !== "approved") {
    throw new CostError("INVALID_TRANSITION", `Only an approved cost can be billed (was '${cost.status}').`);
  }
  if (!invoiceId) throw new CostError("INVOICE_REQUIRED", "An invoice id is required to mark a cost billed.");
  return { status: "billed" };
}

export function writeOffCost(cost: Pick<Cost, "status">, reason: string): { status: "written_off" } {
  if (cost.status === "billed") {
    throw new CostError("INVALID_TRANSITION", "A billed cost cannot be written off; void the invoice instead.");
  }
  if (!reason.trim()) throw new CostError("REASON_REQUIRED", "A reason is required to write off a cost.");
  return { status: "written_off" };
}
