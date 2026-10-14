// Time tracking (c77): timers and AI-suggested entries, the lawyer approves
// each before anything is billed. Pure domain logic + tests only in this PR —
// no new tables or API routes yet. c77, c78, c79 and c81 all landed as
// separate same-day PRs against main per the Product-parallel rule
// (CLAUDE.md, 2026-10-01); each adds only new files under its own path to
// avoid four PRs racing to edit the same shared engine file (the same reason
// migrations for this engine are generated once at an integration step, not
// per card — see PR #40's "Migration 0003" step for the precedent). Tables
// for time entries, and the API routes that use this module, are deferred to
// that follow-up integration step once all of this run's Product cards have
// landed.
//
// Nothing here moves trust money or decides a legal question. It is not
// listed against rules.trust_accounting (src/compliance/gates.ts) — building
// invoices from approved time is c79's job, and any actual trust posting
// goes through the trust ledger (c76) and ITS OWN requireApproval gate.

import { requireApproval } from "@/compliance/approvals";
import { VENDOR_GATES } from "@/compliance/gates";
import { parseCents, type Cents } from "./money";

export const TIME_ENTRY_STATUSES = ["draft", "approved", "billed", "written_off"] as const;
export type TimeEntryStatus = (typeof TIME_ENTRY_STATUSES)[number];

export const TIME_ENTRY_SOURCES = ["manual", "timer", "ai_suggested"] as const;
export type TimeEntrySource = (typeof TIME_ENTRY_SOURCES)[number];

export class TimeEntryError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "TimeEntryError";
  }
}

export interface TimeEntryInput {
  matterId: string;
  userId: string;
  activityCode: string;
  billable: boolean;
  durationMinutes: number;
  description: string;
  source: TimeEntrySource;
  aiConfidence?: number | null;
  startedAt?: Date | null;
}

export interface TimeEntry extends TimeEntryInput {
  id: string;
  tenantId: string;
  status: TimeEntryStatus;
  billedMinutes: number;
  rateCentsPerHour: Cents;
  amountCents: Cents;
  approvedByUserId: string | null;
  approvedAt: Date | null;
  createdAt: Date;
}

/** Firm-set in reality (engineSettings['billing-trust']); a reasonable default while that wiring lands. 6 minutes = 0.1 hour. */
const DEFAULT_INCREMENT_MINUTES = 6;

/** Round UP to the nearest billing increment — standard timekeeping practice; never rounds down a lawyer's time. */
export function roundUpToIncrement(minutes: number, incrementMinutes: number): number {
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new TimeEntryError("INVALID_DURATION", "Duration must be zero or more minutes.");
  }
  if (!Number.isInteger(incrementMinutes) || incrementMinutes <= 0) {
    throw new TimeEntryError("INVALID_INCREMENT", "Billing increment must be a positive whole number of minutes.");
  }
  if (minutes === 0) return 0;
  return Math.ceil(minutes / incrementMinutes) * incrementMinutes;
}

function assertNonNegativeRate(v: Cents): Cents {
  if (v < 0n) throw new TimeEntryError("INVALID_RATE", "Rate must be zero or more.");
  return v;
}

/** billedMinutes * rateCentsPerHour / 60, rounded half up. Integer bigint math throughout — never a float. */
export function computeAmountCents(billedMinutes: number, rateCentsPerHour: Cents): Cents {
  if (!Number.isInteger(billedMinutes) || billedMinutes < 0) {
    throw new TimeEntryError("INVALID_DURATION", "Billed minutes must be a whole number, zero or more.");
  }
  const rate = assertNonNegativeRate(rateCentsPerHour);
  const minutesPerHour = 60n;
  const numerator = BigInt(billedMinutes) * rate;
  const q = numerator / minutesPerHour;
  const r = numerator % minutesPerHour;
  return r * 2n >= minutesPerHour ? q + 1n : q;
}

export interface ManualEntryInput extends Omit<TimeEntryInput, "source"> {
  rateCentsPerHour: Cents;
  incrementMinutes?: number;
}

export function draftManualEntry(input: ManualEntryInput): { billedMinutes: number; amountCents: Cents } {
  const increment = input.incrementMinutes ?? DEFAULT_INCREMENT_MINUTES;
  const billedMinutes = roundUpToIncrement(input.durationMinutes, increment);
  const amountCents = computeAmountCents(billedMinutes, parseCents(input.rateCentsPerHour, "rateCentsPerHour"));
  return { billedMinutes, amountCents };
}

export type ActivitySignal = "email_sent" | "document_drafted" | "call_logged" | "court_appearance";

