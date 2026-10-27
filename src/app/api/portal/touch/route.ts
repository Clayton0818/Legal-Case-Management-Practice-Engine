// POST /api/portal/touch — restart the 30-minute idle clock while the client
// is active on a portal page (the 8-hour absolute limit never moves).

import { NextResponse, type NextRequest } from "next/server";
import { clearSessionCookie, liveSessionFor, PORTAL_NO_STORE, setSessionCookie } from "@/portal/http";
import { isSameOriginPost } from "@/portal/policy";
import { decodeSession, PORTAL_COOKIE, readPortalSecret, touchSession } from "@/portal/session";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!isSameOriginPost(req.headers.get("origin"), req.headers.get("host"))) {
    return new Response("Forbidden.", { status: 403 });
  }
  const secret = readPortalSecret(process.env);
  const cookie = req.cookies.get(PORTAL_COOKIE)?.value;
  const now = Date.now();
  const check = secret.ok ? decodeSession(cookie, secret.secret, now) : null;
  if (!secret.ok || !check?.ok) {
    return clearSessionCookie(new NextResponse(null, { status: 401, headers: PORTAL_NO_STORE }));
  }
  try {
    const { session } = await liveSessionFor(check.session.tenantId, cookie, secret.secret, now);
    if (!session) return clearSessionCookie(new NextResponse(null, { status: 401, headers: PORTAL_NO_STORE }));
    return setSessionCookie(new NextResponse(null, { status: 204, headers: PORTAL_NO_STORE }), touchSession(session, now), secret.secret, now);
  } catch {
    return new NextResponse(null, { status: 503, headers: PORTAL_NO_STORE });
  }
}
