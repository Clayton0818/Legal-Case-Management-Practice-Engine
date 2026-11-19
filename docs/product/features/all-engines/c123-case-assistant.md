# c123 — AI case assistant

A staff-only assistant inside one matter. It answers questions such as "When is the next hearing?" from that matter's own records, and gives a "catch me up" briefing to a lawyer picking up the file. Every answer shows the records it came from.

**Where.** `/admin/all-engines/assistant` lists the matters the person may open; `/admin/all-engines/assistant/[matterId]` has the question box and **Catch me up**. API: `POST /api/all-engines/matters/[id]/assistant` with `{ mode: "ask", question }` or `{ mode: "briefing" }`.

## What it may see (decided before anything reaches a model)

| Rule | How |
|---|---|
| Only people who may open the matter | c99 `matters.view` on that matter: team, restricted matters and ethical screens (c60) all apply |
| Parties / calendar and tasks / documents / internal flags | `contacts.view` / `calendar.view` / `documents.view` / `flags.internal` on that matter |
| Privileged, work-product and sealed documents (c88) | Never included, whoever asks: a model vendor is outside the firm, and c88 requires an extra confirmation before tagged documents leave it. The page says how many were withheld. |
| Cancelled events and tasks | Left out |

**Engine boundary.** This engine may read only shared tables (`src/engines/README.md`). The assistant therefore reads the matter, its parties, calendar events, tasks, flags and the document list (name, type, status, version). It does not read document text, filed emails, time entries, invoices or trust balances, because those live in other engines' own tables. That is the same limit c101's reports document. Summarising document text needs a shared way to expose it (see follow-ups).

## How it answers

- **Records mode** (default). The question is matched against the records, and the closest ones are shown, each cited. No model is involved and nothing leaves the system. This runs while the shared `vendor.ai_model` gate is pending (the page shows the visible `[PENDING VENDOR_DPA REVIEW …]` placeholder), and whenever no model adapter is configured.
- **AI mode**, only when `vendor.ai_model` is approved **and** a model adapter is configured (`setCaseAssistantModel`). The model gets the records as `[ref] fact` lines and must reply with JSON `{answer, citations, notFound}`. Citations that don't match a real record are dropped. An answer left with no valid citation is replaced by "The matter's records don't answer this". The model never sees anything outside the evidence list. No real model adapter ships in this PR, because choosing the vendor is part of the `vendor.ai_model` review.

**Guardrails.**
- **Questions it refuses.** Legal research ("case law", "statute"…), advice ("should we…") and predictions ("chances of winning") are refused with a plain reason.
- **Dates.** Any answer touching dates carries the note that only a lawyer confirms deadlines. Calendar records say whether each date is confirmed or only proposed. The assistant never sets or confirms a deadline (c92/c93 rule).
- **Nothing goes to clients.** Nothing it writes goes to a client. It is a staff tool (c54 still applies to anything client-facing).
- **Everything is logged (c6).** These actions are written to the audit trail: `case_assistant.asked` (the question, by the user), `case_assistant.answered` (answer text, cited refs, mode; actor `ai` with the model name in AI mode), `case_assistant.refused`, and `case_assistant.briefing`.

## Code

- `src/engines/all-engines/caseAssistant/records.ts`: evidence lines, question screening, related-record ranking, briefing. Pure (`records.test.ts`).
- `src/engines/all-engines/caseAssistant/answer.ts`: records-mode answers, the model prompt, strict parsing of a model reply. Pure (`answer.test.ts`).
- `src/engines/all-engines/caseAssistant/model.ts`: the model interface (none configured by default).
- `src/engines/all-engines/caseAssistant/service.ts`: access checks, reading the shared rows, audit (`caseAssistant.db.test.ts`).

## Follow-ups

1. **A real model adapter**, once `vendor.ai_model` is approved and the firm can see which vendor processes its data.
2. **Document summaries.** These need document text through a shared, permission-aware read (document engine), and the same privilege rules.
3. **A link from the matter page** (`/admin/matters/[id]`). That page is outside this engine's paths.
4. **Filed emails, time and billing** as evidence. Each needs the owning engine to publish a shared read-model.
