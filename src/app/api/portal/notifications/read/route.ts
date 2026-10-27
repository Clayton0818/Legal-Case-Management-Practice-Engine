// POST /api/portal/notifications/read — the client marks one of THEIR OWN
// updates read (markNotificationRead is filtered to the signed-in party).

import type { NextRequest } from "next/server";
import { liveSessionFor, loadPortalFirm, seeOther, setSessionCookie } from "@/portal/http";
import { isSameOriginPost, isValidSlug, portalPaths } from "@/portal/policy";
import { PORTAL_COOKIE, readPortalSecret, touchSession } from "@/portal/session";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
  if (!isSameOriginPost(req.headers.get("origin"), req.headers.get("host"))) {
    return new Response("Forbidden.", { status: 403 });
  }
  const form = await req.formData().catch(() => null);
  const slug = form?.get("firm");
  const id = form?.get("id");
  if (!isValidSlug(slug)) return seeOther("/portal");
  const paths = portalPaths(slug);
  const secret = readPortalSecret(process.env);
  if (!secret.ok) return seeOther(`${paths.signIn}?error=unavailable`);

  try {
    const firm = await loadPortalFirm(slug);
    if (!firm) return seeOther("/portal");
    const now = Date.now();
    const { session } = await liveSessionFor(firm.id, req.cookies.get(PORTAL_COOKIE)?.value, secret.secret, now);
    if (!session) return seeOther(`${paths.signIn}?expired=1`);
    if (typeof id === "string" && UUID.test(id)) {
      const { withTenant } = await import("@/tenancy/withTenant");
      const { markNotificationRead } = await import("@/core/notify");
      await withTenant(firm.id, (tx) =>
        markNotificationRead(tx, firm.id, id, { type: "party", partyId: session.partyId }, new Date(now))
      );
    }
    return setSessionCookie(seeOther(`${paths.home}#updates`), touchSession(session, now), secret.secret, now);
  } catch (err) {
    console.error(
      JSON.stringify({ level: "error", event: "portal.mark_read.failed", error: err instanceof Error ? err.message : String(err) })
    );
    return seeOther(`${paths.home}#updates`);
  }
}
