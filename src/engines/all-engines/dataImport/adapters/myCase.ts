// Default column mappings for MyCase's CSV exports.
//
// Same caveat as clio.ts: MyCase's exact export headers are not verified
// against a live account here — built from MyCase's publicly documented
// contact/case export fields (Contacts: First Name, Last Name, Company,
// Email, Phone; Cases: Case Name, Case Number, Client, Practice Area, Status,
// Open Date; trust via MyCase's Trust Accounting → Trust Ledger Report
// export). Confirm against a real sample export during each firm's dry run.

import type { ColumnMapping } from "../mapping";
import { parseExportDate, parseMoneyToCents } from "../mapping";
import type { NormalizedContact, NormalizedMatter, NormalizedTrustBalance } from "../entities";

function joinName(fields: Record<string, string>): string | undefined {
  const company = fields["Company"]?.trim();
  if (company) return company;
  const first = fields["First Name"]?.trim() ?? "";
  const last = fields["Last Name"]?.trim() ?? "";
  const full = `${first} ${last}`.trim();
  return full || undefined;
}

export const MYCASE_CONTACT_MAPPING: ColumnMapping<NormalizedContact> = {
  externalId: { source: "Contact ID" },
  fullName: { source: joinName, required: true },
  email: { source: "Email" },
  phone: { source: "Phone" },
  isOrganization: { source: "Company", parse: (raw) => raw.trim().length > 0 },
};

export const MYCASE_MATTER_MAPPING: ColumnMapping<NormalizedMatter> = {
  externalId: { source: "Case Number" },
  clientExternalId: { source: "Client", required: true },
  matterName: { source: "Case Name", required: true },
  practiceArea: { source: "Practice Area" },
  status: { source: "Status" },
  openedAt: { source: "Open Date", parse: parseExportDate },
};

export const MYCASE_TRUST_BALANCE_MAPPING: ColumnMapping<NormalizedTrustBalance> = {
  clientExternalId: { source: "Client", required: true },
  matterExternalId: { source: "Case Number" },
  balanceCents: { source: "Trust Balance", required: true, parse: parseMoneyToCents },
  asOfDate: { source: "Report Date", required: true, parse: parseExportDate },
};
