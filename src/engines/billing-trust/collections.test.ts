import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApprovalStateForTests, setApprovals } from "@/compliance/approvals";
import { NOTIFY_COPY_GATES } from "@/compliance/gates";
import {
  CollectionsError,
  DEFAULT_REMINDER_STAGES,
  agingBucketFor,
  buildAgingReport,
  buildReminderDraft,
  daysPastDue,
  dueReminderStage,
  recommendLawyerEscalation,
} from "./collections";

describe("daysPastDue / agingBucketFor", () => {
  it("computes whole days overdue", () => {
    expect(daysPastDue("2026-09-01", "2026-09-15")).toBe(14);
    expect(daysPastDue("2026-09-15", "2026-09-15")).toBe(0);
  });

  it("buckets current, 30, 60, 90+", () => {
    expect(agingBucketFor(0)).toBe("current");
    expect(agingBucketFor(1)).toBe("30");
    expect(agingBucketFor(30)).toBe("30");
    expect(agingBucketFor(31)).toBe("60");
    expect(agingBucketFor(60)).toBe("60");
    expect(agingBucketFor(61)).toBe("90+");
    expect(agingBucketFor(400)).toBe("90+");
  });

  it("rejects negative days", () => {
    expect(() => agingBucketFor(-1)).toThrow(CollectionsError);
  });
});

describe("buildAgingReport", () => {
  it("groups open invoices by bucket, client, matter and lawyer, and excludes fully-paid ones", () => {
    const report = buildAgingReport(
      [
        { invoiceId: "i1", matterId: "m1", clientId: "c1", lawyerId: "l1", amountDueCents: 10_000n, dueDate: "2026-10-01" },
        { invoiceId: "i2", matterId: "m1", clientId: "c1", lawyerId: "l1", amountDueCents: 5_000n, dueDate: "2026-09-01" },
        { invoiceId: "i3", matterId: "m2", clientId: "c2", lawyerId: "l2", amountDueCents: 0n, dueDate: "2026-08-01" },
      ],
      "2026-10-14"
    );
    expect(report.totalCents).toBe(15_000n);
    expect(report.byClient.get("c1")).toBe(15_000n);
    expect(report.byClient.has("c2")).toBe(false); // the zero-balance invoice contributes nothing
    const bucket60 = report.rows.find((r) => r.bucket === "60");
    expect(bucket60?.invoiceCount).toBe(1); // i2 is 43 days overdue as of 2026-10-14
    expect(bucket60?.totalCents).toBe(5_000n);
  });
});

describe("reminder stages", () => {
  it("returns the latest stage that is due and not yet sent", () => {
    expect(dueReminderStage(5)).toBeNull(); // before the first 7-day stage
    expect(dueReminderStage(7)).toBe(0);
    expect(dueReminderStage(25)).toBe(1);
    expect(dueReminderStage(25, DEFAULT_REMINDER_STAGES, [1])).toBe(0); // stage 1 already sent
  });

  it("recommends escalation to the lawyer past the last configured stage", () => {
    const lastStageDays = DEFAULT_REMINDER_STAGES[DEFAULT_REMINDER_STAGES.length - 1]!.afterDays;
    expect(recommendLawyerEscalation(lastStageDays)).toBe(false);
    expect(recommendLawyerEscalation(lastStageDays + 1)).toBe(true);
  });
});

describe("buildReminderDraft", () => {
  beforeEach(() => resetApprovalStateForTests());
  afterEach(() => resetApprovalStateForTests());

  it("shows a visible placeholder until the attorney-reviewed wording is approved", () => {
    const draft = buildReminderDraft({ firmName: "Test Firm", portalUrl: "https://example.test/portal" });
    expect(draft.approved).toBe(false);
    expect(draft.text).toMatch(/PENDING ATTORNEY REVIEW/);
    expect(draft.gateKey).toBe(NOTIFY_COPY_GATES.reminder.key);
  });

  it("returns the approved, neutral wording once reviewed", () => {
    setApprovals([
      {
        gateKey: NOTIFY_COPY_GATES.reminder.key,
        reviewerKind: "attorney",
        approvedByName: "Test Attorney Reviewer",
        approvedAt: new Date(),
        draftHash: NOTIFY_COPY_GATES.reminder.draftHash,
      },
    ]);
    const draft = buildReminderDraft({ firmName: "Test Firm", portalUrl: "https://example.test/portal" });
    expect(draft.approved).toBe(true);
    expect(draft.text).toContain("Test Firm");
    expect(draft.text).not.toMatch(/overdue|collections|threat/i); // neutral, per the gate's own description
  });
});
