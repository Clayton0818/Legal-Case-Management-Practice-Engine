import { describe, expect, it } from "vitest";
import { canDecideJointRepresentation, checkMessageBody, deriveGroupState, MAX_MESSAGE_LENGTH } from "./rules";

const a = { partyId: "a", fullName: "Ann", isAdverse: false };
const b = { partyId: "b", fullName: "Bob", isAdverse: null };
const both = [
  { partyId: "a", withdrawnAt: null },
  { partyId: "b", withdrawnAt: null },
];

describe("deriveGroupState", () => {
  it("is open with joint representation, two clients and both consents", () => {
    const s = deriveGroupState({ jointActive: true, clients: [a, b], consents: both });
    expect(s.available).toBe(true);
    expect(s.recipients).toEqual(["a", "b"]);
    expect(s.reasons).toEqual([]);
  });

  it("is closed until a lawyer marks joint representation", () => {
    const s = deriveGroupState({ jointActive: false, clients: [a, b], consents: both });
    expect(s.available).toBe(false);
    expect(s.recipients).toEqual([]);
    expect(s.reasons[0]).toMatch(/joint representation/);
  });

  it("needs at least two clients", () => {
    const s = deriveGroupState({ jointActive: true, clients: [a], consents: both });
    expect(s.available).toBe(false);
    expect(s.reasons.join(" ")).toMatch(/two clients/);
  });

  it("is closed when any client is adverse", () => {
    const s = deriveGroupState({ jointActive: true, clients: [a, { ...b, isAdverse: true }], consents: both });
    expect(s.available).toBe(false);
    expect(s.reasons.join(" ")).toMatch(/adverse/);
  });

  it("waits for every client's consent, and a withdrawn one doesn't count", () => {
    const s = deriveGroupState({ jointActive: true, clients: [a, b], consents: [both[0]!, { partyId: "b", withdrawnAt: new Date() }] });
    expect(s.available).toBe(false);
    expect(s.awaitingConsent).toEqual(["b"]);
    expect(s.reasons.join(" ")).toMatch(/1 client\./);
  });

  it("ignores consents from people who are not current clients", () => {
    const s = deriveGroupState({ jointActive: true, clients: [a, b], consents: [both[0]!, { partyId: "opposing", withdrawnAt: null }] });
    expect(s.available).toBe(false);
    expect(s.recipients).not.toContain("opposing");
  });
});

describe("checkMessageBody", () => {
  it("trims and accepts", () => {
    expect(checkMessageBody("  hello\r\nthere  ")).toEqual({ ok: true, body: "hello\nthere" });
  });
  it("refuses empty and over-long bodies", () => {
    expect(checkMessageBody("   ").ok).toBe(false);
    expect(checkMessageBody("x".repeat(MAX_MESSAGE_LENGTH + 1)).ok).toBe(false);
  });
});

describe("canDecideJointRepresentation", () => {
  it("is a lawyer's decision", () => {
    expect(canDecideJointRepresentation(["lawyer"])).toBe(true);
    expect(canDecideJointRepresentation(["conflicts_attorney"])).toBe(true);
    expect(canDecideJointRepresentation(["paralegal", "intake_staff"])).toBe(false);
    expect(canDecideJointRepresentation(["owner"])).toBe(false);
  });
});
