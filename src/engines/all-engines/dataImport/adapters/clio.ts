// Default column mappings for Clio's CSV exports.
//
// IMPORTANT: Clio's exact export headers are not verified against a live
// Clio account in this change — they're built from Clio's publicly
// documented field names (Contacts: Display Number, Type, First Name, Last
// Name/Company Name, Email, Phone Number; Matters: Display Number, Client,
// Matter Description, Practice Area, Status, Open Date; trust activity via
// Clio's Trust Ledger / Trust Request Report export). Treat every mapping
// below as a documented GUESS to be confirmed against a real sample export
// during the dry run for each firm's actual migration — the dry-run report
// (types.ts) is exactly the mechanism for catching a wrong guess before
// anything is imported, by surfacing columns that didn't map to anything
// usable. Open question flagged in docs/product/features/all-engines/c98-data-import.md.

import type { ColumnMapping } from "../mapping";
import { parseExportDate, parseMoneyToCents } from "../mapping";
import type { NormalizedContact, NormalizedMatter, NormalizedTrustBalance } from "../entities";

function joinName(fields: Record<string, string>): string | undefined {
  const company = fields["Company Name"]?.trim();
  if (company) return company;
  const first = fields["First Name"]?.trim() ?? "";
  const last = fields["Last Name"]?.trim() ?? "";
  const full = `${first} ${last}`.trim();
  return full || undefined;
}

export const CLIO_CONTACT_MAPPING: ColumnMapping<NormalizedContact> = {
  externalId: { source: "Display Number" },
  fullName: { source: joinName, required: true },
  email: { source: "Email" },
  phone: { source: "Phone Number" },
  isOrganization: { source: "Type", parse: (raw) => /company|organization/i.test(raw) },
};

export const CLIO_MATTER_MAPPING: ColumnMapping<NormalizedMatter> = {
  externalId: { source: "Display Number" },
  clientExternalId: { source: "Client Display Number", required: true },
  matterName: { source: "Matter Description", required: true },
  practiceArea: { source: "Practice Area" },
  status: { source: "Status" },
  openedAt: { source: "Open Date", parse: parseExportDate },
};

/** Clio's Trust Ledger / Trust Request Report export, one row per client's running balance as of the report date. */
export const CLIO_TRUST_BALANCE_MAPPING: ColumnMapping<NormalizedTrustBalance> = {
  clientExternalId: { source: "Client Display Number", required: true },
  matterExternalId: { source: "Matter Display Number" },
  balanceCents: { source: "Trust Balance", required: true, parse: parseMoneyToCents },
  asOfDate: { source: "As Of Date", required: true, parse: parseExportDate },
};
