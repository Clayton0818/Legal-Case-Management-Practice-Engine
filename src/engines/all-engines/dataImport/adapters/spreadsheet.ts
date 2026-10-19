// The spreadsheet adapter has no fixed header set — every firm's "export to
// Excel" sheet is different. Instead of guessing, it suggests a mapping from
// whatever headers the file actually has (mapping.ts's suggestMapping) and
// lets staff confirm or correct every field before anything is parsed.

import type { ColumnMapping, TargetFieldHint } from "../mapping";
import { suggestMapping } from "../mapping";

/** Target field hints for each record kind this import pipeline understands (c98's scope: contacts, matters, trust balances). */
export const SPREADSHEET_TARGET_HINTS: Record<"contact" | "matter" | "trust_balance", TargetFieldHint[]> = {
  contact: [
    { field: "fullName", synonyms: ["name", "client name", "full name"] },
    { field: "email", synonyms: ["e-mail", "email address"] },
    { field: "phone", synonyms: ["phone number", "telephone"] },
  ],
  matter: [
    { field: "matterName", synonyms: ["matter", "case name", "matter description"] },
    { field: "clientExternalId", synonyms: ["client", "client id", "client number"] },
    { field: "practiceArea", synonyms: ["practice area", "area of law"] },
    { field: "openedAt", synonyms: ["open date", "date opened"] },
  ],
  trust_balance: [
    { field: "clientExternalId", synonyms: ["client", "client id", "client number"] },
    { field: "balanceCents", synonyms: ["trust balance", "balance", "amount"] },
    { field: "asOfDate", synonyms: ["as of date", "report date", "date"] },
  ],
};

/** A staff-confirmed header choice for one target field (null header means "leave unmapped"). */
export interface ConfirmedFieldMapping {
  field: string;
  header: string | null;
}

/**
 * Build an actual ColumnMapping<T> from the headers in a file plus staff's
 * confirmed choices (which default to suggestMapping's best guess — see
 * confirmSuggestedMapping below — but must be explicitly confirmed, never
 * auto-applied silently for a spreadsheet with no known structure).
 */
export function buildSpreadsheetMapping<T extends Record<string, unknown>>(
  confirmed: readonly ConfirmedFieldMapping[],
  requiredFields: readonly string[],
  parsers: Partial<Record<string, (raw: string) => unknown>> = {}
): ColumnMapping<T> {
  const mapping = {} as ColumnMapping<T>;
  for (const { field, header } of confirmed) {
    if (!header) continue;
    (mapping as Record<string, unknown>)[field] = {
      source: header,
      required: requiredFields.includes(field),
      parse: parsers[field],
    };
  }
  return mapping;
}

/** Turn suggestMapping's output into the ConfirmedFieldMapping shape, as a starting point for staff to review — not a final answer. */
export function suggestSpreadsheetMapping(headers: readonly string[], hints: readonly TargetFieldHint[]): ConfirmedFieldMapping[] {
  return suggestMapping(headers, hints).map((s) => ({ field: s.field, header: s.confidence > 0 ? s.header : null }));
}
