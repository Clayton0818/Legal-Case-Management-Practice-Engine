# c114 — LEDES/UTBMS e-billing codes for insurance-defense and corporate clients

Status: draft product spec, grounded in current public documentation of the
LEDES/UTBMS standards (sources at bottom). Not legal or accounting advice;
nothing here touches trust-money rules, so it does not depend on the
`rules.trust_accounting` gate the other billing-trust cards wait on.

## The gap this closes

c75–c83 built trust accounting, time entries, costs and invoicing, but
none of it tags time or expense lines with a standardized code, and the
shipped invoice format (c79, `invoices.ts`) isn't a LEDES file. An
insurance-defense carrier or corporate legal-ops client typically **requires**
invoices in LEDES format with UTBMS codes on every line; without that, their
e-billing system rejects the invoice outright regardless of whether the
work and the number are correct. This only matters once the firm's client
mix includes insurance-defense or corporate work — real gap, not urgent
for a Family-Law-only pilot (c103).

## What UTBMS and LEDES actually are (background, for the spec below)

**UTBMS** (Uniform Task-Based Management System) is a set of standardized
codes for categorizing legal work and expenses, originally developed by the
ABA Section of Litigation, the American Corporate Counsel Association, major
corporate clients and law firms, with Price Waterhouse's support; the LEDES
Oversight Committee (LOC) now maintains it. Three code families matter here:

- **Task codes** — phase/task of the matter. Several sets exist by matter
  type: Litigation (`L1xx`–`L5xx`, e.g. `L100` Case Assessment, `L300`
  Discovery, `L400` Trial Preparation and Trial), plus separate sets for
  Patent/Trademark IP (`PA`/`TR` prefixes), Counseling (`C`), Project (`P`)
  and Bankruptcy (`B`). Which set applies depends on the matter's nature —
  this is a firm/matter-level choice, not a global one.
- **Activity codes** (`A1xx`) — the kind of work performed within a task,
  e.g. `A101` Plan and prepare for, `A102` Research, `A103` Draft/Revise,
  `A104` Review/Analyze, `A106` Communicate with client. Revised in 2013.
- **Expense codes** — originally `E1xx` (e.g. `E101` Copying, `E110`
  Out-of-town travel), replaced in 2013 by `X1xx` (`X101` Copies, `X115`
  Out-of-Town Travel, `X117` Court Fees) plus newer `X2xx` (IP), `X3xx`
  (eDiscovery) and `X4xx` (software/hosting) series. Expense codes don't
  depend on phase/task/activity.

**LEDES** (Legal Electronic Data Exchange Standard) is the invoice *file
format* that carries these codes between firm and client billing systems.
The LOC created and maintains it. Relevant versions:

- **LEDES 1998B** — pipe-delimited, 24 fields. Still the most widely used
  e-billing format in the US legal industry; this is the format most
  insurance-defense carriers will ask for.
- **LEDES XML 2.0 / 2.1** — later, richer XML formats (153–191 data
  elements) supporting alternative fee arrangements and more granular
  line detail. Some corporate clients require XML instead of 1998B.

Clients generally only require UTBMS coding when they also require
e-billing in a LEDES format — the two travel together in practice, which is
why this card bundles both.

## What this spec proposes building

1. **A `utbmsCode` field on time entries and cost entries**
   (`src/engines/billing-trust/timeEntries.ts`, `costs.ts`), optional and
   off by default. When a matter's client requires e-billing, the lawyer
   (or an AI-suggested code the lawyer confirms — this is categorization,
   not legal advice, but still gets a human check per the "AI never
   decides" house rule) tags each line with a task + activity code (or an
   expense code for cost entries) from the applicable set.
2. **A per-matter "e-billing requirement" flag** (firm/client setting)
   that determines: (a) whether UTBMS tagging is required before an invoice
   can be finalized for that matter, and (b) which LEDES version the export
   uses.
3. **A LEDES export** from the existing invoice data (c79) — 1998B first
   (pipe-delimited, mapping the firm's existing invoice line fields plus the
   new UTBMS codes into the 24-field layout), XML 2.1 as a later iteration
   once a real carrier/client asks for it. This is export-only: it reads
   already-approved, already-invoiced data and reformats it; it never
   changes billing logic or trust posting.
4. **Validation before export**: every line on an e-billing-required
   invoice must carry a valid code from the matter's chosen set, or export
   is refused with a list of the offending lines — better to catch a
   missing code before the carrier's system rejects the whole invoice.

## What this explicitly does not touch

- No change to trust accounting, the ledger, or any `rules.trust_accounting`
  gated path — this is a tagging-and-export feature on top of already-
  invoiced, already-approved amounts.
- No change to how the *amount* on an invoice is computed — UTBMS codes
  describe the work, they don't change the price.
- Does not pick a specific LEDES-export vendor/library; `X12`/LEDES parsing
  libraries exist but choosing one is an engineering decision for whoever
  builds this, not a product one.

## Data model note (no migration in this PR)

Adds `utbmsTaskCode`, `utbmsActivityCode` (time entries) and
`utbmsExpenseCode` (cost entries) nullable text columns, plus a small lookup
table of valid codes per set (so the UI can offer a picker and validation can
check membership) under `src/db/tables/billing-trust.ts`. No change to any
existing table's constraints.

## Open questions for human review

1. Which UTBMS task-code set(s) the firm needs at launch — likely none for
   a Family-Law-only pilot (c103), so this card may stay dormant in
   practice until the firm mix includes insurance-defense/corporate work;
   flagging so it isn't built ahead of actual need.
2. LEDES 1998B field-by-field mapping needs a firm's actual sample invoice
   (or a specific carrier's spec) to validate against — this spec describes
   the format at a level sourced from public documentation, not a verified
   field-by-field mapping.
3. Whether AI-suggested UTBMS coding is wanted at all, given it adds an
   extra human-confirmation step to the time-entry flow — could ship
   manual-only first.

## Sources

- [Uniform Task-Based Management System — Wikipedia](https://en.wikipedia.org/wiki/Uniform_Task-Based_Management_System)
- [What is LEDES format — Thomson Reuters](https://legal.thomsonreuters.com/en/insights/articles/what-is-ledes-format)
