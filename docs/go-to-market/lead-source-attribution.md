# Lead-source attribution & conversion funnel (c74)

Status: implemented (v1), internal analytics only. Part of the `intake`
engine (`src/engines/intake/attribution/**`). Feeds the firm insights
dashboard idea (c33) conceptually; see "Relationship to the firm insights
dashboard (c33)" below for why it isn't literally the same page.

## What this captures

One row per intake session, in `intake_lead_attribution`
(`src/db/tables/intake.ts`):

| Field | What it means |
|---|---|
| `landingPage` | The page the inquiry started on, e.g. `/family-law`. |
| `campaignTag` | A marketing campaign / UTM-style tag, e.g. `spring_divorce_2026`. |
| `isGoogleAds` | True when the click path or query params identify a Google Ads lead. |
| `directoryName` | A legal directory's name, e.g. `Avvo`, `FindLaw`, `Justia`. |
| `referralSource` | Free-text "where this inquiry said it came from" (word of mouth, another attorney, a past client). |
| `phoneTrackingNumber` | The number the caller dialed, when the firm uses call-tracking numbers. |

Every field is optional and capture never blocks an inquiry: a missing or
malformed attribution body on session creation just means "nothing captured
for this lead" rather than a failed request (see
`src/app/api/intake/sessions/route.ts`). Staff can add or correct it later
through `PATCH /api/intake/sessions/[id]/attribution`.

This is **distinct** from two other, similarly-named things already in the
schema, which is worth spelling out because the names are easy to confuse:

- `intake_session_state.referralSource` (c73) records where a **no-fit**
  prospect was referred **out** to — the opposite direction from this card.
- `intake_referrals` (c71) is the structured "a specific lawyer/client
  referred a specific new contact" table used for **identity matching**
  (spotting repeat contacts), not for marketing attribution.

## The funnel

Five stages, in order: **inquiry → qualified → consult booked → consult
held → retained**. A lead's timestamp for each stage comes from data the
product already captures for other reasons — this card adds no new
capture for the funnel stages themselves, only for the *source* fields
above:

| Stage | Signal |
|---|---|
| Inquiry | `intake_sessions.started_at` |
| Qualified | Earliest `intake_fit_evaluations` row with `outcome = 'fit'` (c73) |
| Consult booked | Earliest `intake_consultations` row that isn't a never-confirmed slot-hold (`status` not in `held`, `expired`) |
| Consult held | Earliest `intake_consultations` row with `status = 'completed'`, timed at its `starts_at` |
| Retained | `intake_matter_openings.retained_at` (c68) |

"Reached a stage" means that stage's timestamp is set — it is **not**
strictly cumulative, on purpose: a walk-in referral who already has a
scheduled consult by the time they're entered should count as having
reached "consult booked" even if no earlier "qualified" row exists yet.

**Lost-lead reasons** are derived, most-authoritative signal first:

1. The matter's own stage, once one exists (`declined_conflict`,
   `did_not_schedule`, `did_not_hire_referred_out`, `closed`).
2. The most recent fit evaluation's outcome and reasons, when `no_fit`.
3. A consultation's outcome (`declined_by_firm`, `client_declined`) or
   status (`no_show`, `cancelled`, with its `cancel_reason` if recorded).
4. The most recently stopped follow-up run's `stopped_reason` (c70).
5. The session's own status (`not_an_inquiry`, `closed`) if nothing else
   explains it.

A lead that is retained, or still active and unresolved, has no lost
reason (`null`) — "lost" is a specific state, not a default one.

**Fee value** is approximate on purpose: the only fee figure the intake
engine can see is `intake_consultations.fee_cents` (what the firm charges
for the consultation itself, when it charges one at all). The matter's
actual retainer/fee value lives in `billing-trust`'s own tables
(`src/db/tables/billing-trust.ts`), which this engine may not import per
`src/engines/README.md`'s engine boundary. The report labels this figure
"Consult fee value (approx.)" rather than implying it's the deal size — see
Open questions below.

## Aggregation

All of the above is grouped by **source**, **practice area** and **intake
staff member**, each producing: funnel counts, step-by-step and overall
conversion rates, time-to-retain (count/average/median days), the
lost-reason breakdown, and the approximate consult-fee total, all computed
by pure functions in `src/engines/intake/attribution/funnel.ts` (unit
tested in `funnel.test.ts` — no database needed to verify this logic).

