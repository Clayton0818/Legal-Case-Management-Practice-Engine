# c87 — implementation notes (first slice: the matching decision)

Spec: [`c87-file-all-matter-email.md`](./c87-file-all-matter-email.md).
Code: `src/engines/document/email/match.ts` (pure) with `match.test.ts`.

## What this slice builds

`decideFiling(message, context)` returns exactly one of five outcomes: `excluded`, `auto_file`, `suggest`, `screened_admin_queue` or `no_match`. It implements the spec's matching rules:

| Rule (spec) | How |
|---|---|
| Signals (a) thread, (b) address, (c) cause number, (d) full name (§4.2) | `collectCandidates()`. Staff addresses on the firm's own domains never count as a party signal. Cause numbers are compared on letters and digits only, with at least 5 characters. Names must be at least two words and match as whole words. |
| Auto-file only on (a) exactly one matter, (b) exactly one open matter, or (c) one matter plus another agreeing signal (§4.3, rule 1) | `decideFiling()` |
| Everything else is a suggestion, and nothing is stored on a matter until a person confirms (§4.4) | The `suggest` outcome lists the candidates and the reason. |
| Closed matters never get auto-filed (rule 4) | A closed match is downgraded to `suggest`. |
| Screens enforced first (rule 5, criterion 5) | A screened-only match goes to `screened_admin_queue` with matter ids only and no content. A mixed match is downgraded to `suggest` without the screened matter. |
| Sender/domain exclusions (rule 6) | `isExcluded()` |
| Unmatched metadata discarded after the firm window, default 7 days (rule 2, criterion 3) | `unmatchedPurgeAt()` |
| Reply clock for auto-filed inbound client mail (rule 7, open question 1) | `startsReplyClock()`, off unless the firm setting is on. |

Acceptance criteria 1–5 are covered by tests (13 tests).

## Deliberately not in this slice

This slice does not include the mailbox worker, add-ins, storage of filed messages or attachments, virus scanning, the suggestion queue, audit writes or routes. The worker that reads mailboxes must first pass the shared `vendor.mailbox_access` gate (`VENDOR_GATES.mailboxAccess`, which already lists c87). Nothing here contacts a mailbox. No tables and no migration are included. The decision is computed fresh from data the worker already holds.

## Compliance

The matcher does string matching only and never interprets what an email means legally (rule 9). Auto-filing puts client communications on a matter, which brings in confidentiality (Texas Rule 1.05) and the reach of mailbox access. Open question 2 in the spec, about the Google/Microsoft app review, still stands. A licensed attorney should review the privilege-suggestion behaviour when c88 lands.
