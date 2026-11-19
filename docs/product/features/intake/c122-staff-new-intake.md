# c122 — "New intake" in the staff console

**Problem.** A lawyer meets someone the intake team never saw: at the courthouse, on their own phone, or through a referral. The intake engine already supported this (`receiveInbound` accepts the staff-entered channels `walk_in` and `phone_manual`, and attorneys are allowed to use them), but no screen called it. The intake console was a read-only queue.

**What staff see now.**

1. **`/admin/intake` → New intake.** Every queue row also opens its intake.
2. **`/admin/intake/new`**, with two tabs:
   - **Walk-in or call.** How they reached the firm (in person, or a phone call entered by hand), name, phone or email, and language. The form first checks for an existing record by name, email or phone. If the person already has an open intake, it links to that intake so the team doesn't create a duplicate. Nothing is merged automatically (c71).
   - **Referral.** Uses the existing `POST /api/intake/referrals`. Nothing is sent to the referred person. The referral goes live when they contact the firm, or when staff record that they asked to be contacted. Outreach where the firm contacts them first stays blocked behind the attorney-review gate (solicitation).
3. **`/admin/intake/[id]`**, the guided page. It shows the steps in the order the engine enforces them and opens only the step that's actionable now:
   1. **Disclosures.** The staff member reads the disclosures aloud and ticks them. The page shows the attorney-approved wording, or the visible `[PENDING ATTORNEY REVIEW …]` placeholder until it is approved. The disclosure proof records the channel and the wording version (c72).
   2. **Names for the conflict check.** The person's name and the other parties' names only. Recording them requests the conflict check.
   3. **Conflict check.** Waits for the conflict-check engine's result. A possible conflict waits for the conflicts attorney. A definite or declined conflict stops the intake.
   4. **Case details.** Practice area (from the firm's enabled areas), county, and "what they need help with". The engine refuses these until the conflict check is clear.

   A separate **Response clock** card shows when the firm should respond. It has an "I've met with them" / "I've spoken with them" button that records the first human contact and stops the clock (c69).

**Routes.** `POST /api/intake/staff/lookup`, `POST /api/intake/staff/intakes` and `POST /api/intake/staff/intakes/[id]/steps` are staff-only. They always resolve the signed-in staff member, or the dev session's user on a dev or demo deployment, and require an intake role (attorney, intake staff or firm admin).

The shared `/api/intake/inbound` and `/api/intake/sessions/[id]/steps` serve the client chat too. They treat a request with no staff credential as a client, so the staff console could not use them on the demo deployment. Lookups are POST so names, emails and phone numbers stay out of URLs and logs.

**What it deliberately does not do.**

- **No shortcut around the rules.** Every write goes through the same channel services as the other channels. The rules stay in one place: staff role, disclosures first, conflict check before details, and the matter-opening gates (c68).
- **No new tables or migrations.**
- **No `phone_staff` option.** That channel means a call through the firm's phone system, which starts with recording consent pending.

**Code.**
- `src/engines/intake/staffEntry/steps.ts`: pure form validation, step derivation and case-detail picking (`steps.test.ts`).
- `src/engines/intake/staffEntry/service.ts`: duplicate lookup, creation and the page's read model (`staffEntry.db.test.ts`).

**Open follow-ups.**
- **No screens for the next steps yet.** Case acceptance (fit rules), lawyer assignment and booking still have no screens. Their API routes exist.
- **The staff-chosen practice area doesn't reach the fit rules or the matter.** It is stored in the case details (`collectedAnswers.practiceArea`). The fit rules and the prospective matter read the practice area from the classifier output, so they won't see it. Deciding whether a staff-recorded practice area should count is an intake-engine change of its own.
