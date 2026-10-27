// Client portal (c11, c112) — the client's session cookie. Pure.
//
// Completely separate from staff auth (src/auth/**): its own cookie, its own
// secret (CLIENT_SESSION_SECRET), and it only ever names one firm and one
// party. The cookie is `<payload>.<signature>`, where payload is base64url
// JSON {v, t: tenantId, p: partyId, iat, seen} and the signature is
// HMAC-SHA256 over it with a key derived from the secret.
//
// Limits: 30 minutes idle (the `seen` time is refreshed by activity) and
// 8 hours absolute from sign-in. Server-side "sign out everywhere" is an
// audit row checked on every request (src/portal/service.ts), so a stolen
// cookie dies when the client signs out on any device.

import { hmacBase64url, safeEqual } from "./crypto";

export const PORTAL_COOKIE = "__Host-portal_session";
export const IDLE_TIMEOUT_MS = 30 * 60_000;
export const ABSOLUTE_TIMEOUT_MS = 8 * 60 * 60_000;
export const MIN_SECRET_LENGTH = 32;

export interface PortalSession {
  tenantId: string;
  partyId: string;
  /** Sign-in time (ms since epoch). */
  issuedAt: number;
  /** Last activity (ms since epoch). */
  lastSeenAt: number;
}

export type SecretResult = { ok: true; secret: string } | { ok: false; reason: string };

/** Fail closed: no secret (or a short one) means the portal is switched off. */
export function readPortalSecret(env: Readonly<Record<string, string | undefined>>): SecretResult {
  const secret = env.CLIENT_SESSION_SECRET?.trim() ?? "";
  if (!secret) return { ok: false, reason: "CLIENT_SESSION_SECRET is not set; the client portal is switched off." };
  if (secret.length < MIN_SECRET_LENGTH) {
    return { ok: false, reason: `CLIENT_SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters; the client portal is switched off.` };
  }
  return { ok: true, secret };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sessionKey(secret: string): string {
  return hmacBase64url(secret, "portal-session-key.v1");
}

export function encodeSession(session: PortalSession, secret: string): string {
  const payload = Buffer.from(
    JSON.stringify({ v: 1, t: session.tenantId, p: session.partyId, iat: session.issuedAt, seen: session.lastSeenAt }),
    "utf8"
  ).toString("base64url");
  return `${payload}.${hmacBase64url(sessionKey(secret), payload)}`;
}

export type SessionCheck =
  | { ok: true; session: PortalSession }
  | { ok: false; reason: "missing" | "malformed" | "bad_signature" | "expired" | "idle" };

export function decodeSession(value: string | null | undefined, secret: string, now: number): SessionCheck {
  if (!value) return { ok: false, reason: "missing" };
  const parts = value.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [payload, sig] = parts as [string, string];
  if (!safeEqual(sig, hmacBase64url(sessionKey(secret), payload))) return { ok: false, reason: "bad_signature" };
  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!data || typeof data !== "object") return { ok: false, reason: "malformed" };
  const d = data as Record<string, unknown>;
  if (d.v !== 1 || typeof d.t !== "string" || typeof d.p !== "string" || !UUID.test(d.t) || !UUID.test(d.p)) {
    return { ok: false, reason: "malformed" };
  }
  if (typeof d.iat !== "number" || typeof d.seen !== "number" || !Number.isFinite(d.iat) || !Number.isFinite(d.seen)) {
    return { ok: false, reason: "malformed" };
  }
  // A clock-skewed future timestamp is treated as malformed rather than trusted.
  if (d.iat > now + 60_000 || d.seen > now + 60_000 || d.seen < d.iat) return { ok: false, reason: "malformed" };
  if (now - d.iat >= ABSOLUTE_TIMEOUT_MS) return { ok: false, reason: "expired" };
  if (now - d.seen >= IDLE_TIMEOUT_MS) return { ok: false, reason: "idle" };
  return { ok: true, session: { tenantId: d.t, partyId: d.p, issuedAt: d.iat, lastSeenAt: d.seen } };
}

/** The same session with its idle clock restarted (never extends the 8-hour limit). */
export function touchSession(session: PortalSession, now: number): PortalSession {
  return { ...session, lastSeenAt: Math.max(session.lastSeenAt, now) };
}

export interface PortalCookieOptions {
  httpOnly: true;
  secure: true;
  sameSite: "lax";
  path: "/";
  maxAge: number;
}

/** Cookie attributes: the browser drops it at whichever limit comes first. */
export function sessionCookieOptions(session: PortalSession, now: number): PortalCookieOptions {
  const until = Math.min(session.issuedAt + ABSOLUTE_TIMEOUT_MS, session.lastSeenAt + IDLE_TIMEOUT_MS);
  return { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: Math.max(0, Math.floor((until - now) / 1000)) };
}

export const CLEARED_COOKIE_OPTIONS: PortalCookieOptions = Object.freeze({
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
  maxAge: 0,
});
