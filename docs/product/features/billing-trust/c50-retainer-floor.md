# c50 — Retainer floor: trust can't drop below the minimum balance

Status: draft product spec. Not legal or accounting advice — the trust-money
rules this spec sits on top of still need the sign-off `rules.trust_accounting`
gates on (`docs/compliance/trust-accounting-iolta-compliance-review.md`), and
this spec does not change or re-derive any of that review's conclusions.

## Why this card is unblocked now

The note on this card gates it on "the trust-accounting/IOLTA compliance
review... reviewed by an attorney and a CPA." That review shipped as c75
(`docs/compliance/trust-accounting-iolta-compliance-review.md`, PR #34), and
the trust ledger + three-way reconciliation it describes shipped as c76
(`src/engines/billing-trust/ledger.ts`, `ledgerService.ts`,
`reconciliation.ts`, `reconciliationService.ts`). This spec is the floor rule
that sits on top of that ledger — it does not touch ledger internals, it adds
a read-before-write check in front of every trust disbursement/invoice-payment
path and the client/firm-facing flags around it.

## What "the floor" means

Every client has one running trust balance per the shipped ledger (c76). A
firm sets a minimum balance per client — **$4,500 is the founder's default**,
stored as a `firm_settings` value (per `src/engines/README.md`'s rule that
founder-set numbers are settings, not gates), and a lawyer may raise or lower
it for an individual matter via an `engineSettings.billing-trust` override
keyed by matter. The floor is a *soft stop on withdrawals*, not a hard limit
on the balance (a balance can sit above the floor indefinitely; it just can't
be paid down through it).

**Rule:** when an approved invoice is paid from trust and the payment would
take the balance below the floor, the system pays from trust only down to the
floor, puts the remainder on the client as an amount due billed directly, and
raises both flags below. It never blocks the invoice from posting and never
lets the firm silently take the shortfall from trust — either outcome routes
around the floor.

## Hard rules underneath the floor (never overridable, including by the floor itself)

These come from the shipped ledger/reconciliation work and are restated here
only to make clear the floor sits *inside* them, never loosens them:

- a client's trust balance can never go negative;
- one client's trust money can never cover another client's invoice;
- money leaves trust only for fees actually earned and invoiced (c52's
  earning-schedule distinction);
- a disputed amount stays in trust until resolved (also referenced by c82).

The floor is strictly a number the firm chooses to stop *above* zero; it can
never be used to justify relaxing any of the four rules above.

## Flags

**Client side** (c11 portal + a notice, through the existing `raiseFlag` +
notification-outbox machinery, not a new channel):
- shows current balance, the floor, and the amount needed to replenish;
- wording is neutral — a replenishment request, never phrased as a threat of
  withdrawal unless a lawyer has separately decided to withdraw (that
  decision, and its notice, belong to a different card; this spec only
  requests money);
- client-facing copy is a new attorney-reviewed gate,
  `copy.billing-trust.replenish_request` (pattern: `NOTIFY_COPY_GATES` in
  `src/compliance/gates.ts`) — renders as the standard
  `[PENDING ATTORNEY REVIEW — ...]` placeholder until approved;
- an optional earlier "early warning" notice fires at a second,
  higher-balance threshold (e.g. $6,000) the firm can configure or disable;
  same copy-gate pattern, different key.

**Firm side** (internal-only, per the `raiseFlag({ audience: "internal" })`
rule nothing here overrides):
- to the matter's responsible lawyer and firm billing/admin;
- to the ops "attention needed" queue (c37) once that view has a data
  source;
- an audit row via the existing audit trail (c6) — `trust.floor_breach`.

If the client doesn't replenish, this spec does not invent new consequences:
the existing non-response/overdue task machinery (c42/c46) picks up the
replenishment request exactly like any other client-owed task, because it is
created as one (`createTask` with `kind: "billing-trust.trust_replenish_due"`,
owner `{ type: "client" }`, visibility `"client"`).

## The agreement dependency

The floor only binds a client who agreed to it. The evergreen/minimum-balance
term has to appear in the signed engagement agreement (c39) before the floor
can be enforced for that matter — this spec's trigger path checks that the
matter's agreement includes the approved `copy.billing.evergreen_term` gate
text (already defined against c50/c39 in `src/compliance/approvals.ts`'s
worked example) before raising a floor flag; if the term isn't in the signed
agreement yet, the floor check is skipped for that matter and a one-time
internal flag notes it (so firms can't accidentally rely on an unsigned term).

## Data model note (no migration in this PR)

No new table. This needs: a `trustFloorCents` column on the per-matter billing
settings (or, if that doesn't exist yet as a distinct row, a key inside
`engineSettings["billing-trust"]` per matter) and the two copy gates above.
The integration step that runs `npm run db:generate` should add the column;
this PR only specifies it (see `src/engines/billing-trust/types.ts` for where
the billing-trust engine's settings types already live).

## Open questions for human review

1. Confirm $4,500 is still the founder's intended default (board note says
   so; flagging here since it's a number, not a derivation).
2. Attorney review of the two new client-facing copy gates
   (`copy.billing-trust.replenish_request`,
   `copy.billing-trust.early_warning`) before they render real wording.
3. Whether the early-warning threshold should be firm-configurable from day
   one or ship firm-wide-default-only first.
