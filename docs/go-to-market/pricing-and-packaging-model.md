# Pricing & Packaging Model (c7)

**Status:** Draft recommendation for Clayton. It is not a price list. It builds on the direction set in [`pricing-hypothesis.md`](./pricing-hypothesis.md) (c29) and updates it for the 2026-09-25 move from intake-only to full case management (`docs/product/case-management-expansion-scope.md`). Every dollar figure below is a **placeholder range for pilot-firm testing (c30)**, not a decision.
**Needs before it is final:** real pilot conversations (c30, Founder) and attorney review of §5 (fee-sharing). I am not a lawyer, and nothing here is legal advice.

## 1. What changed since c29

c29 priced an **intake tool** that sat beside a firm's existing practice-management software. It chose a per-firm base plus intake-volume tiers, solo/small firms first, and a trial instead of a free tier. Since then the product has become a **full case-management suite**: intake, conflicts, documents, calendar and deadlines, billing and trust, client portal and permissions. Most of those engines are now shipped on the board. That changes two things.

1. **The comparison set moved.** Buyers will now compare us with Clio Manage, MyCase, PracticePanther and Smokeball (scope memo), not just Lawmatics, Intaker and Smith.ai. Those products sell **per user per month**.
2. **The value is no longer proportional to intake volume.** A firm that already has its clients still uses billing, trust, documents and calendar every day. Pure intake-volume pricing would undercharge exactly the firms that use the product most.

c29's other conclusions still hold. They are: no lead-generation or per-referral pricing (Texas Occupations Code ch. 952, per c1), solo and small firms first, and a time-boxed trial rather than a permanent free tier.

## 2. What competitors charge now (October 2026)

| Product | Published entry price | Model | Notes |
|---|---|---|---|
| PracticePanther | $49 / $69 / $89 / $114 per user/month (Solo / Essential / Business / Business Pro) | Per user, feature tiers | Intake forms start at Business. A trust ledger is in every tier. Full trust and operating accounting is in Business Pro. (LawNext directory, updated May 18, 2026) |
| MyCase | About $60 / $120 / $150 per user/month (three tiers; earlier in 2026, $49 / $99 / $119) | Per user, feature tiers | Third-party price tracker, Jul 4, 2026 snapshot. Billing basis not stated. |
| Clio Manage | EasyStart $49/user/month; higher tiers "contact sales" | Per user, feature tiers | Clio Grow (intake/CRM) listed as an add-on with a one-time setup fee. (Third-party tracker, verified Sep 3, 2026) |
| Smokeball | Around $149/user/month reported, tiers differ by features | Per user | The source page is internally inconsistent; it shows ranges from $49 to $179. Treat as unconfirmed. |
| Smith.ai (intake/answering, from c29) | $300 / $810 / $2,100 per month for 30 / 90 / 300 calls | Volume tiers with overage | Different product. It is the structural reference for usage pricing. |

**Caveat on this table.** I could not load Clio's own pricing page in this run. Apart from PracticePanther (LawNext directory), the figures come from third-party price trackers, which flag their own inconsistencies. Before any number is published, someone should check each vendor's live pricing page.

**What the table says, even with that caveat:**

- The market anchor for a full suite is roughly **$50–$150 per user per month**.
- Intake/CRM and full trust accounting usually sit in the **upper tiers**.
- AI is mostly bundled into upper tiers or sold as an add-on.

A small firm that wants intake, conflicts, documents, billing and trust from these vendors is usually paying near the top of that range per user.

## 3. Recommended pricing unit: a per-firm platform fee plus per-lawyer seats, with staff seats included

c29 rejected per-seat pricing for an intake tool, because seat counts in a two-person office don't track value. For a full suite, pure per-firm pricing has the opposite problem. A 10-lawyer firm would pay the same as a solo while using ten times the billing, trust and calendar load. I recommend a hybrid:

- **A per-firm platform fee.** It covers the firm's tenant, the compliance machinery (audit trail, approval gates, tenant isolation, conflict index) and a **set number of client intakes per month**. This keeps c29's predictability and its volume fairness for the intake engine, with metered overage above the included intakes and no hard cutoff.
- **Per-lawyer seats.** A seat is a user holding a lawyer or conflicts-attorney role (`src/core/permissions.ts`). Attorneys are the people whose time, matters and approvals drive cost and value. Every gate in the product ends in an attorney's sign-off.
- **Staff seats included.** Paralegals, intake staff, bookkeepers and admins cost nothing extra, possibly up to a generous cap. This removes c29's objection to seat pricing: adding a receptionist never raises the bill. It also differs from competitors, who charge for every user.

This is still **not** a percentage of anything the firm earns (§5).

## 4. Packaging: three tiers along the engine boundaries

The engines map onto how firms actually adopt case management, so tiers follow the engine slugs in `src/engines/README.md`:

| Tier (working names) | Engines included | Who it is for | Placeholder price to test in c30 |
|---|---|---|---|
| **Intake** | Intake, conflict check, client portal (status, Q&A, uploads), calendar alerts | A firm keeping its current practice-management system and wanting compliant AI intake plus conflicts. This is c29's original product. | Platform fee in the low hundreds per month, including N intakes. Seats optional. |
| **Practice** | Intake plus documents (templates, store, checklists, sign-off, matter email), full calendar and deadlines, matter stages, reports | A firm replacing Clio/MyCase-style software except billing | Platform fee plus a per-lawyer seat priced below comparable mid-tier competitors (roughly $60–$90 per lawyer) |
| **Practice + Trust** | Everything, plus time, costs, invoices, trust ledger and three-way reconciliation, retainer floor, fee arrangements, refunds | A firm that wants one system including IOLTA trust | Practice price plus a trust uplift. Compare against the competitors' top tiers (about $114–$150 per user). |

