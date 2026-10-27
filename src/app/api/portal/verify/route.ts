// POST /api/portal/verify — exchange a one-time sign-in link for a session (c11).
//
// The emailed link opens /portal/<firm>/verify, a page with a "Continue"
// button that POSTs here. A GET never consumes the token, so email
// link-scanners that pre-open links cannot burn it.

import type { NextRequest } from "next/server";
import { isWellFormedToken } from "@/portal/crypto";
import { loadPortalFirm, seeOther, setSessionCookie } from "@/portal/http";
import { isSameOriginPost, isValidSlug, portalPaths } from "@/portal/policy";
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
  if (!secret.ok) return seeOther(`${paths.signIn}?error=unavailable`);
  const token = form?.get("token");
  if (!isWellFormedToken(token)) return seeOther(`${paths.signIn}?expired=1`);

  try {
    const firm = await loadPortalFirm(slug);
    if (!firm) return seeOther(`${paths.signIn}?expired=1`);
    const { withTenant } = await import("@/tenancy/withTenant");
    const { consumeSignInLink } = await import("@/portal/service");
    const now = new Date();
    const use = await withTenant(firm.id, (tx) => consumeSignInLink(tx, firm.id, token, now));
    if (!use.ok) return seeOther(`${paths.signIn}?expired=1`);
    const at = now.getTime();
    return setSessionCookie(seeOther(paths.home), { tenantId: firm.id, partyId: use.partyId, issuedAt: at, lastSeenAt: at }, secret.secret, at);
  } catch (err) {
    console.error(
      JSON.stringify({ level: "error", event: "portal.verify.failed", error: err instanceof Error ? err.message : String(err) })
    );
    return seeOther(`${paths.signIn}?error=unavailable`);
  }
}
