import { describe, expect, it } from "vitest";
import { formatFrom, POSTMARK_API_URL, PostmarkEmailProvider } from "./postmark";
import { emailProviderFromEnv } from "./install";
import type { OutboundEmail } from "@/core/notify";

const MESSAGE: OutboundEmail = {
  notificationId: "22222222-2222-4222-8222-222222222222",
  tenantId: "11111111-1111-4111-8111-111111111111",
  to: "client@example.com",
  fromName: "Hart & Okafor",
  fromAddress: null,
  replyTo: "office@firm.example",
  subject: "An update on your matter",
  text: "Please sign in to your portal.",
};

function fakeFetch(status: number, body: unknown, calls: Array<{ url: string; init: RequestInit }> = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

function provider(fetchImpl: typeof fetch, defaultFromAddress: string | null = "alerts@firm.example") {
  return new PostmarkEmailProvider({ serverToken: "token-123", defaultFromAddress, messageStream: "outbound", fetchImpl });
}

describe("PostmarkEmailProvider", () => {
  it("sends a plain-text email with ids-only metadata and no tracking", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const result = await provider(fakeFetch(200, { ErrorCode: 0, Message: "OK", MessageID: "pm-1" }, calls)).sendEmail(MESSAGE);
    expect(result).toEqual({ outcome: "sent", providerMessageId: "pm-1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(POSTMARK_API_URL);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Postmark-Server-Token"]).toBe("token-123");
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      From: '"Hart & Okafor" <alerts@firm.example>',
      To: "client@example.com",
      ReplyTo: "office@firm.example",
      TextBody: "Please sign in to your portal.",
      MessageStream: "outbound",
      TrackOpens: false,
      TrackLinks: "None",
      Metadata: { tenantId: MESSAGE.tenantId, notificationId: MESSAGE.notificationId },
    });
    expect(body.HtmlBody).toBeUndefined();
  });

  it("prefers the firm's own sender address over the default", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    await provider(fakeFetch(200, { ErrorCode: 0, MessageID: "pm-2" }, calls)).sendEmail({ ...MESSAGE, fromAddress: "hello@hartokafor.example" });
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body.From).toBe('"Hart & Okafor" <hello@hartokafor.example>');
  });

  it("fails without calling Postmark when there is no sender address at all", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const result = await provider(fakeFetch(200, {}, calls), null).sendEmail(MESSAGE);
    expect(result.outcome).toBe("failed");
    expect(calls).toHaveLength(0);
  });

  it("treats 5xx, 429 and network errors as retryable failures", async () => {
    expect((await provider(fakeFetch(503, "down")).sendEmail(MESSAGE)).detail).toMatch(/will retry/);
    expect((await provider(fakeFetch(429, {})).sendEmail(MESSAGE)).detail).toMatch(/will retry/);
    const throwing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const result = await provider(throwing).sendEmail(MESSAGE);
    expect(result).toEqual({ outcome: "failed", detail: "Postmark request network error; will retry." });
  });

  it("explains permanent errors without echoing Postmark's message (which can contain the address)", async () => {
    const result = await provider(
      fakeFetch(422, { ErrorCode: 406, Message: "Found inactive addresses: client@example.com." })
    ).sendEmail(MESSAGE);
    expect(result.outcome).toBe("failed");
    expect(result.detail).toMatch(/inactive/);
    expect(result.detail).not.toContain("client@example.com");

    const other = await provider(fakeFetch(422, { ErrorCode: 999, Message: "client@example.com is weird" })).sendEmail(MESSAGE);
    expect(other.detail).toBe("Postmark refused the message (HTTP 422, error 999).");
  });

  it("flags a bad server token clearly", async () => {
    expect((await provider(fakeFetch(401, { ErrorCode: 10, Message: "Bad token" })).sendEmail(MESSAGE)).detail).toMatch(/POSTMARK_SERVER_TOKEN/);
  });

  it("strips quotes and line breaks from the display name", () => {
    expect(formatFrom('Evil"\r\nBcc: x@y', "a@b.example")).toBe('"Evil Bcc: x@y" <a@b.example>');
    expect(formatFrom("  ", "a@b.example")).toBe("a@b.example");
  });
});

describe("emailProviderFromEnv", () => {
  it("keeps the stub unless Postmark is asked for and has a token", () => {
    expect(emailProviderFromEnv({}).provider).toBeNull();
    expect(emailProviderFromEnv({ EMAIL_PROVIDER: "sendgrid" }).reason).toMatch(/Unknown/);
    expect(emailProviderFromEnv({ EMAIL_PROVIDER: "postmark" }).reason).toMatch(/POSTMARK_SERVER_TOKEN/);
  });

  it("builds a real (non-stub) Postmark provider", () => {
    const { provider: p, reason } = emailProviderFromEnv({
      EMAIL_PROVIDER: "Postmark",
      POSTMARK_SERVER_TOKEN: "t",
      EMAIL_FROM_ADDRESS: "alerts@firm.example",
    });
    expect(p?.name).toBe("postmark");
    expect(p?.isStub).toBe(false);
    expect(reason).toBeNull();
  });

  it("warns when there is no default sender address", () => {
    expect(emailProviderFromEnv({ EMAIL_PROVIDER: "postmark", POSTMARK_SERVER_TOKEN: "t" }).reason).toMatch(/EMAIL_FROM_ADDRESS/);
  });
});
