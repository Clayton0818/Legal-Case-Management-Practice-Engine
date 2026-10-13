// POST /api/demo/reset must be impossible to aim at a non-demo firm.
// The session, the database and approvals are faked here: the fake
// transaction answers every read with "no rows" (a firm without the demo
// flag) and records any attempted write. The real-database version of this
// refusal is in src/engines/demo/demo.db.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SESSION_TENANT = "33333333-3333-4333-8333-333333333333";
const writes: string[] = [];
const scopes: string[] = [];

function fakeTx(): unknown {
  const chain: unknown = new Proxy(() => {}, {
    get(_t, prop) {
      if (prop === "then") return (resolve: (v: unknown[]) => void) => resolve([]);
      if (typeof prop === "string" && ["insert", "update", "delete", "execute"].includes(prop)) writes.push(prop);
      return chain;
    },
    apply() {
      return chain;
    },
  });
  return chain;
}

vi.mock("@/auth/request", () => ({
  resolveRequestTenantId: async () => SESSION_TENANT,
  requirePrincipal: async () => ({
    tenantId: SESSION_TENANT,
    userId: null,
    role: "firm_admin",
    capabilities: [],
    permissions: ["settings.manage"],
    displayName: "Dev user",
    email: null,
    provider: "dev",
    subject: "dev",
    isDev: true,
  }),
}));
vi.mock("@/compliance/server", () => ({ ensureServerApprovals: async () => {} }));
vi.mock("@/tenancy/withTenant", () => ({
  withTenant: async (tenantId: string, fn: (tx: unknown) => Promise<unknown>) => {
    scopes.push(tenantId);
    return fn(fakeTx());
  },
}));

describe("POST /api/demo/reset", () => {
  const original = process.env.DEMO_RESET_ENABLED;
  beforeEach(() => {
    writes.length = 0;
    scopes.length = 0;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.DEMO_RESET_ENABLED;
    else process.env.DEMO_RESET_ENABLED = original;
  });

  it("is switched off unless DEMO_RESET_ENABLED=1", async () => {
    delete process.env.DEMO_RESET_ENABLED;
    const { POST } = await import("./route");
    const res = await POST();
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/switched off/);
    expect(writes).toEqual([]);
  });

  it("refuses a session whose firm is not the flagged demo firm — before writing anything", async () => {
    process.env.DEMO_RESET_ENABLED = "1";
    const { POST } = await import("./route");
    const res = await POST();
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/does not exist|not the demo firm/);
    expect(writes).toEqual([]);
    // Only the caller's own firm was ever opened.
    expect(new Set(scopes)).toEqual(new Set([SESSION_TENANT]));
  });
});
