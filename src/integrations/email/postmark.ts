// Postmark adapter for the notification outbox (c51). Implements the
// EmailProvider interface from src/core/notify.ts; installed by ./install.ts
// when EMAIL_PROVIDER=postmark.
//
// Installing this adapter does NOT by itself send anything: every email row
// still has to pass the 'vendor.email' approval gate (signed DPA) and, for
// clients, the attorney-approved wording gate, both checked per row in
// processOutboxRow() before this provider is ever called.
//
// Privacy: plain-text body only, no open or link tracking, and nothing here
// logs the recipient address or the message body. Only ids travel in
// Metadata (tenantId, notificationId), which the delivery webhook
// (src/app/api/webhooks/postmark/route.ts) uses to find the outbox row.
//
// Retries: a 'failed' result is retried by the outbox with backoff and given
// up after a fixed number of attempts (notify.ts MAX_ATTEMPTS), so permanent
// errors (invalid or inactive address) stop on their own; the detail says
// which kind it was.

import type { EmailProvider, OutboundEmail, SendResult } from "@/core/notify";

export const POSTMARK_API_URL = "https://api.postmarkapp.com/email";

export interface PostmarkConfig {
  serverToken: string;
  /** Used when the firm has no verified emailFromAddress of its own. */
  defaultFromAddress: string | null;
  /** Postmark message stream; transactional mail goes on "outbound". */
  messageStream: string;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  /** Request timeout, ms. */
  timeoutMs?: number;
}

interface PostmarkResponse {
  ErrorCode?: number;
  Message?: string;
  MessageID?: string;
}

/** Postmark error codes that will not succeed on retry. */
const PERMANENT_ERROR_DETAIL: Record<number, string> = {
  300: "Invalid email request (Postmark 300): the address or a header was rejected.",
  406: "Recipient marked inactive by Postmark (earlier hard bounce or spam complaint) (Postmark 406).",
  400: "Sender signature not found or not confirmed in Postmark (Postmark 400): verify the sending domain.",
  401: "Sender signature not confirmed in Postmark (Postmark 401).",
};

/** Quote a display name for an RFC 5322 From header; strips line breaks. */
export function formatFrom(name: string, address: string): string {
  const clean = name.replace(/[\r\n]+/g, " ").replace(/["\\]/g, "").trim();
  return clean ? `"${clean}" <${address}>` : address;
}

export class PostmarkEmailProvider implements EmailProvider {
  readonly name = "postmark";
  readonly isStub = false;

  constructor(private readonly config: PostmarkConfig) {
    if (!config.serverToken.trim()) throw new Error("PostmarkEmailProvider: serverToken is required.");
  }

  async sendEmail(message: OutboundEmail): Promise<SendResult> {
    const fromAddress = message.fromAddress ?? this.config.defaultFromAddress;
    if (!fromAddress) {
      return { outcome: "failed", detail: "No sender address: set the firm's email-from address or EMAIL_FROM_ADDRESS." };
    }

    const body: Record<string, unknown> = {
      From: formatFrom(message.fromName, fromAddress),
      To: message.to,
      Subject: message.subject,
      TextBody: message.text,
      MessageStream: this.config.messageStream,
      TrackOpens: false,
      TrackLinks: "None",
      Metadata: { tenantId: message.tenantId, notificationId: message.notificationId },
    };
    if (message.replyTo) body.ReplyTo = message.replyTo;

    const doFetch = this.config.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await doFetch(POSTMARK_API_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Postmark-Server-Token": this.config.serverToken,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000),
      });
    } catch (err) {
      const kind = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "network error";
      return { outcome: "failed", detail: `Postmark request ${kind}; will retry.` };
    }

    let parsed: PostmarkResponse = {};
    try {
      parsed = (await res.json()) as PostmarkResponse;
    } catch {
      // Non-JSON body (e.g. a proxy error page): fall through on the status code.
    }

    if (res.ok && (parsed.ErrorCode ?? 0) === 0 && parsed.MessageID) {
      return { outcome: "sent", providerMessageId: parsed.MessageID };
    }
    if (res.status === 429 || res.status >= 500) {
      return { outcome: "failed", detail: `Postmark temporarily unavailable (HTTP ${res.status}); will retry.` };
    }
    if (res.status === 401) {
      return { outcome: "failed", detail: "Postmark rejected the server token (HTTP 401): check POSTMARK_SERVER_TOKEN." };
    }
    const code = parsed.ErrorCode;
    if (code !== undefined && PERMANENT_ERROR_DETAIL[code]) {
      return { outcome: "failed", detail: PERMANENT_ERROR_DETAIL[code] };
    }
    // Postmark's own Message can echo the recipient address, so it is not copied.
    return { outcome: "failed", detail: `Postmark refused the message (HTTP ${res.status}${code !== undefined ? `, error ${code}` : ""}).` };
  }
}
