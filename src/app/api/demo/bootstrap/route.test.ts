// POST /api/demo/bootstrap must stay closed unless BOTH deployment secrets
// are set and correct, and must refuse once a demo firm already exists.
// Everything downstream of the gate (createDemoTenant, loadDemoStatus,
// withTenant) is faked here — the real seed is exercised by
// src/engines/demo/demo.db.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createCalls: unknown[] = [];
let activeDemoTenants: Array<{ tenantId: string }> = [];

vi.mock("@/engines/demo/reset", () => ({
  demoResetEnabled: () => process.env.DEMO_RESET_ENABLED === "1",
  findActiveDemoTenants: async () => activeDemoTenants,
  createDemoTenant: async (_run: unknown, input: unknown) => {
    createCalls.push(input);
    return { tenantId: "11111111-1111-4111-8111-111111111111", generation: 1, summary: { ok: 1, blocked: 0, failed: 0 } };
  },
}));
vi.mock("@/engines/demo/status", () => ({
  loadDemoStatus: async () => ({
    session: { tenantId: "11111111-1111-4111-8111-111111111111", kind: "current_demo" },
    current: {
      tenantId: "11111111-1111-4111-8111-111111111111",
      generation: 1,
      seededAt: new Date(),
      presenterUserId: "22222222-2222-4222-8222-222222222222",
      presenterName: "Dev partner",
      adminUserId: "33333333-3333-4333-8333-333333333333",
      adminName: "Dev admin",
    },
    resetEnabled: true,
  }),
}));
vi.mock("@/tenancy/withTenant", () => ({ withTenant: async (_id: string, fn: (tx: unknown) => Promise<unknown>) => fn({}) }));

describe("POST /api/demo/bootstrap", () => {
  const originalEnabled = process.env.DEMO_RESET_ENABLED;
  const originalSecret = process.env.DEMO_BOOTSTRAP_SECRET;

  beforeEach(() => {
    createCalls.length = 0;
    activeDemoTenants = [];
  });
  afterEach(() => {
    if (originalEnabled === undefined) delete process.env.DEMO_RESET_ENABLED;
    else process.env.DEMO_RESET_ENABLED = originalEnabled;
    if (originalSecret === undefined) delete process.env.DEMO_BOOTSTRAP_SECRET;
    else process.env.DEMO_BOOTSTRAP_SECRET = originalSecret;
  });

  function request(secret: string | null): Request {
    const headers = new Headers();
    if (secret !== null) headers.set("x-demo-bootstrap-secret", secret);
    return new Request("http://localhost/api/demo/bootstrap", { method: "POST", headers });
  }

  it("refuses unless DEMO_RESET_ENABLED=1, even with the right secret", async () => {
    delete process.env.DEMO_RESET_ENABLED;
    process.env.DEMO_BOOTSTRAP_SECRET = "s3cret";
    const { POST } = await import("./route");
    const res = await POST(request("s3cret"));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/switched off/);
    expect(createCalls).toEqual([]);
  });

  it("refuses when DEMO_BOOTSTRAP_SECRET is not configured on this deployment", async () => {
    process.env.DEMO_RESET_ENABLED = "1";
    delete process.env.DEMO_BOOTSTRAP_SECRET;
    const { POST } = await import("./route");
    const res = await POST(request("anything"));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/not configured/);
    expect(createCalls).toEqual([]);
  });

  it("refuses a missing or incorrect secret", async () => {
    process.env.DEMO_RESET_ENABLED = "1";
    process.env.DEMO_BOOTSTRAP_SECRET = "s3cret";
    const { POST } = await import("./route");

    const noHeader = await POST(request(null));
    expect(noHeader.status).toBe(403);
    const wrong = await POST(request("nope"));
    expect(wrong.status).toBe(403);
    const differentLength = await POST(request("s3cret-but-longer"));
    expect(differentLength.status).toBe(403);
    expect(createCalls).toEqual([]);
  });

  it("refuses once a demo firm already exists, without creating another", async () => {
    process.env.DEMO_RESET_ENABLED = "1";
    process.env.DEMO_BOOTSTRAP_SECRET = "s3cret";
    activeDemoTenants = [{ tenantId: "99999999-9999-4999-8999-999999999999" }];
    const { POST } = await import("./route");
    const res = await POST(request("s3cret"));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/already exists/);
    expect(createCalls).toEqual([]);
  });

  it("creates the first demo firm when enabled, the secret matches, and none exists yet", async () => {
    process.env.DEMO_RESET_ENABLED = "1";
    process.env.DEMO_BOOTSTRAP_SECRET = "s3cret";
    const { POST } = await import("./route");
    const res = await POST(request("s3cret"));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { tenantId: string; presenterUserId: string | null; next: string };
    expect(body.tenantId).toBe("11111111-1111-4111-8111-111111111111");
    expect(body.presenterUserId).toBe("22222222-2222-4222-8222-222222222222");
    expect(body.next).toMatch(/DEV_TENANT_ID=11111111-1111-4111-8111-111111111111/);
    expect(createCalls).toHaveLength(1);
  });
});
