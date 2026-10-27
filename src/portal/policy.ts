// Client portal (c11, c112) — every decision the portal makes, as pure
// functions (unit-tested in portal.test.ts). Database access lives in
// ./service.ts; HTTP plumbing in src/app/api/portal/**.

import type { AuthMode } from "@/auth/config";
import type { AddressDecision } from "@/core/contacts";
import { normalizeEmail } from "./crypto";

/** A sign-in link works once, for 15 minutes. */
export const SIGN_IN_TOKEN_TTL_MS = 15 * 60_000;
export const SIGN_IN_TOKEN_TTL_MINUTES = SIGN_IN_TOKEN_TTL_MS / 60_000;

/** Rate limits on sign-in requests, per firm, over a sliding 15-minute window. */
export const RATE_WINDOW_MS = 15 * 60_000;
export const MAX_REQUESTS_PER_ADDRESS = 3;
export const MAX_REQUESTS_PER_IP = 10;

/** Only clients of an open (retained) matter can use the portal. */
export const PORTAL_STAGES = ["retained"] as const;

/** Where Quick exit lands: an unrelated, everyday page. */
export const QUICK_EXIT_URL = "https://www.google.com/search?q=weather";

// ---------------------------------------------------------------------------
// Sign-in requests
// ---------------------------------------------------------------------------

/** Counts EXCLUDE the request being decided. */
export function planRateLimit(counts: { addressCount: number; ipCount: number }): { allowed: boolean; reason: string | null } {
  if (counts.addressCount >= MAX_REQUESTS_PER_ADDRESS) {
    return { allowed: false, reason: `More than ${MAX_REQUESTS_PER_ADDRESS} requests for this address in 15 minutes.` };
  }
  if (counts.ipCount >= MAX_REQUESTS_PER_IP) {
    return { allowed: false, reason: `More than ${MAX_REQUESTS_PER_IP} requests from this network in 15 minutes.` };
  }
  return { allowed: true, reason: null };
}

/** The link may be shown on screen only in dev mode, and only for a non-production (demo/test) firm. Never with real (vendor) auth. */
export function linkOnScreenAllowed(authMode: AuthMode, firmIsProduction: boolean): boolean {
  return authMode === "dev" && !firmIsProduction;
}

export type LinkDelivery =
  /** Not this client's safe address (or no client at all): nothing is issued. */
  | { kind: "none"; reason: string }
  /** Dev/demo only: the link is shown on the confirmation screen, not emailed. */
  | { kind: "screen" }
  | { kind: "email"; to: string }
  /** Would be emailed, but a gate or setting is not ready: nothing is issued or sent. */
  | { kind: "held"; reason: string };

/**
 * How (and whether) a sign-in link reaches this person. The link only ever
 * goes to the address resolveClientAddress() picks for the client — so a
 * DV-sensitive client is reachable only at the safe address they chose, and
 * typing the client's ordinary address gets nothing.
 */
export function decideLinkDelivery(input: {
  enteredEmail: string;
  resolved: AddressDecision;
  showOnScreenAllowed: boolean;
  vendorEmailApproved: boolean;
  copyApproved: boolean;
  providerReady: boolean;
  baseUrlReady: boolean;
}): LinkDelivery {
  if (!input.resolved.deliver) return { kind: "none", reason: input.resolved.reason };
  if (normalizeEmail(input.resolved.address) !== input.enteredEmail) {
    return { kind: "none", reason: "Entered address is not the client's resolved (safe) address." };
  }
  if (input.showOnScreenAllowed) return { kind: "screen" };
  if (!input.vendorEmailApproved) return { kind: "held", reason: "Email vendor gate 'vendor.email' is not approved." };
  if (!input.copyApproved) return { kind: "held", reason: "Sign-in email wording is pending attorney review." };
  if (!input.providerReady) return { kind: "held", reason: "No email provider is configured on the web service." };
  if (!input.baseUrlReady) return { kind: "held", reason: "PORTAL_BASE_URL is not set, so no absolute link can be built safely." };
  return { kind: "email", to: input.resolved.address.trim() };
}

// ---------------------------------------------------------------------------
// Sign-in links
// ---------------------------------------------------------------------------

export type TokenUse =
  | { ok: true; partyId: string }
  | { ok: false; reason: "unknown" | "used" | "expired" };

