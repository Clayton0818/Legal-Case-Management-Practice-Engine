// GET|POST /api/portal/quick-exit — DV safety exit (c11, c112).
//
// Signs the client out everywhere, clears the cookie and cached pages, and
// lands on an unrelated everyday page. The Quick exit button calls this in
// the background (sendBeacon) and replaces the current history entry, so
// Back does not return to the portal; without JavaScript it is a plain link
// to this route.

import type { NextRequest } from "next/server";
import { CLEAR_SITE_DATA, clearSessionCookie, endPortalSessions, seeOther } from "@/portal/http";
import { QUICK_EXIT_URL } from "@/portal/policy";
import { PORTAL_COOKIE } from "@/portal/session";

export const dynamic = "force-dynamic";

async function quickExit(req: NextRequest) {
  await endPortalSessions(req.cookies.get(PORTAL_COOKIE)?.value, "quick_exit");
  return clearSessionCookie(seeOther(QUICK_EXIT_URL, CLEAR_SITE_DATA));
}

export async function GET(req: NextRequest) {
  return quickExit(req);
}

export async function POST(req: NextRequest) {
  return quickExit(req);
}
