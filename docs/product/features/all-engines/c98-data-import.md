# c98 — Firm data import (Clio, MyCase, spreadsheets)

## What shipped in this PR

A staged, reviewable import pipeline under `src/engines/all-engines/dataImport/`:

- **`csv.ts`** — a small RFC-4180-ish CSV parser (quoted fields, embedded
  commas/newlines, escaped quotes, CRLF) and a header-keyed row reader.
- **`mapping.ts`** — a generic `mapRow()` that turns one raw row into a
  typed object from a declarative `ColumnMapping`, collecting per-field
  issues (missing required field, unparseable value) instead of throwing;
  plus money/date parsers and a fuzzy header-to-field `suggestMapping()` for
  files with no fixed header set.
- **`adapters/clio.ts`, `adapters/myCase.ts`** — default column mappings for
  Clio and MyCase CSV exports (contacts, matters, trust balance reports).
  **These header names are a documented best guess from each vendor's public
  export documentation, not verified against a live export** — see "Open
  questions" below. The dry-run report is exactly the safety net for a wrong
  guess: a mapping that's off will show up as a wall of `required_field_missing`
  issues before anything is imported, not as silently wrong data.
- **`adapters/spreadsheet.ts`** — no fixed headers; suggests a mapping from
  whatever columns the file has and builds a real `ColumnMapping` from
  staff's confirmed choices.
- **`validate.ts`** — cross-field checks mapping alone can't catch: future
  dates, negative hours, implausible single time entries, and — strictest
  of all — a negative trust balance or a future-dated trust "as of" date.
- **`reconciliation.ts`** — the card's central requirement: compares every
  imported trust balance against the old system's own reported balance, to
  the penny, by client+matter. Any row present on only one side, or off by
  even a cent, is a mismatch, surfaced rather than rounded away. Committing
  a reconciled balance is gated on the existing `rules.trust_accounting`
  gate (attorney + CPA) via `requireTrustBalanceImportApproval()`.
- **`service.ts`** — the DB-backed orchestration: stage a batch
  (`createImportBatch`), block sign-off while any row has an error
  (`recordFirmSignoff`), or reject the whole batch (`rejectImportBatch`),
  then execute an approved batch (`executeImportBatch`).
- **`import_batches` / `import_rows`** tables (`src/db/tables/all-engines.ts`)
  — every batch and every row kept as an audit trail, never deleted.

## The engine-boundary decision this PR makes, and why

`src/engines/README.md` is explicit: an engine never imports another
engine's code or tables. Contacts (`parties`) are a genuinely shared
foundation table — `src/engines/all-engines/allEngines.db.test.ts` already
inserts into `parties` and `matters` directly from this engine, which is
good evidence `parties` is fair game. This PR creates `parties` rows
directly for imported contacts.

It does **not** do the same for matters, documents, calendar events, time
entries, invoices or trust balances. Two different reasons:

- **Matters, documents, calendar events** are plausibly shared/foundation
  tables too, but this PR doesn't have a verified column mapping for them
  (in particular: what the matter title/description column is actually
  called, and what status a freshly-imported matter should default to).
  Guessing wrong on a write is worse than one extra hop.
- **Time entries, invoices, trust balances** are the billing-trust engine's
  own tables (`src/db/tables/billing-trust.ts`), not foundation — this
  engine is not allowed to write there at all.

So every kind except `contact` is handed off as a `tasks` row
(`kind: "all-engines.import.create_<kind>"`, owner `{ type: "firm" }`,
metadata carrying the normalized data plus, for anything tied to a client,
the `parties.id` this batch already resolved) for whichever engine owns
that kind of record to pick up with its own, authoritative field mapping.
This is the same cross-engine cooperation pattern `src/engines/README.md`
already documents for the intake → calendar-alerts hand-off.

## What's deliberately NOT built here

- Document/calendar-event/time-entry/invoice *creation* — handed off as
  tasks, as above; the owning engine still needs to add a
  `all-engines.import.create_<kind>` handler to its own `worker.ts` to
  actually consume them. Flagged below.
- Any UI (admin pages for uploading a file, reviewing the dry-run report,
  clicking "sign off") — this PR is the engine/service layer only.
- LEDES/UTBMS-aware invoice import, or any Clio/MyCase-specific OAuth/API
  integration — this is file-export import (CSV) only, per the card's own
  "Clio, MyCase or spreadsheets" scope.

## Limitations (couldn't verify in this environment)

- No Node/database setup here, so `npm run typecheck`, `npm run lint` and
  `npm test` were not run against this change. Every cross-module signature
  used (`createTask`, `audit`, `normalizeName`, the `parties`/`matters`
  columns referenced in the existing db test) was checked against the
  current source on `main` before use, but this should run in CI before
  merge.
- `service.db.test.ts` needs a real Postgres with `import_batches`/
  `import_rows` migrated; it's skipped otherwise, same pattern as
  `allEngines.db.test.ts` and `foundation.db.test.ts`.

## Open questions for human review

1. **Clio and MyCase header names are unverified** against a live export of
   either product. Confirm against a real sample file (or each vendor's
   current export documentation) before any live migration; the dry-run
   report's `required_field_missing` issues are the mechanism for catching a
   wrong guess, but a human still needs to run that dry run against a real
   file at least once.
2. Which engines need a `all-engines.import.create_<kind>` worker handler,
   and in what order — at minimum, whoever owns matter creation (intake?)
   and billing-trust (for time entries, invoices, trust balances).
3. Whether `rows.status = 'handed_off'` needs a way to later confirm the
   receiving engine actually completed the task (currently this only
   records that the task was created, not that it was acted on) — could
   reuse `tasks.status` via a join rather than duplicating it.
4. CPA review of the trust-balance reconciliation logic itself (to-the-penny
   comparison, keyed by client+matter) before any firm's real trust data
   goes through it, per the card's "CPA-reviewed sign-off" requirement.