"Source" is a single bucket per lead, chosen by precedence (most-specific
paid channel first) in `src/engines/intake/attribution/model.ts`:

```
google_ads > phone_tracking > directory > referral > website > other > unknown
```

A lead with no attribution signal at all buckets as `unknown`, not `other`
— that distinction matters for knowing how much of the funnel is simply
uninstrumented versus genuinely "something else".

"Intake staff member" for a lead is: the lawyer who ran its earliest booked
consultation, else the matter's assigned attorney, else whoever made first
human contact on the session, else `null` ("Unassigned").

## Internal only

Every exported report function returns **aggregate buckets** — counts,
rates, day-statistics — never a list of individual leads or their contact
details. `GET /api/intake/attribution/report` and the admin dashboard
(`/admin/intake/attribution`) only ever render these aggregates. There is
no client-facing route anywhere in this card's surface.

## Vendor gating

Recording a phone-tracking number needs no vendor — it arrives with the
call and is just stored. *Resolving* which campaign a tracking number maps
to (what a real provider like CallRail or CallTrackingMetrics would do) is
a vendor integration, and is gated: `src/engines/intake/attribution/
provider.ts` defines the interface and a stub adapter (`stubPhoneTrackingProvider`,
which always returns "unresolved") and routes a real lookup through
`runGated(VENDOR_GATES.voice.key, …)` — reusing the existing `voice` gate
(`src/compliance/gates.ts`, "Phone / call-recording provider") rather than
defining a second telephony gate, per `src/engines/README.md`'s instruction
not to define a second gate for the same vendor. No real provider is wired
in by this card.

## Relationship to the firm insights dashboard (c33)

`src/app/admin/insights/page.tsx` (c33) already anticipates this card:
`src/engines/all-engines/reports/queries.ts`'s `BLOCKED_METRICS` lists
`lead_conversion` as blocked specifically because "c74 ... is not built yet
as of this PR — nothing to report on." That comment can now be removed by
a follow-up `all-engines` PR, since `GET /api/intake/attribution/report`
and `fetchLeadAttributionReport` (`src/engines/intake/attribution/queries.ts`)
exist to be read from.

This card could **not** extend `/admin/insights/page.tsx` or
`src/app/admin/_lib/queries.ts` directly: those files sit outside this
engine's allowed paths (`src/app/admin/intake/**`,
`src/app/api/intake/**`, `src/engines/intake/**`,
`src/db/tables/intake.ts`) per `src/engines/README.md`'s "an engine only
creates/edits files under those paths" rule, and `/admin/insights` isn't
namespaced under any one engine's own admin folder. Instead, this ships as
its own page, `/admin/intake/attribution`, cross-linked from `/admin/intake`
and linking back to `/admin/insights`.

## Open questions for human review

1. **Surfacing this on `/admin/insights` itself.** The cleanest follow-up is
   a small `all-engines` PR that calls `fetchLeadAttributionReport` (or the
   `GET /api/intake/attribution/report` endpoint) from the insights page and
   removes the `lead_conversion` entry from `BLOCKED_METRICS`. Not done here
   because that file is outside this engine's boundary.
2. **True fee/deal value.** A real "fee value" per the board card's note
   needs a figure from `billing-trust` (the matter's actual retainer or fee
   agreement amount). That needs the same kind of cross-engine
   reporting read-model `all-engines/reports/queries.ts` already flags as
   missing for its own blocked metrics — each engine publishing a small
   summary row into a new shared table, rather than engines importing each
   other's tables directly.
3. **Real call-tracking vendor.** If the firm wants actual campaign
   resolution from tracking numbers (not just recording the dialed number),
   a provider needs choosing and `src/compliance/gates.ts`'s `voice` gate
   needs a sign-off that covers it, or a new vendor gate if the reviewer
   decides tracking-number resolution is a materially different DPA
   question from call recording.
4. **Google Ads / directory / UTM detection on the client side.** This card
   stores whatever the capture call sends; it does not add the
   client-side logic that reads `gclid`/UTM query params or detects a
   directory referrer. That's presumably a small addition to the intake
   widget/landing pages, outside this engine's own files.