const ACTIVITY_CODE_BY_SIGNAL: Record<ActivitySignal, string> = {
  email_sent: "correspondence",
  document_drafted: "drafting",
  call_logged: "communication",
  court_appearance: "court_appearance",
};

export interface AiSuggestionInput {
  tenantId: string;
  matterId: string;
  userId: string;
  signal: ActivitySignal;
  observedDurationMinutes: number;
  description: string;
  rateCentsPerHour: Cents;
  incrementMinutes?: number;
  /** 0..1. The AI's own confidence in the suggestion; never used to skip lawyer review. */
  confidence: number;
}

/**
 * Gate the AI model call itself (vendor.ai_model — c77 is one of this gate's
 * listed cards, src/compliance/gates.ts). ADR-0001 D9: no real model call
 * reaches client data before a vendor DPA with no-training/retention terms is
 * signed. Throws PendingApprovalError until then — never a silent fallback.
 */
export function requireAiModelApproval(tenantId: string): void {
  requireApproval(VENDOR_GATES.aiModel.key, {
    action: "billing-trust.time_entry.ai_suggest",
    tenantId,
  });
}

/**
 * Build an AI-suggested time entry. Always comes back status "draft" — per
 * src/engines/README.md, "nothing is billed until the lawyer reviews and
 * approves each entry," so this module has no path that produces anything
 * other than a draft from this function.
 */
export function buildAiSuggestedEntry(input: AiSuggestionInput): Omit<TimeEntry, "id" | "tenantId" | "createdAt"> {
  requireAiModelApproval(input.tenantId);
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new TimeEntryError("INVALID_CONFIDENCE", "AI confidence must be a number between 0 and 1.");
  }
  const increment = input.incrementMinutes ?? DEFAULT_INCREMENT_MINUTES;
  const billedMinutes = roundUpToIncrement(input.observedDurationMinutes, increment);
  const rate = parseCents(input.rateCentsPerHour, "rateCentsPerHour");
  const amountCents = computeAmountCents(billedMinutes, rate);
  return {
    matterId: input.matterId,
    userId: input.userId,
    activityCode: ACTIVITY_CODE_BY_SIGNAL[input.signal],
    billable: true,
    durationMinutes: input.observedDurationMinutes,
    description: input.description,
    source: "ai_suggested",
    aiConfidence: input.confidence,
    startedAt: null,
    status: "draft",
    billedMinutes,
    rateCentsPerHour: rate,
    amountCents,
    approvedByUserId: null,
    approvedAt: null,
  };
}

/** Passed in rather than imported: c60 (ethical screens) has not shipped yet. Callers wire the real check once it exists. */
export interface ScreenCheck {
  isMatterScreenedForUser(matterId: string, userId: string): boolean;
}

/**
 * Approve a draft entry. Refuses on a screened matter — Rule 1.10(a)(2) and
 * Rule 1.18(d) both require a screened lawyer to take NO part of the fee on
 * that matter (c55 §5/§6), so this is a hard, system-enforced block rather
 * than a policy reminder.
 */
export function approveTimeEntry(
  entry: Pick<TimeEntry, "status" | "matterId" | "userId">,
  approverUserId: string,
  screenCheck: ScreenCheck,
  now: Date = new Date()
): { status: "approved"; approvedByUserId: string; approvedAt: Date } {
  if (entry.status !== "draft") {
    throw new TimeEntryError("INVALID_TRANSITION", `Only a draft entry can be approved (was '${entry.status}').`);
  }
  if (screenCheck.isMatterScreenedForUser(entry.matterId, entry.userId)) {
    throw new TimeEntryError("SCREENED_MATTER", "This lawyer is screened from this matter and cannot bill time to it.");
  }
  return { status: "approved", approvedByUserId: approverUserId, approvedAt: now };
}

export function markTimeEntryBilled(entry: Pick<TimeEntry, "status">, invoiceId: string): { status: "billed" } {
  if (entry.status !== "approved") {
    throw new TimeEntryError("INVALID_TRANSITION", `Only an approved entry can be billed (was '${entry.status}').`);
  }
  if (!invoiceId) throw new TimeEntryError("INVOICE_REQUIRED", "An invoice id is required to mark a time entry billed.");
  return { status: "billed" };
}

export function writeOffTimeEntry(entry: Pick<TimeEntry, "status">, reason: string): { status: "written_off" } {
  if (entry.status === "billed") {
    throw new TimeEntryError("INVALID_TRANSITION", "A billed entry cannot be written off; void the invoice instead.");
  }
  if (!reason.trim()) throw new TimeEntryError("REASON_REQUIRED", "A reason is required to write off a time entry.");
  return { status: "written_off" };
}
