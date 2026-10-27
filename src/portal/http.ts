// Client portal (c11, c112) — glue shared by the portal's pages and route
// handlers. Database modules are imported lazily so `next build` never
// needs a DATABASE_URL (same pattern as src/app/api/webhooks/postmark).

import { NextResponse } from "next/server";
import type { PortalFirm } from "@/tenancy/firms";
import { isValidSlug } from "./policy";
import {
  CLEARED_COOKIE_OPTIONS,
  decodeSession,
  encodeSession,
  PORTAL_COOKIE,
  readPortalSecret,
  sessionCookieOptions,
  type PortalSession,
} from "./session";

/** Headers that keep portal responses out of caches and history-sniffing referrers. */
export const PORTAL_NO_STORE = { "cache-control": "no-store", "referrer-policy": "no-referrer" } as const;

/** 303 to a same-site path (relative Location — never built from the Host header). */
export function seeOther(location: string, extraHeaders: Record<string, string> = {}): NextResponse {
  return new NextResponse(null, { status: 303, headers: { location, ...PORTAL_NO_STORE, ...extraHeaders } });
}

export function setSessionCookie(res: NextResponse, session: PortalSession, secret: string, now: number): NextResponse {
  res.cookies.set(PORTAL_COOKIE, encodeSession(session, secret), sessionCookieOptions(session, now));
  return res;
}

export function clearSessionCookie(res: NextResponse): NextResponse {
  res.cookies.set(PORTAL_COOKIE, "", CLEARED_COOKIE_OPTIONS);
  return res;
}

export async function loadPortalFirm(slug: unknown): Promise<PortalFirm | null> {
  if (!isValidSlug(slug)) return null;
  const { findPortalFirmBySlug } = await import("@/tenancy/firms");
  return findPortalFirmBySlug(slug);
}

export type LiveSession = { session: PortalSession | null; hadCookie: boolean };

/**
 * The signed-in client for THIS firm, or null: valid signature, within the
 * idle/absolute limits, issued for this firm, not signed out since, and the
 * party is still a client of an open matter.
 */
export async function liveSessionFor(firmId: string, cookieValue: string | undefined, secret: string, now: number): Promise<LiveSession> {
  const hadCookie = Boolean(cookieValue);
  const check = decodeSession(cookieValue, secret, now);
  if (!check.ok || check.session.tenantId !== firmId) return { session: null, hadCookie };
  const { withTenant } = await import("@/tenancy/withTenant");
  const { isSessionLive } = await import("./service");
  const live = await withTenant(firmId, (tx) => isSessionLive(tx, check.session));
  return { session: live ? check.session : null, hadCookie };
}

/**
 * Sign the client out on EVERY device (DV safety: a phone left behind or a
 * shared computer stops working too). Never throws — leaving must not fail.
 */
export async function endPortalSessions(cookieValue: string | undefined, via: "sign_out" | "quick_exit"): Promise<void> {
  const secret = readPortalSecret(process.env);
  if (!secret.ok) return;
  const now = Date.now();
  const check = decodeSession(cookieValue, secret.secret, now);
  if (!check.ok) return;
  const { tenantId, partyId } = check.session;
  try {
    const { withTenant } = await import("@/tenancy/withTenant");
    const { revokeSessions } = await import("./service");
    await withTenant(tenantId, (tx) => revokeSessions(tx, tenantId, partyId, new Date(now), via));
  } catch (err) {
    console.error(
      JSON.stringify({ level: "error", event: "portal.sign_out.failed", via, error: err instanceof Error ? err.message : String(err) })
    );
  }
}

/** Ask the browser to drop cached portal pages and storage (the cookie itself is cleared separately). */
export const CLEAR_SITE_DATA = { "clear-site-data": '"cache", "storage"' } as const;
