import { describe, expect, it } from "vitest";
import {
  aggregateConsultFeeValue,
  aggregateLostLeadReasons,
  buildAttributionFunnelReport,
  buildLeadFunnelRow,
  buildLeadFunnelRows,
  computeFunnelCounts,
  computeOverallConversionRate,
  computeStepConversionRates,
  computeTimeToRetainStats,
  deriveLostReason,
  groupLeadFunnelRows,
  type LeadFunnelRow,
  type SessionFunnelInput,
} from "./funnel";

const DAY = 86_400_000;
const BASE = new Date("2026-01-01T00:00:00Z");

function baseInput(overrides: Partial<SessionFunnelInput> = {}): SessionFunnelInput {
  return {
    intakeSessionId: "s1",
    startedAt: BASE,
    sessionStatus: "active",
    matterId: null,
    matterStage: null,
    practiceArea: null,
    matterAssignedUserId: null,
    firstHumanContactByUserId: null,
    attribution: null,
    fitEvaluations: [],
    consultations: [],
    retainedAt: null,
    followUpStoppedReason: null,
    ...overrides,
  };
}

describe("deriveLostReason", () => {
  const base = {
    retainedAt: null as Date | null,
    matterStage: null as string | null,
    latestFitOutcome: null as string | null,
    latestFitReasons: [] as readonly string[],
    mostRecentDeclinedConsultOutcome: null as string | null,
    mostRecentConsultStatus: null as string | null,
    mostRecentConsultCancelReason: null as string | null,
    followUpStoppedReason: null as string | null,
    sessionStatus: "active",
  };

  it("is null once a lead has retained, regardless of anything else", () => {
    expect(deriveLostReason({ ...base, retainedAt: BASE, matterStage: "did_not_schedule" })).toBeNull();
  });

  it("is null for a lead that is still active and unresolved", () => {
    expect(deriveLostReason(base)).toBeNull();
  });

  it("trusts the matter's own stage first", () => {
    expect(deriveLostReason({ ...base, matterStage: "declined_conflict", latestFitOutcome: "fit" })).toBe("declined_conflict");
    expect(deriveLostReason({ ...base, matterStage: "did_not_hire_referred_out" })).toBe("did_not_hire_referred_out");
    expect(deriveLostReason({ ...base, matterStage: "closed" })).toBe("closed_without_retaining");
  });

  it("falls back to the fit evaluation's reasons when there is no matter-stage signal", () => {
    expect(deriveLostReason({ ...base, latestFitOutcome: "no_fit", latestFitReasons: ["out_of_state", "practice_area_not_offered"] })).toBe(
      "no_fit: out_of_state; practice_area_not_offered"
    );
    expect(deriveLostReason({ ...base, latestFitOutcome: "no_fit" })).toBe("no_fit");
  });

  it("falls back to a declined/cancelled consultation", () => {
    expect(deriveLostReason({ ...base, mostRecentDeclinedConsultOutcome: "client_declined" })).toBe("client_declined");
    expect(deriveLostReason({ ...base, mostRecentConsultStatus: "no_show" })).toBe("consult_no_show");
    expect(deriveLostReason({ ...base, mostRecentConsultStatus: "cancelled", mostRecentConsultCancelReason: "found another firm" })).toBe(
      "consult_cancelled: found another firm"
    );
    expect(deriveLostReason({ ...base, mostRecentConsultStatus: "cancelled" })).toBe("consult_cancelled");
  });

  it("falls back to the follow-up stop reason, then the session status", () => {
    expect(deriveLostReason({ ...base, followUpStoppedReason: "stopped replying" })).toBe("stopped replying");
    expect(deriveLostReason({ ...base, sessionStatus: "not_an_inquiry" })).toBe("not_an_inquiry");
    expect(deriveLostReason({ ...base, sessionStatus: "closed" })).toBe("session_closed");
  });
});

