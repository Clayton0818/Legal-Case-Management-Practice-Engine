// POST /api/portal/sign-in — "email me a sign-in link" (c11).
//
// Always answers with the same neutral confirmation, whether or not the
// address belongs to a client (no account enumeration), and whether or not
// the request was rate-limited. The link is only ever sent to the address
// resolveClientAddress() picks for the client (safe-contact / DV rules), and
// only when the 'vendor.email' gate, the attorney-approved sign-in wording,
// a real email provider and PORTAL_BASE_URL are all in place. In dev mode, for
// a non-production firm only, the link is shown on screen instead.

import { randomUUID } from "node:crypto";
import { after, type NextRequest } from "next/server";
import { resolveAuthConfig } from "@/auth/config";
import { keyedEntityId, normalizeEmail } from "@/portal/crypto";
import { loadPortalFirm, seeOther } from "@/portal/http";
import { absolutePortalUrl, clientIp, isSameOriginPost, isValidSlug, linkOnScreenAllowed, portalPaths } from "@/portal/policy";
import { readPortalSecret } from "@/portal/session";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!isSameOriginPost(req.headers.get("origin"), req.headers.get("host"))) {
    return new Response("Forbidden.", { status: 403 });
  }
  const form = await req.formData().catch(() => null);
  const slug = form?.get("firm");
  if (!isValidSlug(slug)) return seeOther("/portal");
  const paths = portalPaths(slug);

  const secret = readPortalSecret(process.env);
  if (!secret.ok) {
    console.error(JSON.stringify({ level: "error", event: "portal.disabled", reason: secret.reason }));
    return seeOther(`${paths.signIn}?error=unavailable`);
  }
  const email = normalizeEmail(form?.get("email"));
  if (!email) return seeOther(`${paths.signIn}?error=email`);

  try {
    const firm = await loadPortalFirm(slug);
    if (!firm) return seeOther(`${paths.signIn}?sent=1`);

    const { ensureServerApprovals } = await import("@/compliance/server");
    await ensureServerApprovals();
    const { emailProviderFromEnv } = await import("@/integrations/email/install");
    const { withTenant } = await import("@/tenancy/withTenant");
    const { requestSignInLink, recordSignInEmail } = await import("@/portal/service");

    const provider = emailProviderFromEnv(process.env).provider;
    const baseUrl = process.env.PORTAL_BASE_URL;
    const now = new Date();
    const outcome = await withTenant(firm.id, (tx) =>
      requestSignInLink(tx, {
        tenantId: firm.id,
        firmName: firm.name,
        email,
        addressId: keyedEntityId(secret.secret, "address", email),
        ipId: keyedEntityId(secret.secret, "ip", clientIp(req.headers.get("x-forwarded-for"), req.headers.get("x-real-ip"))),
        now,
        showOnScreenAllowed: linkOnScreenAllowed(resolveAuthConfig(process.env).mode, firm.isProduction),
        providerReady: provider !== null && !provider.isStub,
        linkFor: absolutePortalUrl(baseUrl, paths.home) ? (token) => absolutePortalUrl(baseUrl, paths.verify(token)) ?? "" : null,
      })
    );

    if (outcome.kind === "screen") return seeOther(`${paths.signIn}?sent=1&dev=${encodeURIComponent(outcome.token)}`);
    if (outcome.kind === "email" && provider) {
      // Sent after the response so a matching address doesn't answer
      // measurably slower than a non-matching one (timing enumeration).
      after(async () => {
        let result: { outcome: string; detail?: string | null };
        try {
          result = await provider.sendEmail({
            notificationId: randomUUID(),
            tenantId: firm.id,
            to: outcome.to,
            fromName: outcome.fromName,
            fromAddress: outcome.fromAddress,
            replyTo: outcome.replyTo,
            subject: outcome.subject,
            text: outcome.text,
          });
        } catch (err) {
          result = { outcome: "failed", detail: err instanceof Error ? err.message : String(err) };
        }
        await withTenant(firm.id, (tx) => recordSignInEmail(tx, firm.id, outcome.partyId, result, new Date()));
      });
    }
    return seeOther(`${paths.signIn}?sent=1`);
  } catch (err) {
    console.error(
      JSON.stringify({ level: "error", event: "portal.sign_in.failed", error: err instanceof Error ? err.message : String(err) })
    );
    return seeOther(`${paths.signIn}?error=unavailable`);
  }
}
