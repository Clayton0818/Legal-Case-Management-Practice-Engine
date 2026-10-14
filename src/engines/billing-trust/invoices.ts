// Invoices (c79): draft bills built from approved time and costs, always
// reviewed by the responsible lawyer before anything goes out. Pure domain
// logic + tests only in this PR; no new tables or API routes yet (see the
// note at the top of timeEntries.ts). Line items here take a plain, already-
// computed amount rather than importing from the sibling time/cost files, so
// this module has no dependency on c77's or c78's (not-yet-merged) exports —
// a future integration step wires the real time-entry/cost IDs in as
// `sourceId` once all four PRs have landed, the same way PR #40 wired
// multiple engine PRs together in one pass.

import { parseCents, sumCents, type Cents } from "./money";

export const INVOICE_STATUSES = ["draft", "lawyer_reviewed", "sent", "void"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const INVOICE_LINE_KINDS = ["time", "cost", "fixed_fee_installment", "adjustment"] as const;
export type InvoiceLineKind = (typeof INVOICE_LINE_KINDS)[number];

export class InvoiceError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "InvoiceError";
  }
}

export interface InvoiceLineItemInput {
  kind: InvoiceLineKind;
  description: string;
  /** Already computed upstream (by the time/cost engines); validated, not recomputed, here. */
  amountCents: Cents;
  /** A time entry or cost id, once those tables exist (deferred to the integration step). */
  sourceId?: string | null;
  quantity?: number | null;
}

export interface InvoiceLineItem extends InvoiceLineItemInput {
  id: string;
  originalAmountCents: Cents;
  writeDownReason: string | null;
}

export interface Invoice {
  id: string;
  tenantId: string;
  matterId: string;
  number: number;
  status: InvoiceStatus;
  lineItems: InvoiceLineItem[];
  subtotalCents: Cents;
  voidReason: string | null;
  lawyerReviewedByUserId: string | null;
  lawyerReviewedAt: Date | null;
  sentAt: Date | null;
  createdAt: Date;
}

function validateLine(line: InvoiceLineItemInput, index: number): void {
  if (!line.description.trim()) throw new InvoiceError("DESCRIPTION_REQUIRED", `Line item ${index + 1} needs a description.`);
  const amount = parseCents(line.amountCents, `lineItems[${index}].amountCents`);
  if (amount < 0n) throw new InvoiceError("INVALID_AMOUNT", `Line item ${index + 1} amount cannot be negative.`);
}

/** Invoice numbers are sequential and never reused, including for voided invoices. */
export function nextInvoiceNumber(lastUsedNumber: number): number {
  if (!Number.isInteger(lastUsedNumber) || lastUsedNumber < 0) {
    throw new InvoiceError("INVALID_NUMBER", "lastUsedNumber must be zero or a positive whole number.");
  }
  return lastUsedNumber + 1;
}

export interface BuildDraftInvoiceInput {
  tenantId: string;
  matterId: string;
  number: number;
  lineItems: InvoiceLineItemInput[];
}

/** Every invoice starts as a draft the responsible lawyer reviews before it goes out — see markLawyerReviewed/markSent. */
export function buildDraftInvoice(input: BuildDraftInvoiceInput, now: Date = new Date()): Omit<Invoice, "id"> {
  if (input.lineItems.length === 0) throw new InvoiceError("NO_LINE_ITEMS", "An invoice needs at least one line item.");
  input.lineItems.forEach(validateLine);
  const lineItems: InvoiceLineItem[] = input.lineItems.map((line) => ({
    ...line,
    id: "", // assigned by the caller's persistence layer
    originalAmountCents: parseCents(line.amountCents),
    writeDownReason: null,
  }));
  const subtotalCents = sumCents(lineItems.map((l) => l.amountCents));
  return {
    tenantId: input.tenantId,
    matterId: input.matterId,
    number: input.number,
    status: "draft",
    lineItems,
    subtotalCents,
    voidReason: null,
    lawyerReviewedByUserId: null,
    lawyerReviewedAt: null,
    sentAt: null,
    createdAt: now,
  };
}

