# c52 — Fee arrangement per matter: FIXED FEE or RETAINER, with a pay schedule

Status: draft product spec. Not legal or accounting advice; the trust-money
conclusions this leans on are the attorney+CPA-reviewed
`docs/compliance/trust-accounting-iolta-compliance-review.md` (c75) — this
spec adds a product flow on top, it doesn't re-derive the underlying rule.

## Why this card is unblocked now

Same gate as c50: it waits on the trust-accounting/IOLTA review (c75,
PR #34) and the trust ledger (c76). Both shipped. The two non-trust parts of
this card — the fixed-fee-vs-retainer choice and the pay-schedule UI — the
card's own note says can be designed before the gate clears; the trust
posting behavior below is still gated on `rules.trust_accounting` through
`requireApproval()` exactly as c50 is.

## The choice, made once per matter at engagement

At engagement, the lawyer sets exactly one fee arrangement per matter:

- **RETAINER** — hourly billed against a trust retainer with the $4,500
  minimum (c50). No schedule to build here; c50 covers the floor behavior.
- **FIXED FEE** — a total price from firm templates by practice area and
  matter type (e.g. "uncontested divorce"), adjustable by the lawyer, which
  the system turns into a pay schedule.

Changing the arrangement mid-matter requires a new signed engagement
agreement (c39) — this is enforced as a precondition, not just documented:
the fee-arrangement field is immutable on the matter record once an
agreement referencing it has been signed, and changing it creates a new
draft agreement rather than mutating the old one.

## The pay schedule (fixed fee only)

An upfront amount plus N installments, with count, frequency and due dates
drawn from firm defaults (`engineSettings["billing-trust"].fixedFeeDefaults`)
that the lawyer can edit per matter before the client signs. The schedule and
total are embedded in the engagement agreement text (c39) at signing time, so
the signed PDF and the system's own schedule can never drift apart — the
agreement is generated *from* the schedule, never typed separately.

Reminders go out before each installment's due date (reusing the existing
client-reminder notification pattern, `NOTIFY_COPY_GATES.reminder`). A missed
installment is flagged to the client (portal + email, c51) and to the lawyer
and billing admin, and then follows the existing client-overdue task rules
(c46) — this card does not invent a second overdue mechanism.

## Two schedules, not one — this is the part that actually needs the trust gate

The **PAY schedule** (when the client's money arrives) is kept completely
separate from the **EARNING schedule** (when the firm has actually earned
that money), because Texas trust-accounting rules key off the second, not
the first:

> Per the State Bar of Texas guide to client trust accounts, a flat fee paid
> before the work is done is an advance fee that belongs to the client until
> earned and must sit in the trust account — even when the engagement letter
> calls it "nonrefundable." Only a true retainer paid purely to secure the
> lawyer's availability may go straight to the operating account. See *Cluck
> v. Commission for Lawyer Discipline* and Texas Ethics Opinion 611 (both
> already cited by this card's board note; this spec does not re-derive
> them — c75/the attorney reviewer is the authority on whether they still
> state current law by the time this ships).

Consequence for this spec: every fixed-fee payment the client makes **lands
in trust first**, full stop, regardless of the pay schedule. It only moves to
the operating account as the lawyer marks earning milestones complete on the
separate earning schedule. The unearned portion is refundable if the
representation ends early (c82 covers that flow in detail; this spec only
establishes that the two schedules must never be conflated).

Every transfer from the fixed-fee trust holding to operating is a trust
disbursement like any other and goes through
`requireApproval("rules.trust_accounting", { action: "billing-trust.fixed_fee_earn", tenantId })`
before the ledger entry posts — reusing the shared gate, not a new one
(`RULE_GATES.trustAccounting` in `src/compliance/gates.ts` already lists c52
in its `cardIds`).

Card-payment processing fees can never be taken out of trust (same hard rule
as elsewhere in this track); the payment processor (c80, `vendor.payment_processor`,
already gated on both a DPA and CPA review) takes its fee only from the
operating side.

## The system never takes a legal step on its own

A missed installment is flagged. It is never, by itself, grounds for the
system to initiate withdrawal from representation or any other legal
consequence — that decision belongs to the lawyer, same boundary the
billing-trust engine already respects in c50/c76.

## Data model note (no migration in this PR)

No new top-level table. This extends the matter record with a
`feeArrangement: 'fixed_fee' | 'retainer'` field (immutable post-signature,
as above) and adds a `fee_pay_schedule_installments` table under
`src/db/tables/billing-trust.ts` (separate rows: pay-schedule installment vs.
earning-milestone — two distinct statuses per the two-schedule rule above).
The integration migration step adds these; this PR only specifies the shape.

## Open questions for human review

1. Attorney confirmation that the Cluck / Ethics Opinion 611 reading above
   is still accurate before this is relied on for real client money (c75's
   reviewer is the right person to re-confirm, not re-derive from scratch).
2. Firm-default installment count/frequency for the initial launch practice
   area (Family Law, per c103) — founder or attorney call.
3. Whether a lawyer can ever shorten a fixed-fee's unearned trust hold with
   a milestone marked complete *before* the corresponding pay-schedule
   installment has actually been paid (this spec assumes no — earning can
   run ahead of payment on paper, but trust can't disburse money that was
   never deposited).
