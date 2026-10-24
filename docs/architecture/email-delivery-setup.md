# Email delivery setup (Postmark) — runbook

**For:** Clayton. **Code:** `src/integrations/email/` and `src/app/api/webhooks/postmark/route.ts`.
**Builds on:** the notification outbox in `src/core/notify.ts` (c51), which already queues every alert.

## How alerts reach people

Every alert in the product is a **flag** (`src/core/flags.ts`). When a flag is raised, the outbox gets one row per person per channel, by default **in-app + email**:

- **Staff** (lawyers, paralegals, admins named on the flag) are emailed at their login email (`users.email`), with the flag's internal title and summary.
- **Clients** (only on flags whose audience is `client` or `both`) are emailed at the safe address they chose (their safe-contact preferences decide this; DV-sensitive clients are only ever emailed at a safe address they gave). The email carries no case details — only the approved short wording and a link to the portal.
- **Escalations** email only the newly added staff.

The worker (`npm run worker:tick`) sends due email rows each time it runs. On staging that is the scheduled GitHub Action, which runs **about every 5 minutes, sometimes later when GitHub is busy**, so an email can arrive several minutes after the alert appears in the app.

Three separate switches must all be on before a real email leaves:

1. **The adapter** — `EMAIL_PROVIDER=postmark` and a Postmark token in the worker's environment (this runbook).
2. **The vendor gate** `vendor.email` — approved only after Postmark's Data Processing Agreement is signed. Until then every email row is held, with the reason recorded on the row.
3. **For clients only:** the wording gates `notify.client.*` (and any other client copy gate used) — approved by the reviewing attorney. Until then client emails are held; staff emails are not affected by this one.

## Steps

### 1. Create the Postmark account and server

1. Sign up at postmarkapp.com and create a **Server** (e.g. "Legal Intake — staging"). Postmark gives each server a **Server API token** (Server → API Tokens). Keep it secret; it is `POSTMARK_SERVER_TOKEN`.
2. Use the default **Transactional** message stream (`outbound`). Do not use a broadcast stream for these alerts.

### 2. Verify the sending domain

1. In Postmark: Sender Signatures → **Add Domain**, e.g. `alerts.yourproduct.com` (a subdomain keeps the product's mail reputation separate).
2. Postmark shows two DNS records to add at your domain registrar: a **DKIM** TXT record and a **Return-Path** CNAME. Add both, then click Verify in Postmark (DNS can take up to a day).
3. Pick the default sender, e.g. `alerts@alerts.yourproduct.com`. That is `EMAIL_FROM_ADDRESS`. Each email shows the **firm's name** as the sender name and uses the firm's own reply-to address, so clients reply to the firm, not to the product.
4. If a firm wants mail to come from its own domain, that domain must be verified in Postmark the same way first; then set the firm's email-from address in its settings. Otherwise leave it blank and the default above is used.

### 3. Give the worker the settings (GitHub Actions secrets)

The worker is what sends, so the settings go where the worker runs. In GitHub: repo → Settings → Secrets and variables → Actions → **New repository secret**, add:

- `POSTMARK_SERVER_TOKEN` — the token from step 1
- `EMAIL_FROM_ADDRESS` — the sender from step 2

Then edit `.github/workflows/staging-worker.yml` in GitHub's web editor (this automation can't edit workflow files) so the "Run worker tick" step's `env:` block reads:

```yaml
      - name: Run worker tick
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL_STAGING }}
          EMAIL_PROVIDER: postmark
          POSTMARK_SERVER_TOKEN: ${{ secrets.POSTMARK_SERVER_TOKEN }}
          EMAIL_FROM_ADDRESS: ${{ secrets.EMAIL_FROM_ADDRESS }}
        run: npm run worker:tick
```

The next tick logs `worker.email_provider` with `"provider":"postmark"` if it worked (or the reason it kept the stub).

### 4. Delivery and bounce tracking (webhook, on Render)

1. Choose a webhook username and a long random password.
2. On Render (web service → Environment) add `POSTMARK_WEBHOOK_USER` and `POSTMARK_WEBHOOK_PASSWORD` with those values.
3. In Postmark: Server → Message Streams → `outbound` → Webhooks → **Add webhook**:
   - URL: `https://<user>:<password>@legal-intake-engine-web.onrender.com/api/webhooks/postmark`
   - Tick **Delivery**, **Bounce** and **Spam Complaint**. Leave Open and Click tracking off (the product doesn't track them).
4. Use Postmark's "Send test" button. A 200 response means it is wired up; 401 means the username/password don't match what Render has.

Delivered emails are then marked `delivered` on the outbox row; hard bounces and spam complaints are marked `bounced`, soft bounces `failed`, each with a short reason and an audit-log entry. (Note: the free Render service sleeps after 15 minutes idle; Postmark retries webhooks, so a sleeping service only delays these updates.)

#### Who is told when an email bounces

Hard bounces and spam complaints raise an **internal** alert (code: `src/core/emailBounces.ts`, rules in `src/core/emailBouncePlan.ts`). Soft bounces are only retried; nobody is alerted.

- **A client's email bounced** (founder decision, 2026-10-23): the matter's **responsible lawyer AND every active intake staff member** get the flag "Client email could not be delivered". If the matter has no active lawyer and the firm has no intake staff, the **firm admins** get it instead, so it never goes nowhere. A task, "Confirm a working, safe email address with the client", goes with it: owned by the responsible lawyer (or the firm pool when there is none), due in **8 business hours**, or **2** when the client is DV-sensitive or the bounced notice was urgent (those flags are also raised as high severity). The flag text reminds staff that the notice is still in the client's portal and that they must only use a contact method the client marked safe; for DV-sensitive clients, the responsible lawyer decides how to reach them. Nothing is ever re-sent through another channel or address automatically. Completing the task closes the flag.
- **A staff member's email bounced**: the **firm admins** get "A staff member's email could not be delivered", naming the person, so the address on their account can be fixed. No task.
- One alert per person at a time: while a client's (or staff member's) bounce alert is still open, further bounces and Postmark's webhook retries don't create new flags or tasks.
- If the follow-up task isn't done on time, the normal overdue scan (c45) flags and escalates it like any other task.

### 5. Sign the DPA, then open the gate

1. Sign Postmark's Data Processing Agreement (Postmark account → Policies / DPA). Keep a copy.
2. Record the approval (this is what actually turns sending on):

```
npm run compliance -- approve --gate vendor.email --reviewer vendor_dpa --by "Clayton <your name>"
```

Rows that were held while the gate was closed are retried automatically on the next tick.

### 6. Client emails: attorney wording

Client emails stay held until the attorney approves the client wording gates (`notify.client.flag_update`, `notify.client.generic_update`, `notify.client.reminder`, plus any engine-specific client copy such as `copy.calendar-alerts.ack_notice`). These are in the attorney review packet. Staff emails do not wait on this.

## Checking it works

1. With the gate approved, raise any internal flag in the demo firm (or let the overdue scan raise one).
2. Within a tick or two the staff member named on the flag should receive `[WARNING] …`-style email from the firm's name.
3. In Postmark → Activity you'll see the message; in the outbox row its status moves `pending → sent → delivered`.

## Limits and open items

- Permanent failures (invalid or inactive address) are retried a few times with backoff and then marked `failed`; the adapter can't yet tell the outbox to stop immediately.
- Intake staff and admins are found by the role on each user's account (`users.role` = `intake_staff` / `firm_admin`); extra roles granted through the c99 role assignments are not yet included.
- Production should not rely on the 5-minute GitHub Action; ADR-0001 §D6's persistent worker would send within about a minute.