/** A lawyer may write a line DOWN (never up) before sending, with a reason recorded — the original line is never silently edited. */
export function writeDownLine(
  invoice: Pick<Invoice, "status" | "lineItems">,
  lineItemId: string,
  newAmountCents: Cents,
  reason: string
): InvoiceLineItem[] {
  if (invoice.status !== "draft") throw new InvoiceError("INVALID_TRANSITION", "Only a draft invoice's lines can be adjusted.");
  if (!reason.trim()) throw new InvoiceError("REASON_REQUIRED", "A reason is required to write down a line item.");
  const line = invoice.lineItems.find((l) => l.id === lineItemId);
  if (!line) throw new InvoiceError("NOT_FOUND", `Line item '${lineItemId}' not found on this invoice.`);
  if (newAmountCents < 0n) throw new InvoiceError("INVALID_AMOUNT", "A line item cannot be written down below zero.");
  if (newAmountCents > line.originalAmountCents) {
    throw new InvoiceError("INVALID_AMOUNT", "A line item can only be written down, never increased above its original amount.");
  }
  return invoice.lineItems.map((l) => (l.id === lineItemId ? { ...l, amountCents: newAmountCents, writeDownReason: reason } : l));
}

export function recomputeSubtotal(lineItems: Pick<InvoiceLineItem, "amountCents">[]): Cents {
  return sumCents(lineItems.map((l) => l.amountCents));
}

/** draft -> lawyer_reviewed. Nothing can be sent before this. */
export function markLawyerReviewed(
  invoice: Pick<Invoice, "status">,
  reviewerUserId: string,
  now: Date = new Date()
): { status: "lawyer_reviewed"; lawyerReviewedByUserId: string; lawyerReviewedAt: Date } {
  if (invoice.status !== "draft") {
    throw new InvoiceError("INVALID_TRANSITION", `Only a draft invoice can be marked lawyer-reviewed (was '${invoice.status}').`);
  }
  return { status: "lawyer_reviewed", lawyerReviewedByUserId: reviewerUserId, lawyerReviewedAt: now };
}

export function markSent(invoice: Pick<Invoice, "status">, now: Date = new Date()): { status: "sent"; sentAt: Date } {
  if (invoice.status !== "lawyer_reviewed") {
    throw new InvoiceError("INVALID_TRANSITION", "An invoice must be lawyer-reviewed before it can be sent.");
  }
  return { status: "sent", sentAt: now };
}

/** Invoices are numbered and never deleted — voiding records the fact and the reason instead. */
export function voidInvoice(invoice: Pick<Invoice, "status">, reason: string): { status: "void"; voidReason: string } {
  if (invoice.status === "void") throw new InvoiceError("INVALID_TRANSITION", "This invoice is already void.");
  if (!reason.trim()) throw new InvoiceError("REASON_REQUIRED", "A reason is required to void an invoice.");
  return { status: "void", voidReason: reason };
}

export interface TrustSplit {
  fromTrustCents: Cents;
  amountDueCents: Cents;
}

/**
 * How much of this invoice's subtotal CAN be covered by the client's current
 * trust balance vs. billed directly — plain arithmetic, nothing more. This
 * is NOT the $4,500 retainer-floor rule (c50) or the fixed-fee earned-basis
 * rule (c52); both stay gated behind attorney/CPA review of the
 * trust-accounting compliance research (c75) and are intentionally not
 * applied here. Any code that actually moves money out of trust against
 * this split must still go through the trust ledger (c76) and its own
 * requireApproval gate — this function only tells the UI/lawyer what the
 * split COULD be.
 */
export function computeAmountDueFromTrust(subtotalCents: Cents, trustBalanceCents: Cents): TrustSplit {
  if (subtotalCents <= 0n) throw new InvoiceError("INVALID_AMOUNT", "subtotalCents must be more than zero.");
  if (trustBalanceCents < 0n) throw new InvoiceError("INVALID_AMOUNT", "trustBalanceCents cannot be negative.");
  const fromTrustCents = trustBalanceCents >= subtotalCents ? subtotalCents : trustBalanceCents;
  const amountDueCents = subtotalCents - fromTrustCents;
  return { fromTrustCents, amountDueCents };
}
