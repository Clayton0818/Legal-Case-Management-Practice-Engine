// c89 — outbound document sharing: pure decision logic. No database (see
// ./service.ts for that), same split as src/engines/document/access/policy.ts.

export const RECIPIENT_TYPES = ["client", "opposing_counsel", "expert", "other"] as const;
export type RecipientType = (typeof RECIPIENT_TYPES)[number];

export function isRecipientType(v: unknown): v is RecipientType {
  return typeof v === "string" && (RECIPIENT_TYPES as readonly string[]).includes(v);
}

/**
 * Tags that are never shared outside the firm without an explicit lawyer
 * override. Duplicated locally rather than imported from core/permissions.ts
 * on purpose — this engine does not import other engines' internals, the
 * same reason access/policy.ts hardcodes its own client-visible rule instead
 * of importing core/permissions.ts's PRIVILEGED / CLIENT_SAFE_PRIVILEGE sets.
 * Kept in sync with documents_privilege_tag_check (schema.ts).
 */
const PRIVILEGED_TAGS = new Set(["privileged", "work_product", "sealed"]);
const CLIENT_SAFE_TAGS = new Set(["none", "confidential"]);

/** A link lives at most this many days — keeps "expiring" meaningful even if a caller asks for longer. */
export const MAX_SHARE_LINK_DAYS = 90;

/**
 * Does creating this link need the explicit, separate privileged-override
 * confirmation (service.ts createShareLink)? True when the document itself
 * is tagged privileged/work product/sealed, OR when it is going to a
 * 'client' recipient and a lawyer has not already marked it clientVisible
 * (the same bar c88/updateDocumentGroup holds clientVisible to).
 */
export function requiresPrivilegedOverride(doc: { privilegeTag: string; clientVisible: boolean }, recipientType: RecipientType): boolean {
  if (PRIVILEGED_TAGS.has(doc.privilegeTag)) return true;
  if (recipientType === "client" && !(doc.clientVisible && CLIENT_SAFE_TAGS.has(doc.privilegeTag))) return true;
  return false;
}

export interface CreateShareLinkCandidate {
  recipientType: unknown;
  recipientLabel?: unknown;
  expiresAt: unknown;
  maxDownloads?: unknown;
  confirmSharePrivileged?: unknown;
  privilegedOverrideReason?: unknown;
}

export type CreateShareLinkCheck =
  | { ok: true; expiresAt: Date; maxDownloads: number | null; recipientLabel: string | null }
  | { ok: false; errors: string[] };

/**
 * Validate the shape of a create-link request and whether the override was
 * actually supplied when `needsOverride` says it must be. Pure: the caller
 * (service.ts) already decided `needsOverride` from the document's own
 * privilegeTag/clientVisible, which this function never sees.
 */
export function validateCreateShareLinkInput(input: CreateShareLinkCandidate, needsOverride: boolean, now: Date): CreateShareLinkCheck {
  const errors: string[] = [];
  if (!isRecipientType(input.recipientType)) errors.push(`recipientType must be one of ${RECIPIENT_TYPES.join(", ")}.`);

  let recipientLabel: string | null = null;
  if (input.recipientLabel !== undefined && input.recipientLabel !== null) {
    if (typeof input.recipientLabel !== "string") errors.push("recipientLabel must be text.");
    else if (input.recipientLabel.trim().length > 200) errors.push("recipientLabel is too long.");
    else recipientLabel = input.recipientLabel.trim() || null;
  }

  let expiresAt: Date | null = null;
  if (typeof input.expiresAt !== "string" && !(input.expiresAt instanceof Date)) {
    errors.push("expiresAt is required.");
  } else {
    const d = input.expiresAt instanceof Date ? input.expiresAt : new Date(input.expiresAt);
    if (Number.isNaN(d.getTime())) errors.push("expiresAt is not a valid date.");
    else if (d.getTime() <= now.getTime()) errors.push("expiresAt must be in the future.");
    else if (d.getTime() > now.getTime() + MAX_SHARE_LINK_DAYS * 86_400_000) errors.push(`A share link cannot be set to expire more than ${MAX_SHARE_LINK_DAYS} days out.`);
    else expiresAt = d;
  }

  let maxDownloads: number | null = null;
  if (input.maxDownloads !== undefined && input.maxDownloads !== null) {
    if (typeof input.maxDownloads !== "number" || !Number.isInteger(input.maxDownloads) || input.maxDownloads < 1) {
      errors.push("maxDownloads must be a whole number of at least 1.");
    } else maxDownloads = input.maxDownloads;
  }

  if (needsOverride) {
    if (input.confirmSharePrivileged !== true) errors.push("This document needs an explicit confirmation to share it outside the firm (confirmSharePrivileged).");
    if (typeof input.privilegedOverrideReason !== "string" || !input.privilegedOverrideReason.trim()) {
      errors.push("A reason is required to share this document outside the firm.");
    }
  }

  if (errors.length > 0 || !expiresAt) return { ok: false, errors: errors.length ? errors : ["expiresAt is required."] };
  return { ok: true, expiresAt, maxDownloads, recipientLabel };
}

export interface ShareLinkState {
  expiresAt: Date;
  revokedAt: Date | null;
  maxDownloads: number | null;
  downloadCount: number;
}

export type ShareAccessAction = "view" | "download";

export type ShareAccessReason = "expired" | "revoked" | "download_limit";

export type ShareAccessDecision = { allowed: true } | { allowed: false; reason: ShareAccessReason };

/** Pure: may this link still be used for `action`, given its current state? */
export function decideShareAccess(link: ShareLinkState, action: ShareAccessAction, now: Date): ShareAccessDecision {
  if (link.revokedAt !== null) return { allowed: false, reason: "revoked" };
  if (now.getTime() >= link.expiresAt.getTime()) return { allowed: false, reason: "expired" };
  if (action === "download" && link.maxDownloads !== null && link.downloadCount >= link.maxDownloads) {
    return { allowed: false, reason: "download_limit" };
  }
  return { allowed: true };
}

/** The HTTP status the public endpoint answers with for a denial, with no further detail in the body. */
export function statusForShareDenial(reason: ShareAccessReason | "invalid_token" | "integrity_failed"): number {
  switch (reason) {
    case "invalid_token":
      return 404;
    case "expired":
    case "revoked":
      return 410;
    case "download_limit":
      return 429;
    case "integrity_failed":
      return 403;
  }
}