**Add-ons**, priced separately because they carry per-use vendor costs:

- Two-way SMS (c113): the vendor cost is per message.
- E-filing (c86): filing-vendor fees are passed through at cost.
- AI-assisted drafting (c115), if built: per-use model cost.
- Additional practice-area packs: Immigration (c104) and Personal Injury (c105). Family Law (c103) is included as the pilot pack.

**Packaging guardrails:**

- **Never paywall compliance.** Audit trail, conflict checks, ethical screens, approval gates and trust safeguards stay in every tier that has the related engine. Selling "the safe version" as an upgrade is a bad look for a legal product, and it invites the failures those controls exist to prevent.
- **Trust is all or nothing within a tier.** No firm should get a partial trust ledger that skips reconciliation. That is why trust is a whole tier, not an add-on.
- **Data migration (c98) is free** in the first year for every tier. Every competitor treats switching cost as the main barrier.

## 5. A constraint pricing must respect: no percentage-of-revenue fees

Texas Professional Ethics Committee **Opinion 706** (February 2025) addressed a nonlawyer-owned company supplying case management, back-office and support technology to law firms. Per summaries of the opinion, it concluded that a lawyer **"may not pay or promise to pay fees to the company based on a percentage of the revenues"** of the lawyer or firm. The basis is the fee-sharing prohibition in **Texas Disciplinary Rule 5.04(a)**. The same summaries say a lawyer **may** hold equity in such a company, with conflict and disclosure cautions under Rules 1.06 and 1.08(a). The facts are close to this product's.

**Implications (for attorney confirmation):**

- No pricing component may be a percentage of a firm's revenue, collections, fees earned or settlement amounts. That includes "x% of invoices processed through the platform" dressed as a platform fee.
- Payment-processing fees (c80) belong to the payment processor. They should be per-transaction processor fees, never a platform cut. And per the trust-accounting review (c75), they are never taken from trust.
- A pilot firm's lawyer receiving equity in the company (for example, a design-partner deal) is not barred by 706 as summarized, but it triggers the conflict-analysis and disclosure cautions. Run it past counsel first.

The per-firm fee, seats, intake-volume tiers and fixed-price add-ons in §3–4 are **not** tied to firm revenue. As I read 706, they are consistent with it. **A licensed Texas attorney must confirm that reading before launch**, and I was able to read only summaries of 706, not its full text.

## 6. Trial and onboarding

- **30-day full-featured trial** of Practice + Trust, carried over from c29.
- **Trust accounting stays in sandbox mode during the trial.** No real IOLTA money moves until the firm's own attorney and CPA have signed off on its `rules.trust_accounting` approval (c75).
- **Pilot design partners (c16/c30):** a founding-firm discount locked for a fixed term in exchange for feedback, as a fixed percentage off list price. That is a discount on our price, not a share of theirs.
- **Annual billing:** offer it at a discount (competitors appear to do the same), but do not require it.

## 7. Open questions for Clayton

1. **The seat definition.** Is "per lawyer, staff free" the right differentiator, or will firms with many paralegals see it as underpriced? A staff-seat cap is the fallback.
2. **Whether the Intake tier ships at all**, or whether c29's intake-only buyer is now better served by Practice at a low seat count.
3. **The price numbers.** Every number in §4 is a placeholder to test with real firms (c30), especially what they pay today across their practice-management system, answering service and intake CRM.
4. **Attorney review of §5 before any pricing page goes live**, including whether per-transaction payment pricing could ever be characterised as revenue-based.

## Sources

- [`pricing-hypothesis.md`](./pricing-hypothesis.md) (c29) and its sources: Clio pricing page, Smith.ai pricing, Lawmatics and Intaker pricing listings, and c1's Texas Occupations Code ch. 952 finding.
- `docs/product/case-management-expansion-scope.md`: the new competitive set and the trust-accounting surface.
- [PracticePanther pricing, LawNext Directory](https://directory.lawnext.com/products/practicepanther/pricing/), last updated May 18, 2026.
- [MyCase pricing change log, Costbench](https://costbench.com/changelog/mycase-plans-renamed-2026-02/), snapshots from Mar 4 and Jul 4, 2026.
- [Clio Manage pricing, Costbench](https://costbench.com/software/legal-practice-management/clio-manage/), verified Sep 3, 2026.
- [Smokeball pricing, Costbench](https://costbench.com/software/legal-practice-management/smokeball-lpm/), verified Jun 13, 2026; the page is internally inconsistent.
- [Texas Ethics Opinion 706, Professional Ethics Committee for the State Bar of Texas](https://legalethicstexas.com/resources/opinions/opinion-706/), February 2025. The page I reached showed the question and facts but not the conclusion text.
- [Opinion 706 summary, ezel.ai](https://ezel.ai/ethics-opinions/tx/706-nonlawyer-vendor-revenue-share-and-equity): the conclusion quoted in §5.
- [Law360, "Texas Bar Forbids Revenue Sharing With Non-Atty Companies"](https://law360.com/amp/articles/2300313), Feb 20, 2025: an independent report of the same holding.
