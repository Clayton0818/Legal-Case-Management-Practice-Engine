// Pure helpers for Postmark's delivery webhooks (Delivery, Bounce,
// SpamComplaint). The route in src/app/api/webhooks/postmark/route.ts does
// the I/O; everything decidable without a database lives here so it can be
// unit-tested.

import { createHash, timingSafeEqual } from "node:crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Postmark bounce types that are temporary rather than a dead address. */
const SOFT_BOUNCE_TYPES = new Set(["SoftBounce", "Transient", "DnsError", "AutoResponder", "OpenRelayTest", "Unknown"]);

export type WebhookAuthResult = "ok" | "unauthorized" | "not_configured";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Check an HTTP Basic Authorization header against the configured
 * credentials. Fails closed: with either variable unset nothing is accepted.
 * Compares fixed-length digests so the check takes the same time for any input.
 */
export function checkBasicAuth(
  header: string | null,
  expected: { user: string | undefined; password: string | undefined }
): WebhookAuthResult {
  if (!expected.user || !expected.password) return "not_configured";
  if (!header || !header.startsWith("Basic ")) return "unauthorized";
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice("Basic ".length).trim(), "base64").toString("utf8");
  } catch {
    return "unauthorized";
  }
  const ok = timingSafeEqual(digest(decoded), digest(`${expected.user}:${expected.password}`));
  return ok ? "ok" : "unauthorized";
}

export interface DeliveryUpdate {
  tenantId: string;
  providerMessageId: string;
  status: "delivered" | "bounced" | "failed";
  /** Short, address-free reason recorded on the outbox row and audit trail. */
  detail: string | null;
  at: Date | null;
}

export type WebhookDecision = { kind: "update"; update: DeliveryUpdate } | { kind: "ignore"; reason: string };

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function date(v: unknown): Date | null {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Turn one Postmark webhook payload into an outbox status update, or a reason
 * to ignore it. Never copies Postmark's free-text fields (Details, Email,
 * Description can contain the recipient address or message content).
 */
export function decidePostmarkEvent(payload: unknown): WebhookDecision {
  if (!payload || typeof payload !== "object") return { kind: "ignore", reason: "Body is not a JSON object." };
  const p = payload as Record<string, unknown>;
  const recordType = str(p.RecordType);
  const messageId = str(p.MessageID);
  const metadata = p.Metadata && typeof p.Metadata === "object" ? (p.Metadata as Record<string, unknown>) : {};
  const tenantId = str(metadata.tenantId);

  if (!recordType) return { kind: "ignore", reason: "No RecordType." };
  if (recordType !== "Delivery" && recordType !== "Bounce" && recordType !== "SpamComplaint") {
    return { kind: "ignore", reason: `Unhandled RecordType '${recordType}'.` };
  }
  if (!messageId) return { kind: "ignore", reason: "No MessageID." };
  if (!tenantId || !UUID_RE.test(tenantId)) return { kind: "ignore", reason: "No valid tenantId in Metadata." };

  if (recordType === "Delivery") {
    return { kind: "update", update: { tenantId, providerMessageId: messageId, status: "delivered", detail: null, at: date(p.DeliveredAt) } };
  }
  if (recordType === "SpamComplaint") {
    return {
      kind: "update",
      update: { tenantId, providerMessageId: messageId, status: "bounced", detail: "Recipient marked the email as spam.", at: date(p.BouncedAt) },
    };
  }
  const bounceType = str(p.Type) ?? "Bounce";
  const soft = SOFT_BOUNCE_TYPES.has(bounceType);
  return {
    kind: "update",
    update: {
      tenantId,
      providerMessageId: messageId,
      status: soft ? "failed" : "bounced",
      detail: `${soft ? "Temporary" : "Permanent"} bounce (${bounceType.replace(/[^A-Za-z]/g, "").slice(0, 40)}).`,
      at: date(p.BouncedAt),
    },
  };
}
