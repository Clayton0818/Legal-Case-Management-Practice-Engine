// Cross-field validation on top of mapping.ts's per-field parsing. mapRow
// already catches "blank" and "unparseable"; this catches values that
// parsed fine on their own but don't make sense together (a negative hours
// entry, a contact with neither email nor phone, a trust balance dated in
// the future, etc). Every function here is pure — no I/O.

import type { ImportIssue, ImportRecordKind } from "./types";
import type { NormalizedContact, NormalizedMatter, NormalizedTimeEntry, NormalizedInvoice, NormalizedTrustBalance } from "./entities";

function issue(rowNumber: number, recordKind: ImportRecordKind, severity: "error" | "warning", code: string, message: string, field?: string): ImportIssue {
  return { rowNumber, recordKind, severity, code, message, ...(field ? { field } : {}) };
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateContact(rowNumber: number, contact: Partial<NormalizedContact>): ImportIssue[] {
  const issues: ImportIssue[] = [];
  if (contact.email && !EMAIL_PATTERN.test(contact.email)) {
    issues.push(issue(rowNumber, "contact", "warning", "implausible_email", `"${contact.email}" doesn't look like a valid email address.`, "email"));
  }
  if (!contact.email && !contact.phone) {
    issues.push(issue(rowNumber, "contact", "warning", "no_contact_method", "Contact has neither an email nor a phone number on file."));
  }
  return issues;
}

export function validateMatter(rowNumber: number, matter: Partial<NormalizedMatter>, now: Date): ImportIssue[] {
  const issues: ImportIssue[] = [];
  if (matter.openedAt && matter.openedAt.getTime() > now.getTime()) {
    issues.push(issue(rowNumber, "matter", "error", "future_open_date", `Matter's open date (${matter.openedAt.toISOString().slice(0, 10)}) is in the future.`, "openedAt"));
  }
  return issues;
}

export function validateTimeEntry(rowNumber: number, entry: Partial<NormalizedTimeEntry>, now: Date): ImportIssue[] {
  const issues: ImportIssue[] = [];
  if (entry.hours !== undefined) {
    if (entry.hours < 0) {
      issues.push(issue(rowNumber, "time_entry", "error", "negative_hours", `Time entry has negative hours (${entry.hours}).`, "hours"));
    } else if (entry.hours > 24) {
      issues.push(issue(rowNumber, "time_entry", "warning", "implausible_hours", `Time entry claims ${entry.hours} hours in a single entry — confirm this wasn't meant to be split across days.`, "hours"));
    }
  }
  if (entry.date && entry.date.getTime() > now.getTime()) {
    issues.push(issue(rowNumber, "time_entry", "error", "future_date", "Time entry is dated in the future.", "date"));
  }
  return issues;
}

export function validateInvoice(rowNumber: number, invoice: Partial<NormalizedInvoice>): ImportIssue[] {
  const issues: ImportIssue[] = [];
  if (invoice.totalCents !== undefined && invoice.totalCents < 0) {
    issues.push(issue(rowNumber, "invoice", "error", "negative_total", `Invoice total is negative (${invoice.totalCents} cents).`, "totalCents"));
  }
  return issues;
}

/**
 * Trust balances get the strictest checks of any record kind — this is
 * client money. A negative imported balance is always an error (the hard
 * rule elsewhere in this track: a trust balance can never go negative), and
 * a balance dated more than a day in the future is rejected outright rather
 * than warned about, since "future trust balance" almost always means a
 * date-column mapping mistake, not real data.
 */
export function validateTrustBalance(rowNumber: number, balance: Partial<NormalizedTrustBalance>, now: Date): ImportIssue[] {
  const issues: ImportIssue[] = [];
  if (balance.balanceCents !== undefined && balance.balanceCents < 0) {
    issues.push(issue(rowNumber, "trust_balance", "error", "negative_trust_balance", `Imported trust balance is negative (${balance.balanceCents} cents) — a trust balance can never go negative.`, "balanceCents"));
  }
  if (balance.asOfDate && balance.asOfDate.getTime() > now.getTime() + 24 * 60 * 60 * 1000) {
    issues.push(issue(rowNumber, "trust_balance", "error", "future_as_of_date", "Trust balance's 'as of' date is in the future — check the date column mapping.", "asOfDate"));
  }
  return issues;
}
