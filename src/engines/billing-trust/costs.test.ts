import { describe, expect, it } from "vitest";
import {
  CostError,
  applyMarkup,
  approveCost,
  computeMileageCents,
  markCostBilled,
  validateCostInput,
  writeOffCost,
  type CostInput,
} from "./costs";

describe("computeMileageCents", () => {
  it("computes mileage cost at a given per-mile rate", () => {
    expect(computeMileageCents(100, 67n)).toBe(6_700n); // 100 miles * $0.67
  });

  it("rounds half up for fractional miles", () => {
    expect(computeMileageCents(12.5, 67n)).toBe(838n); // 12.5 * 67 = 837.5 -> 838
  });

  it("rejects negative miles", () => {
    expect(() => computeMileageCents(-1, 67n)).toThrow(CostError);
  });
});

describe("applyMarkup", () => {
  it("returns the base amount with no markup", () => {
    expect(applyMarkup(10_000n, null)).toBe(10_000n);
    expect(applyMarkup(10_000n, 0)).toBe(10_000n);
  });

  it("applies a percentage markup", () => {
    expect(applyMarkup(10_000n, 10)).toBe(11_000n); // +10%
  });

  it("rejects an out-of-range markup", () => {
    expect(() => applyMarkup(10_000n, -5)).toThrow(CostError);
    expect(() => applyMarkup(10_000n, 1000)).toThrow(CostError);
  });
});

describe("validateCostInput", () => {
  const base: CostInput = {
    matterId: "m1",
    category: "filing_fee",
    description: "District court filing fee",
    amountCents: 25_000n,
    incurredOn: "2026-10-01",
    billable: true,
    paidBy: "firm",
  };

  it("accepts a well-formed cost", () => {
    expect(() => validateCostInput(base)).not.toThrow();
  });

  it("rejects a malformed date", () => {
    expect(() => validateCostInput({ ...base, incurredOn: "10/01/2026" })).toThrow(CostError);
  });

  it("rejects an empty description", () => {
    expect(() => validateCostInput({ ...base, description: "  " })).toThrow(CostError);
  });

  it("rejects a non-positive amount", () => {
    expect(() => validateCostInput({ ...base, amountCents: 0n })).toThrow();
  });
});

describe("approveCost / markCostBilled / writeOffCost", () => {
  it("moves a pending cost through approval and billing", () => {
    expect(approveCost({ status: "pending" }, "approver1").status).toBe("approved");
    expect(() => approveCost({ status: "approved" }, "approver1")).toThrow(CostError);
    expect(markCostBilled({ status: "approved" }, "inv1").status).toBe("billed");
    expect(() => markCostBilled({ status: "pending" }, "inv1")).toThrow(CostError);
  });

  it("writes off a non-billed cost with a reason", () => {
    expect(writeOffCost({ status: "approved" }, "client disputes the fee").status).toBe("written_off");
    expect(() => writeOffCost({ status: "approved" }, "")).toThrow(CostError);
    expect(() => writeOffCost({ status: "billed" }, "reason")).toThrow(CostError);
  });
});
