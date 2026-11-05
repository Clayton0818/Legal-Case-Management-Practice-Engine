import { describe, expect, it } from "vitest";
import { aggregateByPracticeArea, aggregateByStage, BLOCKED_METRICS, MATTER_STAGE_VALUES, type MatterStage } from "./queries";

describe("aggregateByStage", () => {
  it("includes every stage at zero when a firm has no matters", () => {
    const result = aggregateByStage([]);
    expect(result).toHaveLength(MATTER_STAGE_VALUES.length);
    expect(result.every((r) => r.count === 0)).toBe(true);
    expect(result.map((r) => r.stage)).toEqual(MATTER_STAGE_VALUES);
  });

  it("counts matters per stage and still includes stages with zero matters", () => {
    const rows: { stage: MatterStage }[] = [{ stage: "retained" }, { stage: "retained" }, { stage: "prospective" }];
    const result = aggregateByStage(rows);
    const byStage = Object.fromEntries(result.map((r) => [r.stage, r.count]));
    expect(byStage.retained).toBe(2);
    expect(byStage.prospective).toBe(1);
    expect(byStage.closed).toBe(0);
  });
});

describe("aggregateByPracticeArea", () => {
  it("groups a null practice area under 'unspecified'", () => {
    const result = aggregateByPracticeArea([{ practiceArea: null }, { practiceArea: "family" }]);
    expect(result).toContainEqual({ practiceArea: "unspecified", count: 1 });
    expect(result).toContainEqual({ practiceArea: "family", count: 1 });
  });

  it("sorts by count descending, then alphabetically for ties", () => {
    const result = aggregateByPracticeArea([
      { practiceArea: "family" },
      { practiceArea: "immigration" },
      { practiceArea: "immigration" },
      { practiceArea: "personal_injury" },
    ]);
    expect(result).toEqual([
      { practiceArea: "immigration", count: 2 },
      { practiceArea: "family", count: 1 },
      { practiceArea: "personal_injury", count: 1 },
    ]);
  });

  it("returns an empty array for no matters", () => {
    expect(aggregateByPracticeArea([])).toEqual([]);
  });
});

describe("BLOCKED_METRICS", () => {
  it("names every metric c101 asks for that this v1 does not compute, with a reason", () => {
    const names = BLOCKED_METRICS.map((m) => m.metric);
    expect(names).toEqual(
      expect.arrayContaining(["billable_hours_and_realization", "unpaid_invoices", "trust_balances", "lead_conversion", "matter_health"])
    );
    for (const m of BLOCKED_METRICS) {
      expect(m.reason.length).toBeGreaterThan(0);
    }
  });
});