describe("buildLeadFunnelRow", () => {
  it("an inquiry with nothing else reaches only the inquiry stage", () => {
    const row = buildLeadFunnelRow(baseInput());
    expect(row.source).toBe("unknown");
    expect(row.practiceArea).toBe("unspecified");
    expect(row.qualifiedAt).toBeNull();
    expect(row.consultBookedAt).toBeNull();
    expect(row.consultHeldAt).toBeNull();
    expect(row.retainedAt).toBeNull();
    expect(row.lostReason).toBeNull();
  });

  it("ignores a slot-hold that never became a real booking", () => {
    const row = buildLeadFunnelRow(
      baseInput({
        consultations: [
          { createdAt: new Date(BASE.getTime() + DAY), startsAt: new Date(BASE.getTime() + 2 * DAY), status: "held", outcome: null, cancelReason: null, lawyerUserId: "lawyer-1", feeCents: null },
        ],
      })
    );
    expect(row.consultBookedAt).toBeNull();
    expect(row.staffUserId).toBeNull();
  });

  it("a booked-then-completed consultation reaches booked and held, and credits the lawyer who ran it", () => {
    const bookedAt = new Date(BASE.getTime() + DAY);
    const heldAt = new Date(BASE.getTime() + 3 * DAY);
    const row = buildLeadFunnelRow(
      baseInput({
        consultations: [
          { createdAt: bookedAt, startsAt: heldAt, status: "completed", outcome: "retain_offered", cancelReason: null, lawyerUserId: "lawyer-1", feeCents: 15_000 },
        ],
      })
    );
    expect(row.consultBookedAt).toEqual(bookedAt);
    expect(row.consultHeldAt).toEqual(heldAt);
    expect(row.staffUserId).toBe("lawyer-1");
    expect(row.consultFeeCents).toBe(15_000);
  });

  it("a matter opening sets retainedAt and clears any lost reason", () => {
    const row = buildLeadFunnelRow(baseInput({ matterId: "m1", matterStage: "retained", retainedAt: new Date(BASE.getTime() + 10 * DAY) }));
    expect(row.retainedAt).not.toBeNull();
    expect(row.lostReason).toBeNull();
  });

  it("buildLeadFunnelRows maps every input", () => {
    expect(buildLeadFunnelRows([baseInput({ intakeSessionId: "a" }), baseInput({ intakeSessionId: "b" })])).toHaveLength(2);
  });
});

function row(overrides: Partial<LeadFunnelRow> = {}): LeadFunnelRow {
  return {
    intakeSessionId: "s",
    source: "website",
    practiceArea: "family_law",
    staffUserId: null,
    inquiryAt: BASE,
    qualifiedAt: null,
    consultBookedAt: null,
    consultHeldAt: null,
    retainedAt: null,
    lostReason: null,
    consultFeeCents: null,
    ...overrides,
  };
}

describe("computeFunnelCounts / conversion rates", () => {
  const rows: LeadFunnelRow[] = [
    row({ qualifiedAt: BASE, consultBookedAt: BASE, consultHeldAt: BASE, retainedAt: BASE }),
    row({ qualifiedAt: BASE, consultBookedAt: BASE }),
    row({ qualifiedAt: BASE }),
    row(),
  ];

  it("counts leads that reached each stage", () => {
    expect(computeFunnelCounts(rows)).toEqual({ inquiry: 4, qualified: 3, consult_booked: 2, consult_held: 1, retained: 1 });
  });

  it("computes a step rate as to/from, and 0 when the from-count is 0", () => {
    const rates = computeStepConversionRates({ inquiry: 4, qualified: 3, consult_booked: 2, consult_held: 1, retained: 1 });
    expect(rates).toEqual([
      { from: "inquiry", to: "qualified", rate: 0.75 },
      { from: "qualified", to: "consult_booked", rate: 2 / 3 },
      { from: "consult_booked", to: "consult_held", rate: 0.5 },
      { from: "consult_held", to: "retained", rate: 1 },
    ]);
    expect(computeStepConversionRates({ inquiry: 0, qualified: 0, consult_booked: 0, consult_held: 0, retained: 0 })[0]?.rate).toBe(0);
  });

  it("computes the overall inquiry-to-retained rate", () => {
    expect(computeOverallConversionRate(computeFunnelCounts(rows))).toBe(0.25);
    expect(computeOverallConversionRate({ inquiry: 0, qualified: 0, consult_booked: 0, consult_held: 0, retained: 0 })).toBe(0);
  });
});

