// POST /api/webhooks/postmark — Postmark delivery callbacks (Delivery,
// Bounce, SpamComplaint) for emails sent from the notification outbox (c51).
//
// Protected by HTTP Basic auth: configure the webhook in Postmark as
//   https://<user>:<password>@<this host>/api/webhooks/postmark
// with the same values in POSTMARK_WEBHOOK_USER / POSTMARK_WEBHOOK_PASSWORD
// here. Fails closed: if either is unset every call is refused.
//
// The firm is identified by the tenantId we put in the message's Metadata
// when sending (src/integrations/email/postmark.ts); the update then runs in
// that firm's withTenant() scope and only touches the row whose
// providerMessageId matches, so a forged id can't reach another firm's data.
// Unknown or irrelevant events get 200 so Postmark doesn't keep retrying them.
//
// Database modules are imported lazily so `next build` never needs a
// DATABASE_URL (same pattern as src/app/api/demo/bootstrap/route.ts).

import { checkBasicAuth, decidePostmarkEvent } from "@/integrations/email/postmarkWebhook";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = checkBasicAuth(req.headers.get("authorization"), {
    user: process.env.POSTMARK_WEBHOOK_USER,
    password: process.env.POSTMARK_WEBHOOK_PASSWORD,
  });
  if (auth !== "ok") {
    return Response.json(
      { error: auth === "not_configured" ? "Webhook credentials are not configured on this deployment." : "Unauthorized." },
      { status: 401, headers: { "WWW-Authenticate": 'Basic realm="postmark-webhook"' } }
    );
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ ok: true, ignored: "Body is not JSON." });
  }

  const decision = decidePostmarkEvent(payload);
  if (decision.kind === "ignore") return Response.json({ ok: true, ignored: decision.reason });

  const { update } = decision;
  try {
    const { withTenant } = await import("@/tenancy/withTenant");
    const { recordDeliveryStatus } = await import("@/core/notify");
    const row = await withTenant(update.tenantId, (tx) =>
      recordDeliveryStatus(tx, {
        tenantId: update.tenantId,
        providerMessageId: update.providerMessageId,
        status: update.status,
        ...(update.detail ? { detail: update.detail } : {}),
        ...(update.at ? { at: update.at } : {}),
      })
    );
    return Response.json({ ok: true, matched: row !== null, status: update.status });
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "postmark_webhook.failed",
        tenantId: update.tenantId,
        error: err instanceof Error ? err.message : String(err),
      })
    );
    // 500 so Postmark retries a genuinely failed write later.
    return Response.json({ error: "Could not record the delivery status." }, { status: 500 });
  }
}