/** Single use + 15-minute expiry, decided from the stored issue/use records. */
export function decideTokenUse(input: {
  issued: { partyId: unknown; expiresAt: unknown } | null;
  alreadyUsed: boolean;
  now: Date;
}): TokenUse {
  if (!input.issued || typeof input.issued.partyId !== "string" || typeof input.issued.expiresAt !== "string") {
    return { ok: false, reason: "unknown" };
  }
  if (input.alreadyUsed) return { ok: false, reason: "used" };
  const exp = Date.parse(input.issued.expiresAt);
  if (!Number.isFinite(exp) || input.now.getTime() >= exp) return { ok: false, reason: "expired" };
  return { ok: true, partyId: input.issued.partyId };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/** The caller's IP for rate limiting (first X-Forwarded-For hop, set by Render's proxy). */
export function clientIp(forwardedFor: string | null, realIp: string | null): string {
  const first = forwardedFor?.split(",")[0]?.trim();
  return first || realIp?.trim() || "unknown";
}

/** Cookie-authenticated POSTs must come from this site (SameSite=Lax is the first line; this is the second). */
export function isSameOriginPost(origin: string | null, host: string | null): boolean {
  if (!origin) return true; // non-browser clients; the cookie is still SameSite=Lax
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

export function isValidSlug(slug: unknown): slug is string {
  return typeof slug === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(slug);
}

/** Portal paths for one firm. */
export function portalPaths(slug: string) {
  const base = `/portal/${encodeURIComponent(slug)}`;
  return {
    home: base,
    signIn: `${base}/sign-in`,
    verify: (token: string) => `${base}/verify?token=${encodeURIComponent(token)}`,
  };
}

/**
 * Absolute URL for a portal path, built ONLY from the configured base URL
 * (PORTAL_BASE_URL) — never from the request's Host header, which a caller
 * controls and could point a sign-in link at their own site. Null when unset.
 */
export function absolutePortalUrl(baseUrl: string | null | undefined, path: string): string | null {
  const base = baseUrl?.trim().replace(/\/+$/, "");
  if (!base || !/^https?:\/\/[^\s/?#]+$/i.test(base)) return null;
  return `${base}${path}`;
}

/** The firm's portal home as an absolute URL ({portalUrl} in client emails); null when no base URL is configured. */
export function portalUrlForFirm(baseUrl: string | null | undefined, slug: string): string | null {
  return absolutePortalUrl(baseUrl, portalPaths(slug).home);
}

/** "Subject: …" first line → subject + body (same convention as src/core/notify.ts). */
export function splitSubject(text: string, fallback: string): { subject: string; body: string } {
  const m = /^Subject:\s*(.+)\r?\n(?:\r?\n)?/.exec(text);
  if (!m) return { subject: fallback, body: text };
  return { subject: (m[1] ?? fallback).trim(), body: text.slice(m[0].length) };
}

// ---------------------------------------------------------------------------
// What the client sees (explicit allow-lists — nothing internal leaks)
// ---------------------------------------------------------------------------

export interface PortalUpdate {
  id: string;
  createdAt: Date;
  read: boolean;
  message: string;
}

export interface PortalTodo {
  id: string;
  title: string;
  description: string | null;
  dueAt: Date;
  pastDue: boolean;
}

export interface PortalDocumentRequest {
  id: string;
  label: string;
  description: string;
  statusLabel: string;
}

export interface PortalMatter {
  id: string;
  openedAt: Date;
}

export function toPortalUpdate(v: { id: string; createdAt: Date; readAt: Date | null; message: string }): PortalUpdate {
  return { id: v.id, createdAt: v.createdAt, read: v.readAt !== null, message: v.message };
}

export function toPortalTodo(v: { id: string; title: string; description: string | null; dueAt: Date; overdue: boolean }): PortalTodo {
  return { id: v.id, title: v.title, description: v.description, dueAt: v.dueAt, pastDue: v.overdue };
}

const CHECKLIST_STATUS_LABELS: Readonly<Record<string, string>> = {
  missing: "Needed",
  requested: "Requested",
  received: "Received — thank you",
  accepted: "Received — thank you",
};

/** Client items still relevant to show; 'not applicable' items are hidden. Status shown in plain words. */
export function toPortalDocumentRequests(
  items: readonly { id: string; label: string; description: string; status: string }[]
): PortalDocumentRequest[] {
  return items
    .filter((i) => i.status !== "not_applicable")
    .map((i) => ({ id: i.id, label: i.label, description: i.description, statusLabel: CHECKLIST_STATUS_LABELS[i.status] ?? "Needed" }));
}