describe("computeTimeToRetainStats", () => {
  it("is empty when nobody has retained", () => {
    expect(computeTimeToRetainStats([row()])).toEqual({ count: 0, averageDays: null, medianDays: null });
  });

  it("computes average and median days from inquiry to retained", () => {
    const rows: LeadFunnelRow[] = [
      row({ inquiryAt: BASE, retainedAt: new Date(BASE.getTime() + 2 * DAY) }),
      row({ inquiryAt: BASE, retainedAt: new Date(BASE.getTime() + 4 * DAY) }),
      row({ inquiryAt: BASE, retainedAt: new Date(BASE.getTime() + 9 * DAY) }),
    ];
    const stats = computeTimeToRetainStats(rows);
    expect(stats.count).toBe(3);
    expect(stats.averageDays).toBeCloseTo(5);
    expect(stats.medianDays).toBe(4);
  });

  it("excludes a retainedAt that is somehow before the inquiry (bad data, not a negative duration)", () => {
    const rows: LeadFunnelRow[] = [row({ inquiryAt: BASE, retainedAt: new Date(BASE.getTime() - DAY) })];
    expect(computeTimeToRetainStats(rows)).toEqual({ count: 0, averageDays: null, medianDays: null });
  });
});

describe("aggregateLostLeadReasons", () => {
  it("counts and sorts by frequency, then alphabetically", () => {
    const rows: LeadFunnelRow[] = [
      row({ lostReason: "no_fit" }),
      row({ lostReason: "no_fit" }),
      row({ lostReason: "declined_conflict" }),
      row({ retainedAt: BASE }),
    ];
    expect(aggregateLostLeadReasons(rows)).toEqual([
      { reason: "no_fit", count: 2 },
      { reason: "declined_conflict", count: 1 },
    ]);
  });
});

describe("aggregateConsultFeeValue", () => {
  it("only counts rows with a recorded fee", () => {
    const rows: LeadFunnelRow[] = [row({ consultFeeCents: 10_000 }), row({ consultFeeCents: 20_000 }), row()];
    expect(aggregateConsultFeeValue(rows)).toEqual({ count: 2, totalCents: 30_000, averageCents: 15_000 });
  });

  it("is zeroed, not divided by zero, when nobody has a recorded fee", () => {
    expect(aggregateConsultFeeValue([row()])).toEqual({ count: 0, totalCents: 0, averageCents: null });
  });
});

describe("groupLeadFunnelRows / buildAttributionFunnelReport", () => {
  const rows: LeadFunnelRow[] = [
    row({ source: "google_ads", practiceArea: "family_law", staffUserId: "u1", retainedAt: BASE }),
    row({ source: "google_ads", practiceArea: "family_law", staffUserId: "u1" }),
    row({ source: "referral", practiceArea: "estate_planning", staffUserId: null }),
  ];

  it("orders groups by inquiry volume, then key", () => {
    const buckets = groupLeadFunnelRows(rows, (r) => r.source);
    expect(buckets.map((b) => b.key)).toEqual(["google_ads", "referral"]);
    expect(buckets[0]?.counts.inquiry).toBe(2);
    expect(buckets[0]?.counts.retained).toBe(1);
  });

  it("buckets a lead with no known staff member under 'unassigned'", () => {
    const buckets = groupLeadFunnelRows(rows, (r) => r.staffUserId ?? "unassigned");
    expect(buckets.map((b) => b.key)).toEqual(["u1", "unassigned"]);
  });

  it("builds the full report shape", () => {
    const report = buildAttributionFunnelReport(rows);
    expect(report.overall.counts.inquiry).toBe(3);
    expect(report.bySource.map((b) => b.key)).toEqual(["google_ads", "referral"]);
    expect(report.byPracticeArea.map((b) => b.key).sort()).toEqual(["estate_planning", "family_law"]);
    expect(report.byStaff.map((b) => b.key).sort()).toEqual(["u1", "unassigned"]);
  });
});
