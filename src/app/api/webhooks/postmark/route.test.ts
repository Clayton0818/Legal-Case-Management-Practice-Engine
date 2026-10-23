// The Postmark webhook must refuse anything without the configured Basic
// credentials, ignore events it can't attribute to a firm, and record
// Delivery / Bounce / SpamComplaint against the right firm. Database calls are
// faked; checkBasicAuth and decidePostmarkEvent run for real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkBasicAuth, decidePostmarkEvent } from "@/integrations/email/postmarkWebhook";

const recorded: Array<{ tenantScope: string; input: Record<string, unknown> }> = [];
let scope = "";

vi.mock("@/tenancy/withTenant", () => ({
  withTenant: async (tenantId: string, fn: (tx: unknown) => Promise<unknown>) => {
    scope = tenantId;
    return fn({});
  },
}));
vi.mock("@/core/notify", () => ({
  recordDeliveryStatus: async (_tx: unknown, input: Record<string, unknown>) => {
    recorded.push({ tenantScope: scope, input });
    return { id: "row-1" };
  },
}));

const TENANT = "11111111-1111-4111-8111-111111111111";
const AUTH = `Basic ${Buffer.from("pm:s3cret").toString("base64")}`;

function request(body: unknown, auth: string | null = AUTH): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (auth) headers.set("Authorization", auth);
  return new Request("http://localhost/api/webhooks/postmark", { method: "POST", headers, body: JSON.stringify(body) });
}

describe("POST /api/webhooks/postmark", () => {
  const original = { user: process.env.POSTMARK_WEBHOOK_USER, password: process.env.POSTMARK_WEBHOOK_PASSWORD };

  beforeEach(() => {
    recorded.length = 0;
    process.env.POSTMARK_WEBHOOK_USER = "pm";
    process.env.POSTMARK_WEBHOOK_PASSWORD = "s3cret";
  });
  afterEach(() => {
    if (original.user === undefined) delete process.env.POSTMARK_WEBHOOK_USER;
    else process.env.POSTMARK_WEBHOOK_USER = original.user;
    if (original.password === undefined) delete process.env.POSTMARK_WEBHOOK_PASSWORD;
    else process.env.POSTMARK_WEBHOOK_PASSWORD = original.password;
  });

  it("refuses when credentials are not configured (fails closed)", async () => {
    delete process.env.POSTMARK_WEBHOOK_PASSWORD;
    const { POST } = await import("./route");
    const res = await POST(request({ RecordType: "Delivery" }));
    expect(res.status).toBe(401);
    expect(recorded).toEqual([]);
  });

  it("refuses missing or wrong credentials", async () => {
    const { POST } = await import("./route");
    expect((await POST(request({ RecordType: "Delivery" }, null))).status).toBe(401);
    expect((await POST(request({ RecordType: "Delivery" }, `Basic ${Buffer.from("pm:nope").toString("base64")}`))).status).toBe(401);
    expect(recorded).toEqual([]);
  });

  it("records a delivery inside the sending firm's tenant scope", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      request({ RecordType: "Delivery", MessageID: "pm-1", DeliveredAt: "2026-10-23T10:00:00Z", Metadata: { tenantId: TENANT } })
    );
    expect(res.status).toBe(200);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.tenantScope).toBe(TENANT);
    expect(recorded[0]!.input).toMatchObject({ tenantId: TENANT, providerMessageId: "pm-1", status: "delivered" });
  });

  it("ignores (200) events it cannot attribute, without touching the database", async () => {
    const { POST } = await import("./route");
    for (const body of [
      { RecordType: "Open", MessageID: "pm-1", Metadata: { tenantId: TENANT } },
      { RecordType: "Delivery", MessageID: "pm-1", Metadata: { tenantId: "not-a-uuid" } },
      { RecordType: "Delivery", Metadata: { tenantId: TENANT } },
    ]) {
      const res = await POST(request(body));
      expect(res.status).toBe(200);
    }
    expect(recorded).toEqual([]);
  });
});

describe("decidePostmarkEvent", () => {
  it("maps hard bounces and spam complaints to bounced, soft bounces to failed", () => {
    const hard = decidePostmarkEvent({ RecordType: "Bounce", Type: "HardBounce", MessageID: "m", Metadata: { tenantId: TENANT }, Email: "x@y.example" });
    expect(hard).toMatchObject({ kind: "update", update: { status: "bounced", detail: "Permanent bounce (HardBounce)." } });
    const soft = decidePostmarkEvent({ RecordType: "Bounce", Type: "SoftBounce", MessageID: "m", Metadata: { tenantId: TENANT } });
    expect(soft).toMatchObject({ kind: "update", update: { status: "failed" } });
    const spam = decidePostmarkEvent({ RecordType: "SpamComplaint", MessageID: "m", Metadata: { tenantId: TENANT } });
    expect(spam).toMatchObject({ kind: "update", update: { status: "bounced" } });
  });

  it("never copies the recipient address into the recorded detail", () => {
    const d = decidePostmarkEvent({ RecordType: "Bounce", Type: "HardBounce", MessageID: "m", Metadata: { tenantId: TENANT }, Email: "x@y.example", Details: "x@y.example unknown" });
    expect(JSON.stringify(d)).not.toContain("x@y.example");
  });
});

describe("checkBasicAuth", () => {
  it("accepts only the exact configured pair", () => {
    const expected = { user: "pm", password: "s3cret" };
    expect(checkBasicAuth(AUTH, expected)).toBe("ok");
    expect(checkBasicAuth(`Basic ${Buffer.from("pm:s3cret!").toString("base64")}`, expected)).toBe("unauthorized");
    expect(checkBasicAuth("Bearer abc", expected)).toBe("unauthorized");
    expect(checkBasicAuth(AUTH, { user: "pm", password: undefined })).toBe("not_configured");
  });
});
