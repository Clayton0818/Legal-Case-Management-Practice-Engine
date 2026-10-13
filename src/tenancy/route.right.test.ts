// tenantRoute({ right }) — the permission check, with the principal, the role
// lookup and the audit sink mocked (the DB version is route.right.db.test.ts).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantTx } from "./withTenant";

const audited: Array<Record<string, unknown>> = [];
let roles: string[] = [];

vi.mock("@/auth/request", () => ({
  requirePrincipal: async () => ({ userId: "00000000-0000-4000-8000-000000000001", role: "intake_staff", capabilities: [] }),
}));
vi.mock("@/core/permissionActor", () => ({
  loadPolicyActor: async () => ({
    userId: "00000000-0000-4000-8000-000000000001",
    baseRoles: roles,
    assignedRoles: [],
    roles,
    actor: { kind: "staff", userId: "00000000-0000-4000-8000-000000000001", roles, status: "active" },
    config: { overrides: [] },
  }),
}));
vi.mock("@/core/audit", () => ({ audit: async (_tx: unknown, row: Record<string, unknown>) => void audited.push(row) }));

const { FORBIDDEN_BODY, outcomeResponse, runTenantHandler } = await import("./route");
const tx = {} as TenantTx;
const T = "00000000-0000-4000-8000-0000000000f1";

describe("tenantRoute permission option", () => {
  beforeEach(() => {
    audited.length = 0;
  });

  it("refuses with 403, says nothing about why, never runs the handler, and audits the reason", async () => {
    roles = ["intake_staff"];
    const handler = vi.fn(async () => "secret");
    const outcome = await runTenantHandler(tx, T, "POST /api/x", { right: "trust.record" }, handler);
    expect(outcome).toEqual({ denied: true });
    expect(handler).not.toHaveBeenCalled();
    const res = outcomeResponse(outcome);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual(FORBIDDEN_BODY);
    expect(JSON.stringify(body)).not.toMatch(/trust|role_lacks_right|intake/);
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ action: "access.denied", engine: "core", payload: { right: "trust.record", reason: "role_lacks_right", attempted: "POST /api/x" } });
  });

  it("runs the handler with the resolved actor when allowed", async () => {
    roles = ["bookkeeper"];
    const outcome = await runTenantHandler(tx, T, "POST /api/x", { right: "trust.record" }, async (ctx) => ctx.policy?.roles);
    expect(outcome).toEqual({ denied: false, value: ["bookkeeper"] });
    expect(audited).toHaveLength(0);
  });

  it("denies an unknown right (fail closed) and leaves routes without a right untouched", async () => {
    roles = ["owner"];
    expect(await runTenantHandler(tx, T, "x", { right: "trust.post" }, async () => 1)).toEqual({ denied: true });
    expect(await runTenantHandler(tx, T, "x", {}, async () => 1)).toEqual({ denied: false, value: 1 });
  });

  it("checks against a matter resource (screens beat every role)", async () => {
    roles = ["owner"];
    const resource = { type: "matter" as const, matterId: "m1", screenedUserIds: ["00000000-0000-4000-8000-000000000001"] };
    expect(await runTenantHandler(tx, T, "x", { right: "matters.view", resource }, async () => 1)).toEqual({ denied: true });
    expect(audited[0]).toMatchObject({ matterId: "m1", payload: { reason: "screened" } });
  });
});
