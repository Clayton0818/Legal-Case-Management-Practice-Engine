import { describe, expect, it } from "vitest";
import { defineGate, PendingApprovalError, gateStatus, resetApprovalStateForTests, setApprovals } from "@/compliance/approvals";
import { classifyStepError, summarizeReport } from "./runner";
import { addDays, atLocalHour, isoDate, monthBounds, previousMonth } from "./time";

defineGate({ key: "rules.demo.test_gate", cardIds: ["c106"], reviewers: ["attorney"], description: "Demo runner test gate" });

describe("seed runner outcomes", () => {
  it("a pending gate is 'blocked' with its visible placeholder; anything else is 'failed'", () => {
    resetApprovalStateForTests();
    setApprovals([]);
    const err = new PendingApprovalError(gateStatus("rules.demo.test_gate"), "demo.test");
    expect(classifyStepError(err)).toEqual({ status: "blocked", detail: err.placeholder, gate: "rules.demo.test_gate" });
    expect(err.placeholder).toMatch(/PENDING ATTORNEY REVIEW/);
    expect(classifyStepError(new Error("boom"))).toEqual({ status: "failed", detail: "boom", gate: null });
    expect(classifyStepError("x".repeat(900)).detail).toHaveLength(500);
    resetApprovalStateForTests();
  });

  it("summarises a report", () => {
    expect(
      summarizeReport({
        steps: [
          { key: "a", area: "x", status: "ok", detail: null, gate: null },
          { key: "b", area: "x", status: "blocked", detail: "[PENDING]", gate: "g" },
          { key: "c", area: "x", status: "ok", detail: null, gate: null },
        ],
      })
    ).toEqual({ ok: 2, blocked: 1, failed: 0 });
  });
});

describe("demo date helpers", () => {
  it("previous month and its bounds", () => {
    expect(previousMonth(new Date("2026-10-08T12:00:00Z"))).toBe("2026-09");
    expect(previousMonth(new Date("2026-01-15T12:00:00Z"))).toBe("2025-12");
    expect(monthBounds("2026-02")).toEqual({ start: "2026-02-01", end: "2026-02-28" });
    expect(monthBounds("2028-02")).toEqual({ start: "2028-02-01", end: "2028-02-29" });
  });

  it("court dates land on weekdays at the local hour", () => {
    // Saturday 2026-10-10 → Monday 2026-10-12, 09:00 Chicago (CDT, UTC-5).
    expect(atLocalHour(new Date("2026-10-10T18:00:00Z"), 9, "America/Chicago").toISOString()).toBe("2026-10-12T14:00:00.000Z");
    // A weekday stays put.
    expect(atLocalHour(new Date("2026-10-08T18:00:00Z"), 14, "America/Chicago").toISOString()).toBe("2026-10-08T19:00:00.000Z");
    expect(isoDate(addDays(new Date("2026-10-08T00:00:00Z"), 25))).toBe("2026-11-02");
  });
});
