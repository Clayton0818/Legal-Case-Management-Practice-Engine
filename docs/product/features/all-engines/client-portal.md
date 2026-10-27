# Client portal (c11, c112)

**Status:** Built. Every client-facing sentence below is a draft that renders as a visible `[PENDING ATTORNEY REVIEW …]` placeholder until a licensed Texas attorney approves it, and the sign-in email is held (never sent) until then. **Not legal advice.**

Code: `src/portal/**` (logic), `src/app/portal/**` (pages), `src/app/api/portal/**` (routes). Tests: `src/portal/portal.test.ts`.

## What a client can do

A client of an **open (retained) matter** goes to `/portal/<firm-slug>`, enters their email address, and gets a one-time sign-in link. Once signed in they see four sections:

| Section | Source | What is shown |
|---|---|---|
| Updates | in-app notifications for the party (`listInAppForParty`, c51) | attorney-approved wording only; "Mark as read" |
| Your to-dos | `listClientTasks` (c46) — client-visible tasks the client owns | title, description, due time; past-due tasks get the neutral `copy.calendar-alerts.portal_past_due_label` |
| Documents we need | c49 checklist, client items only (`listClientChecklist`) | label, description, plain status (Needed / Requested / Received). No upload yet — that needs object storage (`vendor.object_storage`). Shows "Nothing requested" until the c49 tables are migrated. |
| Your matter | `matters` where the client is the primary party and the stage is `retained` | one approved status line and the date opened — no internal stage names |

Everything is read inside `withTenant(firm)` and filtered to the signed-in party; each list goes through an explicit allow-list (`toPortalUpdate`, `toPortalTodo`, `toPortalDocumentRequests`) so internal fields never reach the page.

## Sign-in (passwordless, one-time link)

1. The client enters an address. The response is **always** the same neutral "if that matches our records, a link is on its way" — whether the address is known, unknown, rate-limited or held (no account enumeration). The email is sent after the response, so timing does not reveal a match either.
2. The link goes **only** to the address `resolveClientAddress(…, "email")` picks: a DV-sensitive client is reachable only at the safe address they chose (typing their ordinary address gets nothing), and a client who turned email off gets nothing.
3. Token: 32 random bytes. Only `SHA-256(token)` is stored. 15-minute expiry, single use (enforced under a transaction-scoped advisory lock, so two clicks cannot both sign in). The link opens a page with a **Continue** button that POSTs the token, so email link-scanners cannot use it up.
4. Rate limits per firm, sliding 15 minutes: 3 requests per address, 10 per IP. Addresses and IPs are stored only as keyed hashes (HMAC with `CLIENT_SESSION_SECRET`).
5. The email is sent only when **all** of these hold, otherwise nothing is issued and the reason is audited: `vendor.email` approved (signed DPA), the sign-in wording approved, a real email provider configured on the web service, and `PORTAL_BASE_URL` set (links are never built from the request's Host header).
6. **Dev/demo only:** when staff auth is in dev mode (`AUTH_PROVIDER=dev` / `DEV_TENANT_ID`) **and** the firm is not a production firm (`firms.is_production = false`), the link is shown on screen, clearly marked, instead of emailed. Never with real (Clerk) sign-in and never for a production firm.

No new tables: issued/used links, rate-limit counters and sign-outs are rows in the append-only `audit_events` table (`entity_type` `portal_sign_in_token`, `portal_sign_in_address`, `portal_sign_in_ip`, `party`; actions `portal.*`). This also gives the firm a full trail of portal access.

## Session

A signed, `httpOnly`, `Secure`, `SameSite=Lax` cookie (`__Host-portal_session`) holding only firm id, party id and two timestamps, signed with `CLIENT_SESSION_SECRET` — completely separate from staff auth. 30 minutes idle, 8 hours absolute. **Sign out** signs the client out on every device. A session also stops working as soon as the matter is no longer `retained`. Cookie-authenticated POSTs must be same-origin.

## Safety (DV)

- **Quick exit** on every page: signs out everywhere, clears the cookie and cached pages (`Clear-Site-Data`), and replaces the current history entry with a weather page, so Back does not return.
- Neutral tab title ("Secure portal"); no firm name, matter, practice area or case detail in titles, headers or the sign-in email.
- Every portal response: `cache-control: no-store`, `referrer-policy: no-referrer`, no framing, `noindex` (middleware class `client_portal`).
- After 30 minutes without activity the page leaves itself.

## Approval gates

New attorney copy gates (`src/portal/gates.ts`, listed with the all-engines gates): `copy.all-engines.portal_sign_in_email`, `…portal_sign_in_intro`, `…portal_link_sent`, `…portal_link_expired`, `…portal_quick_exit_help`, `…portal_matter_open`, `…portal_documents_intro`. Reused: `vendor.email`, `copy.calendar-alerts.portal_past_due_label`, and the existing client notification wording for Updates.

## Settings to make on Render

| Variable | Where | Value |
|---|---|---|
| `CLIENT_SESSION_SECRET` | web service | 32+ random characters (`openssl rand -base64 48`). Unset = the portal is switched off. Rotating it signs every client out. |
| `PORTAL_BASE_URL` | web service **and** worker | the app's public https origin, e.g. `https://<service>.onrender.com`. Also makes `{portalUrl}` in client emails point to `/portal/<slug>` when the firm has no `client_portal_url` of its own. |
| `EMAIL_PROVIDER`, `POSTMARK_SERVER_TOKEN`, `EMAIL_FROM_ADDRESS` | web service | same values as the worker — the web service sends the sign-in email itself. |

Then: attorney approval of the seven portal copy gates and `vendor.email` (DPA) before any real client receives a link.
