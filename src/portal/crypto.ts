// Client portal (c11, c112) — the small amount of cryptography the portal
// needs. Pure (no database, no Next.js), Node runtime only.
//
// Sign-in links carry a random 32-byte token. Only its SHA-256 hash is ever
// stored (as the audit_events entity id), so a database reader cannot
// reconstruct a working link. Addresses and IPs used for rate limiting are
// stored only as keyed hashes (HMAC with CLIENT_SESSION_SECRET), never in
// the clear.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SIGN_IN_TOKEN_BYTES = 32;

/** A fresh, URL-safe sign-in token (32 random bytes, base64url → 43 chars). */
export function generateSignInToken(): string {
  return randomBytes(SIGN_IN_TOKEN_BYTES).toString("base64url");
}

/** True for exactly the shape generateSignInToken() produces. */
export function isWellFormedToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hmacHex(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value, "utf8").digest("hex");
}

export function hmacBase64url(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value, "utf8").digest("base64url");
}

/** Format the first 128 bits of a hex digest as a uuid (audit_events.entity_id is a uuid column). */
export function uuidFromHex(hex: string): string {
  if (!/^[0-9a-f]{32,}$/i.test(hex)) throw new Error("uuidFromHex: need at least 32 hex characters.");
  const h = hex.slice(0, 32).toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** The stored identifier for a sign-in token: a uuid made from SHA-256(token). */
export function tokenEntityId(token: string): string {
  return uuidFromHex(sha256Hex(token));
}

/** A keyed, non-reversible identifier for an address or IP (rate limiting). */
export function keyedEntityId(secret: string, purpose: string, value: string): string {
  return uuidFromHex(hmacHex(secret, `portal.${purpose}:${value}`));
}

/** Constant-time string comparison (false on any length mismatch). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Lowercased, trimmed email, or null when it is not a plausible address. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v.length < 3 || v.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return null;
  return v;
}
