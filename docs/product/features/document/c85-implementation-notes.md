# c85 — implementation notes (first slice)

Spec: [`c85-templates-fill-from-matter-data.md`](./c85-templates-fill-from-matter-data.md).
Code: `src/engines/document/templates/`, tables in `src/db/tables/document.ts`.

## What this slice builds

| Piece | File | Spec reference |
|---|---|---|
| Product-owned field catalogue (26 fields; sensitive fields marked) | `templates/fields.ts` | §5 rule 6 |
| Restricted template syntax: fields, `#if` / `#unless` / `else` (presence or `== "value"`), `#each` over list fields | `templates/syntax.ts` | §4 "Manage templates" 2, §5 rule 5 |
| Renderer: firm time zone dates, money from cents, `[MISSING: …]` placeholders, sensitive fields withheld from documents to other parties unless the lawyer confirms, value snapshot | `templates/render.ts` | §4 "Generate" 2–4, edge cases |
| Version lifecycle (draft → approved → superseded), lawyer-only approval, what can be offered for a matter, placeholder clearances | `templates/lifecycle.ts` | §5 rules 1–4, 9 |
| Tables `document_templates`, `document_template_versions`, `generated_document_sources` + MIGRATION NOTES item 9 | `src/db/tables/document.ts` | §6 |

All of it is pure logic with vitest tests mapped to acceptance criteria 1–4, 6 and 7.

## Deliberately not in this slice

DOCX upload/rendering and PDF output (the body is plain text with the template syntax; a DOCX adapter can feed the same parser later), the database service, API routes and admin pages, the audit-trail writes (the service will log create / approve / retire / generate / clearance per rule 8), and template approval tasks (§7). No migration is generated, per `src/engines/README.md`.

Fields such as `matter.cause_number`, `court.name` and `matter.matter_type` have no column on the shared `matters` table yet (spec §6 "Missing today"). Until the data-model extension adds them they always render as `[MISSING: …]`, which blocks sending until a lawyer fills or clears them. That is the safe default, not a bug.

## Compliance

The product writes no legal wording here. Every generated document is a draft a lawyer reviews, and the AI does not pick or write clauses. If the product ever ships starter templates, they arrive as drafts. A licensed Texas attorney must review them before any firm relies on them (spec §9: UPL Rule 5.05, confidentiality Rule 1.05).
