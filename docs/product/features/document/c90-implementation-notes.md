# c90 — implementation notes (first slice: closing and destruction decisions)

Spec: [`c90-closing-a-file.md`](./c90-closing-a-file.md).
Code: `src/engines/document/closing/checklist.ts` (pure) with `checklist.test.ts`.

## What this slice builds

| Piece | Function | Spec reference |
|---|---|---|
| The seven-item closing checklist: final invoice, trust, open tasks, future events, closing letter, originals, retention | `evaluateClosing()` | §3, §4.1–4.5 |
| Trust can never be waived. It needs a zero balance or a lawyer's hold reason. Without a live ledger it needs a lawyer's attestation. A negative balance always blocks. | `evaluateClosing()`, `validateWaiver()` | Rule 1, §4.2, criterion 1 |
| Retention must be set (no product default) and cannot be waived | `evaluateClosing()` | Rule 4, criterion 8 |
| Every original held needs a disposition, and "other" needs a note | `evaluateClosing()` | §4.4, criterion 3 |
| Only an attorney (`matters.close`) closes, waives, reopens or decides a destruction review | `canCloseMatter()`, `validateWaiver()`, `planReopen()`, `destructionReviewOptions()` | Rule 3 |
| Destruction-review date preview (the `matters` trigger stays the source of truth) | `previewDestructionReviewDate()`, reusing `addYearsUtc` from `retention/policy.ts` | criterion 2 |
| A legal hold disables approval and shows the reason. Originals still held also block. Disputes produce warnings. | `destructionReviewOptions()` | Rule 6, criterion 5 |
| What a destruction removes and what it keeps (tombstone, conflict index, audit, trust records) | `DESTRUCTION_SCOPE` | Rules 7–8, §4.9 |
| Reopen plan (stage back to retained, clear `closed_at`, cancel pending review tasks) | `planReopen()` | §4.10, criterion 7 |

Acceptance criteria 1, 2, 3, 5, 7 and 8 are covered by tests (14 tests).

## Deliberately not in this slice

This slice does not include the database service that loads the facts (invoice from billing-trust through shared tables only, tasks, calendar events, originals from `document_groups`). It also leaves out the close transaction itself, the `scheduled_tasks` retention-clock hook, the purge job (which runs under a separate elevated role, per MIGRATION NOTES 2 in `src/db/tables/document.ts`), audit writes (rule 10), routes and the admin page. Applying a retention period still goes through the existing `rules.retention_periods` gate (`proposeRetention`). No tables and no migration are included.

## Compliance

Retention length, file destruction and returning client files are governed by state ethics rules and firm policy. The product ships **no** retention default (rule 4). A licensed Texas attorney must review the closing-letter template (c85) and the destruction flow before a firm relies on them, including the spec's reference to Texas Ethics Opinion 627 on client files. The spec's open questions still stand: the retention default, a Family Law minors rule, original-return receipts, and how long the portal stays open after closing.
