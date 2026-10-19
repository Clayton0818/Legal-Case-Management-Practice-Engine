import { describe, expect, it } from "vitest";
import { validateContact, validateInvoice, validateMatter, validateTimeEntry, validateTrustBalance } from "./validate";

const NOW = new Date("2026-10-19T00:00:00.000Z");

describe("validateContact", () => {
  it("passes a contact with a valid email", () => {
    expect(validateContact(2, { fullName: "Ana", email: "ana@example.com" })).toEqual([]);
  });
  it("warns on an implausible email", () => {
    expect(validateContact(2, { fullName: "Ana", email: "not-an-email" })[0]?.code).toBe("implausible_email");
  });
  it("warns when there's no contact method at all", () => {
    expect(validateContact(2, { fullName: "Ana" })[0]?.code).toBe("no_contact_method");
  });
});

describe("validateMatter", () => {
  it("errors on a future open date", () => {
    const issues = validateMatter(2, { matterName: "X", openedAt: new Date("2027-01-01") }, NOW);
    expect(issues[0]).toMatchObject({ code: "future_open_date", severity: "error" });
  });
  it("passes a sensible open date", () => {
    expect(validateMatter(2, { matterName: "X", openedAt: new Date("2025-01-01") }, NOW)).toEqual([]);
  });
});

describe("validateTimeEntry", () => {
  it("errors on negative hours", () => {
    expect(validateTimeEntry(2, { hours: -1 }, NOW)[0]).toMatchObject({ code: "negative_hours", severity: "error" });
  });
  it("warns on an implausibly large single entry", () => {
    expect(validateTimeEntry(2, { hours: 30 }, NOW)[0]).toMatchObject({ code: "implausible_hours", severity: "warning" });
  });
  it("errors on a future-dated entry", () => {
    expect(validateTimeEntry(2, { hours: 1, date: new Date("2027-01-01") }, NOW)[0]).toMatchObject({ code: "future_date" });
  });
  it("passes a normal entry", () => {
    expect(validateTimeEntry(2, { hours: 2.5, date: new Date("2026-01-01") }, NOW)).toEqual([]);
  });
});

describe("validateInvoice", () => {
  it("errors on a negative total", () => {
    expect(validateInvoice(2, { totalCents: -100 })[0]).toMatchObject({ code: "negative_total", severity: "error" });
  });
  it("passes a normal invoice", () => {
    expect(validateInvoice(2, { totalCents: 50000 })).toEqual([]);
  });
});

describe("validateTrustBalance", () => {
  it("errors on a negative balance — this is the one that can never be waved through", () => {
    const issues = validateTrustBalance(2, { balanceCents: -100, asOfDate: new Date("2026-01-01") }, NOW);
    expect(issues[0]).toMatchObject({ code: "negative_trust_balance", severity: "error" });
  });
  it("errors on a future-dated balance", () => {
    const issues = validateTrustBalance(2, { balanceCents: 100, asOfDate: new Date("2027-01-01") }, NOW);
    expect(issues[0]).toMatchObject({ code: "future_as_of_date", severity: "error" });
  });
  it("passes a clean balance", () => {
    expect(validateTrustBalance(2, { balanceCents: 450000, asOfDate: new Date("2026-10-01") }, NOW)).toEqual([]);
  });
});
