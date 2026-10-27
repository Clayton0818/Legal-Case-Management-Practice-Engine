// POST /api/portal/sign-out — sign the client out on every device (c11, c112).

import type { NextRequest } from "next/server";
import { CLEAR_SITE_DATA, clearSessionCookie, endPortalSessions, seeOther } from "@/portal/http";
import { isSameOriginPost, isValidSlug, portalPaths } from "@/portal/policy";
import { PORTAL_COOKIE } from "@/portal/session";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!isSameOriginPost(req.headers.get("origin"), req.headers.get("host"))) {
    return new Response("Forbidden.", { status: 403 });
  }
  const form = await req.formData().catch(() => null);
  const slug = form?.get("firm");
  await endPortalSessions(req.cookies.get(PORTAL_COOKIE)?.value, "sign_out");
  const to = isValidSlug(slug) ? `${portalPaths(slug).signIn}?signedOut=1` : "/portal";
  return clearSessionCookie(seeOther(to, CLEAR_SITE_DATA));
}
