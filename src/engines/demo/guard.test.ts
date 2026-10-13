import { describe, expect, it } from "vitest";
import { evaluateDemoGuard, type DemoFlagRow, type FirmFacts } from "./guard";
import { sessionKind } from "./status";
import { demoResetEnabled } from "./reset";

const T = "11111111-1111-4111-8111-111111111111";
const firm = (over: Partial<FirmFacts> = {}): FirmFacts => ({ id: T, slug: "demo-11111111-g1", isProduction: false, status: "active", ...over });
const flag = (over: Partial<DemoFlagRow> = {}): DemoFlagRow => ({
  tenantId: T,
  status: "active",
  generation: 1,
  label: "DEMO firm",
  seedVersion: "x",
  createdAt: new Date(),
  seededAt: new Date(),
  retiredAt: null,
  replacedByTenantId: null,
  seedReport: {},
  ...over,
});

describe("evaluateDemoGuard — the hard refusal", () => {
  it("allows only a flagged, non-production demo firm", () => {
    expect(evaluateDemoGuard({ tenantId: T, firm: firm(), flag: flag() })).toEqual({ ok: true });
  });

  it("refuses a firm without the demo flag, whatever its name or slug says", () => {
    // Name is not even an input; a demo-looking slug alone is not enough.
    expect(evaluateDemoGuard({ tenantId: T, firm: firm({ slug: "demo-looks-like-one" }), flag: null })).toMatchObject({ ok: false, code: "not_flagged" });
  });

  it("refuses production firms even if flagged", () => {
    expect(evaluateDemoGuard({ tenantId: T, firm: firm({ isProduction: true }), flag: flag() })).toMatchObject({ ok: false, code: "production_firm" });
  });

  it("refuses a flag that belongs to another firm, a missing firm and an empty id", () => {
    expect(evaluateDemoGuard({ tenantId: T, firm: firm(), flag: flag({ tenantId: "22222222-2222-4222-8222-222222222222" }) })).toMatchObject({ code: "flag_mismatch" });
    expect(evaluateDemoGuard({ tenantId: T, firm: null, flag: flag() })).toMatchObject({ code: "firm_missing" });
    expect(evaluateDemoGuard({ tenantId: "", firm: firm(), flag: flag() })).toMatchObject({ code: "no_tenant" });
  });

  it("refuses a flagged firm whose slug is not a demo slug (consistency check can only refuse)", () => {
    expect(evaluateDemoGuard({ tenantId: T, firm: firm({ slug: "acme-law" }), flag: flag() })).toMatchObject({ ok: false, code: "slug_mismatch" });
  });

  it("refuses a retired demo firm unless explicitly allowed (a reset may be pressed from it)", () => {
    expect(evaluateDemoGuard({ tenantId: T, firm: firm(), flag: flag({ status: "retired" }) })).toMatchObject({ code: "retired" });
    expect(evaluateDemoGuard({ tenantId: T, firm: firm(), flag: flag({ status: "retired" }), allowRetired: true })).toEqual({ ok: true });
  });
});

describe("demo switches", () => {
  it("the HTTP/CLI reset is off unless DEMO_RESET_ENABLED=1", () => {
    expect(demoResetEnabled({})).toBe(false);
    expect(demoResetEnabled({ DEMO_RESET_ENABLED: "true" })).toBe(false);
    expect(demoResetEnabled({ DEMO_RESET_ENABLED: "1" })).toBe(true);
  });

  it("classifies the presenter's session firm", () => {
    expect(sessionKind(T, null, T)).toBe("not_demo");
    expect(sessionKind(T, { status: "active" }, T)).toBe("current_demo");
    expect(sessionKind(T, { status: "retired" }, "x")).toBe("retired_demo");
    expect(sessionKind(T, { status: "active" }, null)).toBe("retired_demo");
  });
});
