import { describe, expect, it } from "vitest";
import { deriveStaffSteps, NEW_INTAKE_CHANNELS, parseOtherPartyNames, pickStaffCaseDetails, validateNewIntake, type StaffIntakeFacts } from "./steps";
import { STAFF_ENTERED_CHANNELS } from "../channels/records";

const base: StaffIntakeFacts = {
  status: "active",
  disclosuresAcknowledgedAt: null,
  conflictMinimum: {},
  conflictCheckRequestedAt: null,
  conflictState: "none",
  caseDetailsRecorded: false,
};
const at = new Date("2026-11-19T15:00:00Z");

function statuses(f: StaffIntakeFacts) {
  return Object.fromEntries(deriveStaffSteps(f).map((s) => [s.step, s.status]));
}

describe("c122 new-intake form", () => {
  it("offers only staff-entered channels, and never the recorded phone line", () => {
    for (const c of NEW_INTAKE_CHANNELS) expect(STAFF_ENTERED_CHANNELS).toContain(c);
    expect(NEW_INTAKE_CHANNELS).not.toContain("phone_staff");
  });

  it("accepts a name plus a phone or email, and normalises them", () => {
    const r = validateNewIntake({ channel: "walk_in", name: "  Maria   Example ", phone: "(512) 555-0142", email: " Maria@Example.com " });
    expect(r).toEqual({ ok: true, value: { channel: "walk_in", name: "Maria Example", phone: "+15125550142", email: "maria@example.com", language: "en" } });
  });

  it("keeps Spanish when chosen, and defaults anything else to English", () => {
    const es = validateNewIntake({ channel: "phone_manual", name: "Ana", phone: "5125550100", language: "es" });
    const other = validateNewIntake({ channel: "phone_manual", name: "Ana", phone: "5125550100", language: "fr" });
    expect(es.ok && es.value.language).toBe("es");
    expect(other.ok && other.value.language).toBe("en");
  });

  it("refuses a missing name, no way to reach them, a bad email or phone, and an unknown channel", () => {
    expect(validateNewIntake({ channel: "walk_in", name: " ", phone: "5125550100" }).ok).toBe(false);
    expect(validateNewIntake({ channel: "walk_in", name: "Ana" }).ok).toBe(false);
    const bad = validateNewIntake({ channel: "walk_in", name: "Ana", email: "not-an-email", phone: "12" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors).toHaveLength(2);
    expect(validateNewIntake({ channel: "sms", name: "Ana", phone: "5125550100" }).ok).toBe(false);
    expect(validateNewIntake({ channel: "phone_staff", name: "Ana", phone: "5125550100" }).ok).toBe(false);
  });
});

describe("c122 guided steps", () => {
  it("starts with the disclosures and nothing else actionable", () => {
    expect(statuses(base)).toEqual({ disclosures: "current", conflict_names: "upcoming", conflict_check: "upcoming", case_details: "upcoming" });
  });

  it("asks for the conflict-check names once the disclosures are recorded", () => {
    expect(statuses({ ...base, disclosuresAcknowledgedAt: at }).conflict_names).toBe("current");
  });

  it("waits on the conflict check after the names, with case details still closed", () => {
    const s = statuses({ ...base, disclosuresAcknowledgedAt: at, conflictMinimum: { fullName: "Ana", otherPartyNames: ["Bo"] }, conflictCheckRequestedAt: at });
    expect(s.conflict_check).toBe("waiting");
    expect(s.case_details).toBe("upcoming");
  });

  it("treats 'no other party' (an empty list) as names recorded", () => {
    const s = statuses({ ...base, disclosuresAcknowledgedAt: at, conflictMinimum: { fullName: "Ana", otherPartyNames: [] }, conflictCheckRequestedAt: at });
    expect(s.conflict_names).toBe("done");
  });

  it("holds on a possible conflict until the conflicts attorney decides", () => {
    const steps = deriveStaffSteps({ ...base, disclosuresAcknowledgedAt: at, conflictMinimum: { fullName: "Ana", otherPartyNames: [] }, conflictState: "possible_pending" });
    const check = steps.find((s) => s.step === "conflict_check");
    expect(check?.status).toBe("waiting");
    expect(check?.detail).toMatch(/conflicts attorney/);
    expect(steps.find((s) => s.step === "case_details")?.status).toBe("upcoming");
  });

  it("stops on a definite or declined conflict, with nothing actionable after it", () => {
    for (const conflictState of ["definite", "declined"] as const) {
      const s = statuses({ ...base, disclosuresAcknowledgedAt: at, conflictMinimum: { fullName: "Ana", otherPartyNames: [] }, conflictState });
      expect(s.conflict_check).toBe("blocked");
      expect(s.case_details).toBe("upcoming");
    }
  });

  it("opens case details once the check is clear or a lawyer cleared it", () => {
    for (const conflictState of ["clear", "attorney_cleared"] as const) {
      const s = statuses({ ...base, disclosuresAcknowledgedAt: at, conflictMinimum: { fullName: "Ana", otherPartyNames: [] }, conflictState });
      expect(s.conflict_check).toBe("done");
      expect(s.case_details).toBe("current");
    }
  });

  it("shows everything done once case details are in", () => {
    const steps = deriveStaffSteps({ ...base, disclosuresAcknowledgedAt: at, conflictMinimum: { fullName: "Ana", otherPartyNames: [] }, conflictState: "clear", caseDetailsRecorded: true });
    expect(steps.every((s) => s.status === "done")).toBe(true);
  });

  it("blocks the next step while the intake is paused for an emergency", () => {
    const steps = deriveStaffSteps({ ...base, status: "paused_emergency", disclosuresAcknowledgedAt: at });
    expect(steps.find((s) => s.step === "conflict_names")).toMatchObject({ status: "blocked" });
    expect(steps.filter((s) => s.status === "current")).toHaveLength(0);
  });

  it("offers nothing on a closed intake", () => {
    for (const status of ["closed", "not_an_inquiry"]) {
      expect(deriveStaffSteps({ ...base, status }).some((s) => s.status === "current")).toBe(false);
    }
  });

  it("never has more than one step holding things up or open at once", () => {
    const cases: StaffIntakeFacts[] = [
      base,
      { ...base, disclosuresAcknowledgedAt: at },
      { ...base, disclosuresAcknowledgedAt: at, conflictMinimum: { fullName: "A", otherPartyNames: [] }, conflictCheckRequestedAt: at },
      { ...base, disclosuresAcknowledgedAt: at, conflictMinimum: { fullName: "A", otherPartyNames: [] }, conflictState: "clear" },
      { ...base, status: "paused_emergency" },
    ];
    for (const f of cases) {
      expect(deriveStaffSteps(f).filter((s) => s.status !== "done" && s.status !== "upcoming").length).toBeLessThanOrEqual(1);
    }
  });
});

describe("c122 helpers", () => {
  it("splits other-party names on commas, semicolons and new lines, without duplicates", () => {
    expect(parseOtherPartyNames("Bo Smith, bo smith; Cy Jones\n\n  Dee  Lane ")).toEqual(["Bo Smith", "Cy Jones", "Dee Lane"]);
    expect(parseOtherPartyNames("  ")).toEqual([]);
  });

  it("keeps only the allowed case-detail fields, trimmed", () => {
    expect(pickStaffCaseDetails({ practiceArea: "family", county: " Travis ", practiceAreaFreeText: "Custody change", extra: "ignored" })).toEqual({
      practiceArea: "family",
      county: "Travis",
      practiceAreaFreeText: "Custody change",
    });
  });

  it("refuses an unknown practice area, non-text values and an empty submission", () => {
    expect(() => pickStaffCaseDetails({ practiceArea: "tax" })).toThrow(/practice areas/);
    expect(() => pickStaffCaseDetails({ county: 12 })).toThrow(/must be text/);
    expect(() => pickStaffCaseDetails({ practiceArea: "", county: "  " })).toThrow(/at least one/);
  });
});
