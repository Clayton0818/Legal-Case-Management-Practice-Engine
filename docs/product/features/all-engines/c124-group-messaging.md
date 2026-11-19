# c124 — Group messaging for matters with more than one client

**Where:** Firm-wide settings → Group messages (`/admin/all-engines/group-messages`), one page per matter.
**Code:** `src/engines/all-engines/groupMessaging/` (rules are pure; the service does the reads and writes).
**API:** `GET|POST /api/all-engines/matters/[id]/group`.
**Tables:** `joint_representations`, `client_sharing_consents`, `matter_group_messages` (migration 0012).

## What it does

Some matters have more than one client: spouses buying a house, business partners, co-plaintiffs. c124 gives
those matters one shared thread, so the firm doesn't send the same update separately to each client.

The thread opens only when **all** of these hold:

1. A lawyer (firm role `lawyer` or `conflicts_attorney`, with `matters.edit` on the matter) has marked the matter as a
   **joint representation**. This is the lawyer's decision, and it is recorded. The software never makes it.
2. The matter has at least two current clients.
3. No current client is marked adverse.
4. Every current client has an active **consent to sharing**, which staff record using the consent wording.

A message goes to exactly the current, consenting clients. Opposing parties, opposing counsel and other contacts on
the matter can never be recipients, because only parties holding the `client` role are considered.

## Pending review

| Gate | What waits |
|---|---|
| `copy.all-engines.joint_sharing_consent` (attorney) | Until it is approved, the consent wording shows a visible placeholder. Each consent row stores the gate key, the draft hash, and whether the wording was approved when that consent was recorded, so consents taken on draft wording can be found and re-taken. |
| `copy.all-engines.group_message_notice` (attorney) | The client notice that says "there's a new message, read it in the portal". It contains no case details. Until it is approved, email notices are queued as `held`, just like every other client email. |

## Safety rules

- Withdrawing any client's consent, or ending the joint representation (a reason is required), closes the thread at once.
- Joint representations and consents are never deleted; they are ended or withdrawn. Messages are append-only, and
  migration 0012 revokes UPDATE and DELETE from `app_runtime`.
- Client notices are marked `sensitive` (DV-safe addressing) and carry an empty payload.
- Every step is audited: `group_messaging.joint_marked`, `joint_ended`, `consent_recorded`, `consent_withdrawn`,
  `message_posted` and `client_reply`.

## Follow-ups

- A client portal view of the thread. `postClientGroupReply` is already in the service, with tests.
- A link from the matter page (`/admin/matters/[id]`) when the matter has two or more clients.
- Attachments on group messages, using c88 redaction and document privilege checks.
