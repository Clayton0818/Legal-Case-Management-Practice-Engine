// c89 — the cryptography a share link needs. Pure (node:crypto only), no
// database.
//
// A share token is `shl_<tenant id, 32 hex, no dashes>_<43-char base64url
// secret>` — the SAME trick as the widget public key
// (src/widget/keys.ts): the tenant id travels inside the token so the public,
// unauthenticated endpoint can pick the right tenant's `withTenant()`
// transaction WITHOUT any cross-tenant lookup. That is not where the real
// access control lives, though: once inside that tenant's transaction, the
// row is only found by an exact match on `tokenHash` (SHA-256 of the
// secret, scoped to that same tenant by the table's own tenantId column and
// RLS) — a forged or guessed tenant id with the wrong secret, or a tenant
// id lifted from someone else's token, finds no row either way, so nothing
// about "which tenant" is actually trusted for authorization, only for
// routing. Only the hash of the secret is ever stored; the secret itself
// (and so the whole token) is minted here, returned once to the caller, and
// never persisted.
//
// Token shape deliberately mirrors the client portal's sign-in link
// (src/portal/crypto.ts): 32 random bytes → 43-char base64url.

import { createHash, randomBytes } from "node:crypto";

export const SHARE_TOKEN_SECRET_BYTES = 32;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_RE = /^shl_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/;

/** `firms.id` (a uuid) as the 32 lowercase hex characters a token embeds. */
export function tenantIdToHex(tenantId: string): string {
  const hex = tenantId.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error("tenantIdToHex: tenantId must be a UUID.");
  return hex;
}

/** The reverse of tenantIdToHex — only ever called on a string the token's own regex already validated. */
function hexToTenantId(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isWellFormedShareSecret(value: unknown): value is string {
  return typeof value === "string" && SECRET_RE.test(value);
}

export function hashShareSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export interface GeneratedShareToken {
  /** Shown to the creating request ONCE. Never written to the database. */
  token: string;
  secret: string;
  tokenHash: string;
}

/** A fresh share link token for `tenantId`. `random` is injectable only for tests. */
export function generateShareToken(tenantId: string, random: (n: number) => Buffer = randomBytes): GeneratedShareToken {
  const secret = random(SHARE_TOKEN_SECRET_BYTES).toString("base64url");
  const token = `shl_${tenantIdToHex(tenantId)}_${secret}`;
  return { token, secret, tokenHash: hashShareSecret(secret) };
}

export interface ParsedShareToken {
  tenantId: string;
  secret: string;
}

/** Parse a raw token from the public URL. Null for anything not of this exact shape — never throws on bad input. */
export function parseShareToken(raw: unknown): ParsedShareToken | null {
  if (typeof raw !== "string") return null;
  const m = TOKEN_RE.exec(raw.trim());
  if (!m) return null;
  return { tenantId: hexToTenantId(m[1]!), secret: m[2]! };
}
