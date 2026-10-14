import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApprovalStateForTests, setApprovals } from "@/compliance/approvals";
import { VENDOR_GATES } from "@/compliance/gates";
import {
  TimeEntryError,
  approveTimeEntry,
  buildAiSuggestedEntry,
  computeAmountCents,
  draftManualEntry,
  markTimeEntryBilled,
  roundUpToIncrement,
  writeOffTimeEntry,
  type ScreenCheck,
} from "./timeEntries";

const notScreened: ScreenCheck = { isMatterScreenedForUser: () => false };
const screened: ScreenCheck = { isMatterScreenedForUser: () => true };

describe("roundUpToIncrement", () => {
  it("rounds up to the nearest increment", () => {
    expect(roundUpToIncrement(1, 6)).toBe(6);
    expect(roundUpToIncrement(6, 6)).toBe(6);
    expect(roundUpToIncrement(7, 6)).toBe(12);
    expect(roundUpToIncrement(0, 6)).toBe(0);
  });

  it("rejects a negative duration", () => {
    expect(() => roundUpToIncrement(-1, 6)).toThrow(TimeEntryError);
  });

  it("rejects a non-positive increment", () => {
    expect(() => roundUpToIncrement(10, 0)).toThrow(TimeEntryError);
  });
});

describe("computeAmountCents", () => {
  it("computes exact cents for a round number of minutes", () => {
    // 60 minutes at $300/hr => $300.00 => 30000 cents
    expect(computeAmountCents(60, 30_000n)).toBe(30_000n);
  });

  it("rounds half up for fractional cents", () => {
    // 6 minutes at $301/hr: 6/60 * 30100 = 3010 cents exactly
    expect(computeAmountCents(6, 30_100n)).toBe(3_010n);
    // 1 minute at $301/hr: 30100/60 = 501.666... -> rounds up to 502
    expect(computeAmountCents(1, 30_100n)).toBe(502n);
  });

  it("rejects a negative rate", () => {
    expect(() => computeAmountCents(60, -1n)).toThrow(TimeEntryError);
  });

  it("rejects a non-integer duration", () => {
    expect(() => computeAmountCents(1.5, 30_000n)).toThrow(TimeEntryError);
  });
});

describe("draftManualEntry", () => {
  it("rounds and prices a manual entry with the default increment", () => {
    const { billedMinutes, amountCents } = draftManualEntry({
      matterId: "m1",
      userId: "u1",
      activityCode: "drafting",
      billable: true,
      durationMinutes: 4,
      description: "drafted demand letter",
      rateCentsPerHour: 30_000n,
    });
    expect(billedMinutes).toBe(6); // rounded up to the 6-minute default increment
    expect(amountCents).toBe(3_000n);
  });
});

describe("buildAiSuggestedEntry", () => {
  beforeEach(() => resetApprovalStateForTests());
  afterEach(() => resetApprovalStateForTests());

  it("is blocked until the AI-model vendor gate is approved", () => {
    expect(() =>
      buildAiSuggestedEntry({
        tenantId: "t1",
        matterId: "m1",
        userId: "u1",
        signal: "call_logged",
        observedDurationMinutes: 10,
        description: "client call",
        rateCentsPerHour: 30_000n,
        confidence: 0.8,
      })
    ).toThrow(/pending/i);
  });

  it("always comes back as a draft, never auto-approved, once the gate is approved", () => {
    setApprovals([
      {
        gateKey: VENDOR_GATES.aiModel.key,
        reviewerKind: "vendor_dpa",
        approvedByName: "Test Vendor Reviewer",
        approvedAt: new Date(),
      },
    ]);
    const entry = buildAiSuggestedEntry({
      tenantId: "t1",
      matterId: "m1",
      userId: "u1",
      signal: "email_sent",
      observedDurationMinutes: 3,
      description: "sent email to client",
      rateCentsPerHour: 24_000n,
      confidence: 0.6,
    });
    expect(entry.status).toBe("draft");
    expect(entry.source).toBe("ai_suggested");
    expect(entry.approvedByUserId).toBeNull();
    expect(entry.billedMinutes).toBe(6);
    expect(entry.activityCode).toBe("correspondence");
  });

  it("rejects an out-of-range confidence", () => {
    setApprovals([
      {
        gateKey: VENDOR_GATES.aiModel.key,
        reviewerKind: "vendor_dpa",
        approvedByName: "Test Vendor Reviewer",
        approvedAt: new Date(),
      },
    ]);
    expect(() =>
      buildAiSuggestedEntry({
        tenantId: "t1",
        matterId: "m1",
        userId: "u1",
        signal: "call_logged",
        observedDurationMinutes: 5,
        description: "call",
        rateCentsPerHour: 30_000n,
        confidence: 1.5,
      })
    ).toThrow(TimeEntryError);
  });
});

describe("approveTimeEntry", () => {
  it("approves a draft entry when the matter is not screened", () => {
    const result = approveTimeEntry({ status: "draft", matterId: "m1", userId: "u1" }, "approver1", notScreened);
    expect(result.status).toBe("approved");
    expect(result.approvedByUserId).toBe("approver1");
  });

  it("refuses to approve time on a screened matter", () => {
    expect(() =>
      approveTimeEntry({ status: "draft", matterId: "m1", userId: "u1" }, "approver1", screened)
    ).toThrow(/screened/i);
  });

  it("refuses to approve a non-draft entry", () => {
    expect(() =>
      approveTimeEntry({ status: "approved", matterId: "m1", userId: "u1" }, "approver1", notScreened)
    ).toThrow(TimeEntryError);
  });
});

describe("markTimeEntryBilled / writeOffTimeEntry", () => {
  it("only bills an approved entry, and requires an invoice id", () => {
    expect(markTimeEntryBilled({ status: "approved" }, "inv1").status).toBe("billed");
    expect(() => markTimeEntryBilled({ status: "draft" }, "inv1")).toThrow(TimeEntryError);
    expect(() => markTimeEntryBilled({ status: "approved" }, "")).toThrow(TimeEntryError);
  });

  it("writes off a non-billed entry with a reason, and refuses a billed one", () => {
    expect(writeOffTimeEntry({ status: "approved" }, "client disputed the call").status).toBe("written_off");
    expect(() => writeOffTimeEntry({ status: "approved" }, "")).toThrow(TimeEntryError);
    expect(() => writeOffTimeEntry({ status: "billed" }, "reason")).toThrow(TimeEntryError);
  });
});
